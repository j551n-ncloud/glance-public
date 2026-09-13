// Semantic search over the SiYuan RAG notebook: embeds note content so
// conceptually related notes surface even without shared keywords, and
// across German/English. Two backends (see lib/config.js):
//  - local (default): a small on-device multilingual model
//    (Xenova/multilingual-e5-small) — no external API, nothing leaves the
//    server.
//  - remote (EMBEDDINGS_REMOTE_URL set): an OpenAI-compatible /embeddings
//    endpoint — note content IS sent there, a deliberate opt-in.
// Vectors live in their own SQLite file (kept separate from strava.db so the
// two concerns don't share a table namespace), queried with plain in-process
// cosine similarity — the note counts this is built for (dozens to low
// thousands) don't need an ANN index.
const {
  EMBEDDINGS_DB, EMBEDDINGS_MODEL, EMBEDDINGS_MODEL_CACHE,
  EMBEDDINGS_REMOTE_URL, EMBEDDINGS_REMOTE_API_KEY, EMBEDDINGS_REMOTE_MODEL,
  EMBEDDINGS_MIN_SCORE,
} = require('./config');
const siyuan = require('./siyuan');

let Database = null;
try { Database = require('better-sqlite3'); }
catch (e) { console.error('better-sqlite3 unavailable, semantic search disabled:', e.message); }

let _db = null;
function embeddingsDb() {
  if (_db) return _db;
  if (!Database) throw new Error('database unavailable');
  _db = new Database(EMBEDDINGS_DB);
  _db.pragma('journal_mode = WAL');
  // One row per section-chunk rather than per note (see splitIntoChunks) so
  // a long note's less-relevant sections don't dilute the vector for the
  // section that actually answers a query. `updated` is duplicated onto
  // every chunk row (it's a note-level attribute) so syncEmbeddings can
  // still decide "unchanged since last sync" per docId without a join.
  // The old (pre-chunking) single-row-per-note table is left in place
  // unused rather than dropped — it's dead weight, not a migration risk.
  _db.exec(`CREATE TABLE IF NOT EXISTS note_chunks (
    docId TEXT NOT NULL,
    chunkIndex INTEGER NOT NULL,
    title TEXT,
    heading TEXT,
    updated TEXT,
    vector BLOB NOT NULL,
    PRIMARY KEY (docId, chunkIndex)
  )`);
  return _db;
}

// The embedding pipeline is loaded once (lazily, on first use) and reused —
// loading it is the slow part (model file read + ONNX session init), a
// single embed call afterwards is fast. @huggingface/transformers is
// ESM-only; this file is CommonJS, hence the dynamic import.
let _extractorPromise = null;
function getExtractor() {
  if (!_extractorPromise) {
    _extractorPromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      // Cache downloaded model files on the persistent /data volume so a
      // container rebuild/restart doesn't re-download them from HF each time.
      env.cacheDir = EMBEDDINGS_MODEL_CACHE;
      return pipeline('feature-extraction', EMBEDDINGS_MODEL);
    })();
  }
  return _extractorPromise;
}

// e5-family models are trained with "query: " / "passage: " prefixes on
// their inputs — queries and the documents they're matched against use
// different prefixes. Omitting them measurably hurts retrieval quality for
// this model family, so every call goes through this rather than the raw
// pipeline. Text is capped well under the model's ~512-token context so a
// pathologically long note can't stall the encoder.
async function embedLocal(text, kind) {
  const extractor = await getExtractor();
  const prefixed = `${kind}: ${String(text || '').slice(0, 4000)}`;
  const output = await extractor(prefixed, { pooling: 'mean', normalize: true });
  return Float32Array.from(output.data);
}

function normalize(vec) {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

// Qwen3-Embedding models (and similar instruction-tuned embedding models)
// are documented to score noticeably better when the query side carries a
// short task instruction; the passage/document side is embedded plain, with
// no prefix. This only applies to the query kind — passages go through
// unmodified. Vectors are explicitly re-normalized here rather than trusting
// the endpoint to have already normalized them (some OpenAI-compatible
// servers don't), since dot() below assumes unit-length inputs.
const REMOTE_QUERY_INSTRUCTION = 'Instruct: Given a search query, retrieve relevant passages that answer the query\nQuery: ';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Shared gateways (this one's a Helmholtz/FZ Juelich research endpoint) rate
// limit per key; a note with several chunks used to fire all of them at
// once (see the concurrency limiter below), tripping 429s constantly. Retry
// with backoff, honoring Retry-After when the server sends one.
// A shared, loaded research cluster can also just hang mid-request rather
// than answer with 429 — undici's own default headers timeout is 5 minutes,
// far too long to wait before retrying. 30s (matching SiYuan's own native
// integration's default timeout for this same class of gateway) fails fast
// and treats the abort as retryable, same as a 429.
const REMOTE_TIMEOUT_MS = 30000;
async function embedRemote(text, kind, attempt = 0) {
  const input = kind === 'query'
    ? `${REMOTE_QUERY_INSTRUCTION}${String(text || '').slice(0, 4000)}`
    : String(text || '').slice(0, 4000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${EMBEDDINGS_REMOTE_URL.replace(/\/$/, '')}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(EMBEDDINGS_REMOTE_API_KEY ? { Authorization: `Bearer ${EMBEDDINGS_REMOTE_API_KEY}` } : {}),
      },
      body: JSON.stringify({ model: EMBEDDINGS_REMOTE_MODEL, input }),
      signal: controller.signal,
    });
  } catch (e) {
    if (attempt < 5) {
      await sleep(1000 * 2 ** attempt + Math.random() * 250);
      return embedRemote(text, kind, attempt + 1);
    }
    throw new Error(`embeddings API request failed after retries: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 429 && attempt < 5) {
    const retryAfter = parseFloat(res.headers.get('retry-after'));
    await sleep((Number.isFinite(retryAfter) ? retryAfter * 1000 : 1000 * 2 ** attempt) + Math.random() * 250);
    return embedRemote(text, kind, attempt + 1);
  }
  if (!res.ok) throw new Error(`embeddings API ${res.status}: ${await res.text().catch(() => '')}`);
  const j = await res.json();
  const vec = j.data && j.data[0] && j.data[0].embedding;
  if (!vec) throw new Error('embeddings API returned no vector');
  return normalize(Float32Array.from(vec));
}

function embed(text, kind) {
  return EMBEDDINGS_REMOTE_URL ? embedRemote(text, kind) : embedLocal(text, kind);
}

// Caps how many embed() calls run concurrently — local runs one in-process
// model so unlimited concurrency was harmless, but the remote path hits a
// shared, rate-limited gateway, so a note with many chunks must not fire
// them all in one burst. 3 is conservative enough to stay under typical
// per-key rate limits while still being faster than fully sequential.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function vecToBuffer(vec) {
  return Buffer.from(Float32Array.from(vec).buffer);
}
function bufferToVec(buf) {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}
// Vectors are normalized at embed time, so a plain dot product is already
// the cosine similarity — no need to divide by magnitudes.
function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// Splits a note's markdown into one chunk per section, where a section runs
// from one ATX heading (any level, "#".."######") up to the next heading or
// the end of the document. Each chunk keeps its own heading line, so the
// embedded text still reads like "## Heading\n\nbody" and the model gets
// that context. Any content before the first heading becomes its own
// heading-less chunk. A note with no headings at all falls back to a single
// whole-note chunk — same behavior as before chunking existed.
// Notes imported from other tools (e.g. a MediaWiki export) can carry raw
// HTML left over in an otherwise-plain heading line (a <span class="...">
// wrapper around the heading text); strip tags so the stored/displayed
// heading is plain text either way.
function stripHtmlTags(s) {
  return String(s || '').replace(/<[^>]*>/g, '').trim();
}

// embed() caps its input at 4000 chars before it ever reaches the model
// (see embedLocal/embedRemote) — a section longer than that used to just
// have its tail silently dropped, with nothing to show the note was only
// partially embedded. Keep every chunk comfortably under that cap instead:
// split an oversized section on paragraph (blank-line) boundaries, packing
// paragraphs greedily up to the limit. A single paragraph that's still too
// long on its own (a wall of text or a code block with no blank lines) has
// nowhere shorter to split within a section, so it's hard-sliced as a last
// resort — better than silent loss, even if the cut lands mid-sentence.
// Room is left under embed()'s 4000-char cap for the title + "passage: "
// prefix embed() also prepends.
const MAX_CHUNK_CHARS = 3000;

// headingPrefix is the section's heading text, which splitIntoChunks below
// prepends to every piece here except the first (that one already starts
// with the section's own heading line). Reserving its length up front means
// the prefixed result still respects MAX_CHUNK_CHARS, rather than the
// prefix pushing an already-at-the-cap piece back over it.
function splitLargeText(text, headingPrefix) {
  if (text.length <= MAX_CHUNK_CHARS) return [text];
  const budget = Math.max(1, MAX_CHUNK_CHARS - (headingPrefix ? headingPrefix.length + 2 : 0));
  const paragraphs = text.split(/\n{2,}/);
  const parts = [];
  let cur = '';
  for (const p of paragraphs) {
    const candidate = cur ? `${cur}\n\n${p}` : p;
    if (candidate.length > budget && cur) {
      parts.push(cur);
      cur = p;
    } else {
      cur = candidate;
    }
    while (cur.length > budget) {
      parts.push(cur.slice(0, budget));
      cur = cur.slice(budget);
    }
  }
  if (cur) parts.push(cur);
  return parts;
}

function splitIntoChunks(markdown) {
  const lines = String(markdown || '').split('\n');
  const chunks = [];
  let heading = null;
  let buf = [];
  const flush = () => {
    const text = buf.join('\n').trim();
    if (text) chunks.push({ heading, text });
    buf = [];
  };
  for (const line of lines) {
    const m = /^#{1,6}\s+(.*)$/.exec(line);
    if (m) {
      flush();
      heading = stripHtmlTags(m[1].trim());
    }
    buf.push(line);
  }
  flush();
  if (!chunks.length) return [{ heading: null, text: String(markdown || '') }];
  // Expand any oversized section into several same-heading chunks. Only the
  // first piece of a split section already carries the heading line itself
  // (it was part of the original text); later pieces get the heading text
  // prepended plainly so they still read with their section's context.
  return chunks.flatMap((c) => splitLargeText(c.text, c.heading).map((text, i) => ({
    heading: c.heading,
    text: i === 0 || !c.heading ? text : `${c.heading}\n\n${text}`,
  })));
}

// Re-embeds one note from its current SiYuan content: splits it into
// section chunks and replaces all of that note's chunk rows in one go.
// `titleHint` avoids a redundant attrs fetch when the caller already knows
// the title (e.g. right after create_note/update_note).
async function upsertNoteEmbedding(docId, titleHint) {
  const [{ markdown }, { attrs }] = await Promise.all([
    siyuan.getNote(docId),
    siyuan.getNoteAttrs(docId),
  ]);
  const title = titleHint || attrs.title || '(untitled)';
  const updated = attrs.updated || new Date().toISOString();
  const chunks = splitIntoChunks(markdown);
  // Local runs one in-process model (unlimited concurrency is harmless);
  // remote hits a shared, rate-limited, currently-loaded gateway, so cap it
  // low (2) rather than bursting every chunk of a note at once.
  const concurrency = EMBEDDINGS_REMOTE_URL ? 2 : chunks.length;
  const vectors = await mapWithConcurrency(chunks, concurrency, (c) => embed(`${title}\n\n${c.text}`, 'passage'));

  const db = embeddingsDb();
  const insert = db.prepare(`INSERT INTO note_chunks (docId, chunkIndex, title, heading, updated, vector)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(docId, chunkIndex) DO UPDATE SET title=excluded.title, heading=excluded.heading, updated=excluded.updated, vector=excluded.vector`);
  const del = db.prepare('DELETE FROM note_chunks WHERE docId = ? AND chunkIndex >= ?');
  const tx = db.transaction(() => {
    chunks.forEach((c, i) => insert.run(docId, i, title, c.heading, updated, vecToBuffer(vectors[i])));
    del.run(docId, chunks.length); // drop leftover rows if this note shrank to fewer chunks than before
  });
  tx();
  return { docId, title, chunks: chunks.length };
}

function removeNoteEmbedding(docId) {
  if (!Database) return;
  embeddingsDb().prepare('DELETE FROM note_chunks WHERE docId = ?').run(docId);
}

// Scores every chunk, then keeps each note's single best-scoring chunk so a
// long note doesn't crowd out the results with several of its own sections.
// minScore drops matches too weak to be a real answer rather than just the
// closest thing in an otherwise-unrelated notebook — without it, a query
// with genuinely no matching note still comes back with `limit` results,
// indistinguishable from a real (if weak) match. The default (env
// EMBEDDINGS_MIN_SCORE, 0.86) was measured against the live RAG notebook: a
// gibberish query with no real match still scores 0.83-0.85 against
// unrelated notes with this model (its embedding space is anisotropic, so
// nothing scores near 0), while a query that genuinely matches a note
// scores 0.90+. Revisit if the embedding backend/model ever changes —
// that noise floor is model-specific, not a universal constant.
async function semanticSearch(query, limit = 10, minScore = EMBEDDINGS_MIN_SCORE) {
  if (!Database) return [];
  const rows = embeddingsDb().prepare('SELECT docId, title, heading, vector FROM note_chunks').all();
  if (!rows.length) return [];
  const qVec = await embed(query, 'query');
  const cappedLimit = Math.max(1, Math.min(limit, 50));

  const bestPerNote = new Map();
  let dimMismatches = 0;
  for (const r of rows) {
    const rVec = bufferToVec(r.vector);
    // Guards against stale rows left over from switching embedding
    // backends/models mid-notebook (local vs remote use different vector
    // dimensions) — comparing across dimensions would silently produce
    // meaningless scores rather than an error, so skip instead of scoring.
    if (rVec.length !== qVec.length) { dimMismatches++; continue; }
    const score = dot(qVec, rVec);
    const prev = bestPerNote.get(r.docId);
    if (!prev || score > prev.score) {
      bestPerNote.set(r.docId, { docId: r.docId, title: r.title, heading: r.heading || null, score });
    }
  }
  if (dimMismatches) console.error(`semanticSearch: skipped ${dimMismatches} chunk(s) with mismatched vector dimensions — run a full embeddings sync`);
  return [...bestPerNote.values()]
    .filter((r) => r.score >= minScore)
    .map((r) => ({ ...r, score: +r.score.toFixed(4) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, cappedLimit);
}

// Combines full-text (siyuan.searchNotes) and semantic (semanticSearch)
// results via reciprocal rank fusion (RRF) instead of making the caller
// pick one mode up front — keyword search misses paraphrases/synonyms and
// cross-language matches that semantic search catches, while semantic
// search can miss an exact term/ID/name that keyword search nails outright.
// RRF scores each result 1/(k+rank) per side (0-based rank) and sums by
// docId, so a note both sides agree on outranks one only one side found,
// without needing the two scales (SiYuan relevance vs. cosine similarity)
// to be comparable. k=60 is the standard RRF constant — high enough that
// rank 1 vs. rank 2 on one side doesn't swamp an exact match sitting at
// rank 3 on the other.
// Each side is queried for a larger pool than the final `limit` so fusion
// has enough candidates to re-rank rather than being capped by whichever
// side happened to return fewer results.
const RRF_K = 60;
async function hybridSearch(query, limit = 10, minScore = EMBEDDINGS_MIN_SCORE) {
  const cappedLimit = Math.max(1, Math.min(limit, 50));
  const poolSize = Math.min(50, cappedLimit * 3);
  const [textResults, vectorResults] = await Promise.all([
    siyuan.searchNotes(query, poolSize).catch((e) => {
      console.error('hybridSearch: full-text side failed:', e.message);
      return [];
    }),
    semanticSearch(query, poolSize, minScore).catch((e) => {
      console.error('hybridSearch: semantic side failed:', e.message);
      return [];
    }),
  ]);

  const fused = new Map(); // docId -> merged result row
  const addRanked = (results, extra) => {
    results.forEach((r, i) => {
      const cur = fused.get(r.docId) || {
        docId: r.docId, title: r.title, path: r.path || null, heading: r.heading || null,
        snippet: r.snippet || null, rrf: 0,
      };
      cur.rrf += 1 / (RRF_K + i + 1);
      Object.assign(cur, extra(r, cur));
      fused.set(r.docId, cur);
    });
  };
  addRanked(textResults, (r, cur) => ({ path: cur.path || r.path || null, snippet: cur.snippet || r.snippet || null }));
  addRanked(vectorResults, (r, cur) => ({ heading: cur.heading || r.heading || null }));

  return [...fused.values()]
    .sort((a, b) => b.rrf - a.rrf)
    .slice(0, cappedLimit)
    .map(({ rrf, ...rest }) => ({ ...rest, score: +rrf.toFixed(4) }));
}

// Last sync outcome, surfaced on /status (mirrors lastStravaSync in server.js).
let lastSync = { at: null, synced: null, skipped: null, failed: null, error: null };
function getSyncStatus() {
  return lastSync;
}

// Reconciles the embeddings table against the current state of the RAG
// notebook: re-embeds new/changed notes (full=true forces every note),
// removes entries for notes deleted outside our own create/update/delete
// routes (e.g. deleted directly in the SiYuan UI), and — for incremental
// runs — skips notes whose SiYuan "updated" attr hasn't changed since they
// were last embedded, so a routine reconciliation pass doesn't re-run the
// model over an unchanged notebook.
async function syncEmbeddings(full) {
  if (!Database) return { synced: 0, skipped: 0, failed: 0, total: 0, skippedReason: 'database unavailable' };
  if (!siyuan.isConfigured()) return { synced: 0, skipped: 0, failed: 0, total: 0, skippedReason: 'SiYuan not configured' };
  try {
    const db = embeddingsDb();
    const notes = await siyuan.listAllNotes();
    const currentIds = new Set(notes.map((n) => n.docId));
    // Every chunk row for a note carries the same `updated` value (set once
    // per upsert), so grouping by docId collapses back to one row per note.
    const existingRows = db.prepare('SELECT docId, updated FROM note_chunks GROUP BY docId').all();
    const existingUpdated = new Map(existingRows.map((r) => [r.docId, r.updated]));

    const del = db.prepare('DELETE FROM note_chunks WHERE docId = ?');
    for (const docId of existingUpdated.keys()) {
      if (!currentIds.has(docId)) del.run(docId);
    }

    let synced = 0, skipped = 0, failed = 0;
    for (const n of notes) {
      try {
        if (!full && existingUpdated.has(n.docId)) {
          const { attrs } = await siyuan.getNoteAttrs(n.docId);
          if (attrs.updated && attrs.updated === existingUpdated.get(n.docId)) { skipped++; continue; }
        }
        await upsertNoteEmbedding(n.docId, n.title);
        synced++;
      } catch (e) {
        failed++;
        console.error(`embeddings sync failed for ${n.docId}:`, e.message);
      }
    }
    lastSync = { at: new Date().toISOString(), synced, skipped, failed, error: null };
    return { synced, skipped, failed, total: notes.length };
  } catch (e) {
    lastSync = { at: new Date().toISOString(), synced: null, skipped: null, failed: null, error: e.message };
    throw e;
  }
}

module.exports = {
  embeddingsDb, embed, semanticSearch, hybridSearch, upsertNoteEmbedding, removeNoteEmbedding,
  syncEmbeddings, getSyncStatus,
};

// SiYuan Note integration: RAG-style search plus create/edit/delete, all
// scoped to one dedicated notebook (SIYUAN_NOTEBOOK_NAME, default "RAG") so
// the rest of the user's vault (work notes, etc.) is never searched, read,
// or touched. Wraps SiYuan's kernel HTTP API directly (not the
// siyuan-plugins-mcp-sisyphus plugin, which is a much larger read/write
// surface bound to the container's loopback only).
const { SIYUAN_URL, SIYUAN_TOKEN, SIYUAN_NOTEBOOK_NAME } = require('./config');

async function siyuanPost(path, body) {
  if (!SIYUAN_URL || !SIYUAN_TOKEN) throw new Error('SiYuan not configured (set SIYUAN_URL and SIYUAN_TOKEN)');
  const res = await fetch(`${SIYUAN_URL.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: { Authorization: `Token ${SIYUAN_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) throw new Error(`SiYuan API ${path} -> ${res.status}`);
  const j = await res.json();
  if (j.code !== 0) throw new Error(`SiYuan API ${path}: ${j.msg || 'error'}`);
  return j.data;
}

// Notebook id for SIYUAN_NOTEBOOK_NAME rarely changes; cache it briefly so
// every call doesn't re-list notebooks.
let notebookCache = { ts: 0, id: null };
const NOTEBOOK_CACHE_TTL_MS = 5 * 60 * 1000;

async function resolveNotebookId() {
  if (notebookCache.id && Date.now() - notebookCache.ts < NOTEBOOK_CACHE_TTL_MS) return notebookCache.id;
  const data = await siyuanPost('/api/notebook/lsNotebooks', {});
  const nb = (data.notebooks || []).find((n) => !n.closed && n.name === SIYUAN_NOTEBOOK_NAME);
  if (!nb) throw new Error(`SiYuan notebook "${SIYUAN_NOTEBOOK_NAME}" not found (or closed)`);
  notebookCache = { ts: Date.now(), id: nb.id };
  return nb.id;
}

const ALL_BLOCK_TYPES = {
  document: true, heading: true, paragraph: true, list: true, listItem: true,
  codeBlock: true, htmlBlock: true, mathBlock: true, table: true, blockquote: true, superBlock: true,
};

// SiYuan wraps matches in <mark> and HTML-entity-escapes content; clean both
// up so callers get plain, readable text.
function cleanSnippet(s) {
  return String(s || '')
    .replace(/<\/?mark>/g, '')
    .replace(/&#34;|&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

// Strip SiYuan's kramdown block-attribute syntax ({: id="..." updated="..."})
// so a fetched note reads like plain markdown instead of source-with-metadata.
function stripBlockAttrs(kramdown) {
  return String(kramdown || '')
    .replace(/\{:[^\n}]*\}/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Recursively walks the RAG notebook's document tree (listDocsByPath scopes
// one folder level at a time; a folder is named after its own docId), so
// nested notes are included, not just root-level ones.
async function listAllNotes() {
  const notebookId = await resolveNotebookId();
  const results = [];
  async function walk(dirPath, breadcrumb) {
    const data = await siyuanPost('/api/filetree/listDocsByPath', { notebook: notebookId, path: dirPath });
    for (const f of data.files || []) {
      const path = `${breadcrumb}/${f.name}`;
      results.push({ docId: f.id, title: f.name, path });
      if (f.subFileCount > 0) {
        await walk(`${dirPath === '/' ? '' : dirPath}/${f.id}`, path);
      }
    }
  }
  await walk('/', '');
  return results;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Full-text search, deduped to one result per note (SiYuan matches at the
// block level, so a single note with several matching paragraphs would
// otherwise show up as several near-identical rows) — keeps the
// highest-relevance block per note, up to `limit` distinct notes.
//
// SiYuan's keyword search (method: 0) matches as a raw substring with no
// word-boundary awareness for Latin scripts, so a short query like "NAC"
// also matches inside unrelated words like "Nachrichten" or "Nachteile".
// (method: 2 would let SiYuan's own regex/query-syntax do this properly, but
// that method passes the query straight through as raw SQL with no auth
// check — CVE-2026-32767, fixed in SiYuan 3.6.1 — so it's not used here
// regardless of the SiYuan version in use.) For short single-token queries,
// require the query to appear as a whole word in the cleaned block content
// or path before accepting the hit; longer/multi-word queries are left as
// SiYuan returns them.
async function searchNotes(query, limit = 10) {
  const notebookId = await resolveNotebookId();
  const data = await siyuanPost('/api/search/fullTextSearchBlock', {
    query, method: 0, types: ALL_BLOCK_TYPES, paths: [notebookId], groupBy: 0, orderBy: 0, page: 1,
  });
  const cappedLimit = Math.max(1, Math.min(limit, 50));
  const enforceWordBoundary = /^\w+$/.test(query) && query.length <= 8;
  const wordRe = enforceWordBoundary ? new RegExp(`\\b${escapeRegExp(query)}\\b`, 'i') : null;

  const seen = new Set();
  const results = [];
  for (const b of data.blocks || []) {
    if (seen.has(b.rootID)) continue;
    const snippet = cleanSnippet(b.content);
    if (wordRe && !wordRe.test(snippet) && !wordRe.test(b.hPath || '')) continue;
    seen.add(b.rootID);
    results.push({
      id: b.id,
      docId: b.rootID,
      title: (b.hPath || '').split('/').filter(Boolean).pop() || '(untitled)',
      path: b.hPath || '',
      snippet,
    });
    if (results.length >= cappedLimit) break;
  }
  return results;
}

// Defense in depth: getBlockInfo/updateBlock/removeDocByID all work for ANY
// block id, not just ones scoped by searchNotes, so every call taking a
// caller-supplied docId verifies it actually belongs to the RAG notebook
// first — never let an out-of-scope id read, edit, or delete another note.
async function assertInRagNotebook(docId) {
  const notebookId = await resolveNotebookId();
  const info = await siyuanPost('/api/block/getBlockInfo', { id: docId }).catch(() => null);
  if (!info) throw new Error('note not found');
  if (info.box !== notebookId) throw new Error(`note is not in the "${SIYUAN_NOTEBOOK_NAME}" notebook`);
}

async function getNote(docId) {
  await assertInRagNotebook(docId);
  const data = await siyuanPost('/api/block/getBlockKramdown', { id: docId });
  return { id: data.id, markdown: stripBlockAttrs(data.kramdown) };
}

// createDocWithMd's `path` is a slash-separated human path (SiYuan's hpath),
// not a docId path — nesting is just a matter of prefixing the parent's own
// hpath, and SiYuan creates any missing intermediate docs along the way.
async function createNote(title, markdown, parentDocId) {
  const notebookId = await resolveNotebookId();
  const existing = await listAllNotes();
  const dup = existing.find((n) => n.title === title);
  if (dup) throw new Error(`a note titled "${title}" already exists (docId: ${dup.docId})`);
  let parentHPath = '';
  if (parentDocId) {
    await assertInRagNotebook(parentDocId);
    parentHPath = await siyuanPost('/api/filetree/getHPathByID', { id: parentDocId });
  }
  const path = `${parentHPath}/${String(title).replace(/[\\/]/g, '-')}`;
  const docId = await siyuanPost('/api/filetree/createDocWithMd', {
    notebook: notebookId, path, markdown: markdown || `# ${title}`,
  });
  return { docId };
}

// Moves a note to a new parent within the RAG notebook, or to the notebook
// root if parentDocId is omitted (moveDocsByID's `toID` accepts either a
// parent doc's id or a notebook id).
async function moveNote(docId, parentDocId) {
  await assertInRagNotebook(docId);
  let toID = await resolveNotebookId();
  if (parentDocId) {
    await assertInRagNotebook(parentDocId);
    toID = parentDocId;
  }
  await siyuanPost('/api/filetree/moveDocsByID', { fromIDs: [docId], toID });
  return { docId, parentDocId: parentDocId || null };
}

// mode "replace" (default) overwrites the whole body; "append" adds a new
// block at the end instead, for adding to a note without re-sending or
// risking clobbering its existing content. `title` is optional and, if
// given, also renames the note (the sidebar title is independent of the
// content's first heading, so editing content alone would otherwise leave a
// stale-looking title).
async function updateNote(docId, markdown, title, mode = 'replace') {
  await assertInRagNotebook(docId);
  if (mode === 'append') {
    await siyuanPost('/api/block/appendBlock', { dataType: 'markdown', data: markdown, parentID: docId });
  } else {
    await siyuanPost('/api/block/updateBlock', { dataType: 'markdown', data: markdown, id: docId });
  }
  if (title) await siyuanPost('/api/filetree/renameDocByID', { id: docId, title });
  return { docId, mode };
}

async function deleteNote(docId) {
  await assertInRagNotebook(docId);
  await siyuanPost('/api/filetree/removeDocByID', { id: docId });
  return { ok: true };
}

// SiYuan reserves un-prefixed attribute names for its own metadata (title,
// bookmark, etc.); custom ones must be prefixed "custom-", so callers don't
// have to remember that and can't accidentally clobber a reserved attribute.
async function setNoteAttrs(docId, attrs) {
  await assertInRagNotebook(docId);
  const prefixed = {};
  for (const [k, v] of Object.entries(attrs || {})) {
    prefixed[k.startsWith('custom-') ? k : `custom-${k}`] = String(v);
  }
  await siyuanPost('/api/attr/setBlockAttrs', { id: docId, attrs: prefixed });
  return { docId, attrs: prefixed };
}

async function getNoteAttrs(docId) {
  await assertInRagNotebook(docId);
  const attrs = await siyuanPost('/api/attr/getBlockAttrs', { id: docId });
  return { docId, attrs };
}

function isConfigured() {
  return !!(SIYUAN_URL && SIYUAN_TOKEN);
}

// SiYuan doc/block ids are a fixed "YYYYMMDDHHmmss-xxxxxxx" shape; validated
// before being interpolated into a raw SQL statement below (the query API
// has no parameterized-query form) — this is the whole injection defense.
const DOC_ID_RE = /^\d{14}-[a-z0-9]{7}$/;

// Notes that link to `docId` via SiYuan's `((docId 'text'))` block-reference
// syntax — real backlinks, not a text-match. Queried straight from SiYuan's
// own SQLite `refs` table (query/sql), scoped to this notebook's `box` so a
// reference from the user's other notebooks can never leak through. Returns
// one row per distinct referencing note (a note can reference the same
// target several times; refs.root_id is the referencing note's own docId).
async function getBacklinks(docId) {
  await assertInRagNotebook(docId);
  if (!DOC_ID_RE.test(docId)) throw new Error('invalid docId format');
  const notebookId = await resolveNotebookId();
  const rows = await siyuanPost('/api/query/sql', {
    stmt: `SELECT DISTINCT root_id FROM refs WHERE box = '${notebookId}' AND (def_block_id = '${docId}' OR def_block_root_id = '${docId}')`,
  });
  const notes = await listAllNotes();
  const byId = new Map(notes.map((n) => [n.docId, n]));
  return (rows || []).map((r) => byId.get(r.root_id)).filter(Boolean);
}

module.exports = {
  listAllNotes, searchNotes, getNote, createNote, updateNote, deleteNote, moveNote,
  setNoteAttrs, getNoteAttrs, isConfigured, getBacklinks,
};

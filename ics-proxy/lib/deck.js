// Nextcloud Deck (kanban) read layer. Reuses the Nextcloud host + credentials
// already configured for CalDAV. Read-only for now (no card mutation). Cards
// that are archived or marked done are excluded. Cached like the other reads.
const cfg = require('./config');

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // key -> { ts, data }

function origin() { return new URL(cfg.CAL_URL || cfg.ICS_URL).origin; }
function base() { return `${origin()}/index.php/apps/deck/api/v1.0`; }
function authHeader() {
  const u = cfg.TASKS_USER || cfg.ICS_USER, p = cfg.TASKS_PASS || cfg.ICS_PASS;
  return `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;
}
function configured() {
  return !!(cfg.CAL_URL || cfg.ICS_URL) && !!(cfg.TASKS_USER || cfg.ICS_USER) && !!(cfg.TASKS_PASS || cfg.ICS_PASS);
}

async function deckGet(path) {
  const r = await fetch(`${base()}${path}`, {
    headers: { Authorization: authHeader(), 'OCS-APIRequest': 'true', Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`Deck GET ${path} -> ${r.status}`);
  return r.json();
}

async function deckPost(path, body) {
  const r = await fetch(`${base()}${path}`, {
    method: 'POST',
    headers: { Authorization: authHeader(), 'OCS-APIRequest': 'true', Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Deck POST ${path} -> ${r.status}: ${(await r.text()).slice(0, 200)}`);
  cache.clear(); // reads are cached; a write invalidates boards/cards
  return r.json();
}

async function deckDelete(path) {
  const r = await fetch(`${base()}${path}`, {
    method: 'DELETE',
    headers: { Authorization: authHeader(), 'OCS-APIRequest': 'true', Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`Deck DELETE ${path} -> ${r.status}: ${(await r.text()).slice(0, 200)}`);
  cache.clear();
  return true;
}

async function cached(key, fetchFn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.data;
  const data = await fetchFn();
  cache.set(key, { ts: Date.now(), data });
  return data;
}

// Non-archived boards.
async function boards() {
  return cached('boards', async () => {
    const b = await deckGet('/boards');
    return (b || []).filter((x) => !x.archived).map((x) => ({ id: x.id, title: x.title, color: x.color }));
  });
}

// All open cards across non-archived boards (excludes archived + done cards).
async function cards() {
  return cached('cards', async () => {
    const bs = await boards();
    const per = await Promise.all(bs.map(async (b) => {
      const stacks = await deckGet(`/boards/${b.id}/stacks`).catch(() => []);
      const out = [];
      for (const s of stacks || []) {
        for (const c of s.cards || []) {
          if (c.archived || c.done) continue;
          out.push({
            id: c.id, title: c.title, board: b.title, stack: s.title,
            due: c.duedate || null,
            labels: (c.labels || []).map((l) => l.title),
          });
        }
      }
      return out;
    }));
    return per.flat();
  });
}

// Cards due on/before `endISO` (so overdue cards are included), sorted by due.
async function cardsDue(endISO) {
  const end = new Date(endISO);
  const all = await cards();
  return all
    .filter((c) => c.due && new Date(c.due) <= end)
    .sort((a, b) => new Date(a.due) - new Date(b.due));
}

// Stacks (columns) of a board, id + title, needed to place a new card.
async function stacks(boardId) {
  const s = await deckGet(`/boards/${boardId}/stacks`);
  return (s || []).map((x) => ({ id: x.id, title: x.title, order: x.order }));
}

// --- Writes ----------------------------------------------------------------
async function createBoard({ title, color = '0082c9' }) {
  if (!title) throw new Error('title required');
  const b = await deckPost('/boards', { title, color });
  return { id: b.id, title: b.title, color: b.color };
}

async function createStack({ boardId, title, order = 999 }) {
  if (!boardId || !title) throw new Error('boardId and title required');
  const s = await deckPost(`/boards/${boardId}/stacks`, { title, order });
  return { id: s.id, title: s.title, boardId: Number(boardId) };
}

// Normalize a due value: full ISO passes through; YYYY-MM-DD becomes noon UTC.
function normalizeDue(due) {
  if (!due) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(due)) return `${due}T12:00:00+00:00`;
  return due;
}

async function createCard({ boardId, stackId, title, description, due }) {
  if (!boardId || !stackId || !title) throw new Error('boardId, stackId and title required');
  const body = { title, type: 'plain', order: 999 };
  if (description) body.description = description;
  const duedate = normalizeDue(due);
  if (duedate) body.duedate = duedate;
  const c = await deckPost(`/boards/${boardId}/stacks/${stackId}/cards`, body);
  return { id: c.id, title: c.title, boardId: Number(boardId), stackId: Number(stackId), due: c.duedate || null };
}

async function deleteCard({ boardId, stackId, cardId }) {
  if (!boardId || !stackId || !cardId) throw new Error('boardId, stackId and cardId required');
  await deckDelete(`/boards/${boardId}/stacks/${stackId}/cards/${cardId}`);
  return { deleted: true, cardId: Number(cardId) };
}

module.exports = { configured, boards, cards, cardsDue, stacks, createBoard, createStack, createCard, deleteCard };

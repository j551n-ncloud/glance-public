// Minimal client for ntfy (ntfy.sh or self-hosted): push notifications via a
// plain HTTP POST, no SDK needed. Uses the JSON publish endpoint (root URL,
// not /topic) so UTF-8 title/message content (umlauts, emoji) never has to
// survive as an HTTP header value. https://docs.ntfy.sh/publish/#publish-as-json
const { NTFY_URL, NTFY_TOPIC, NTFY_TOKEN } = require('./config');

function configured() {
  return !!NTFY_TOPIC;
}

async function send({ title, message, tags, priority }) {
  if (!NTFY_TOPIC) throw new Error('NTFY_TOPIC is not set');
  const headers = { 'Content-Type': 'application/json' };
  if (NTFY_TOKEN) headers.Authorization = `Bearer ${NTFY_TOKEN}`;
  const body = { topic: NTFY_TOPIC, message };
  if (title) body.title = title;
  if (tags) body.tags = Array.isArray(tags) ? tags : [tags]; // ntfy rejects a bare string with a misleading "invalid JSON" 400
  if (priority) body.priority = priority;
  const r = await fetch(NTFY_URL, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`ntfy POST -> ${r.status}: ${await r.text()}`);
  return r.json();
}

module.exports = { configured, send };

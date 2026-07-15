#!/usr/bin/env node
// Read-only smoke/regression harness for the ics-proxy HTTP surface.
//
// It hits every GET endpoint through nginx (localhost:8088) and reduces each
// response to a "shape signature": the sorted set of `path:type` pairs. Values
// change day to day (weather, events, load) but the SHAPE must not, so this is
// the regression net for the module split.
//
//   node test/smoke.mjs --save    # write the current shapes as the baseline
//   node test/smoke.mjs           # compare current shapes against the baseline
//
// Exit code is non-zero on any drift, so it doubles as a CI gate.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.SMOKE_BASE || 'http://localhost:8088';
const BASELINE = join(HERE, 'shapes.baseline.json');

function token() {
  if (process.env.API_TOKEN) return process.env.API_TOKEN;
  const env = readFileSync(join(HERE, '..', '..', '.env'), 'utf8');
  const m = env.match(/^API_TOKEN=(.*)$/m);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
}
const TOKEN = token();

// A stable local day for date-parameterized endpoints (tomorrow, so plan-day
// and free-slots have a full working window regardless of run time).
const today = new Date();
const t2 = new Date(today.getTime() + 86400000);
const iso = (d) => d.toISOString().slice(0, 10);
const DAY = iso(t2);
const slotStart = `${DAY}T10:00:00.000Z`;
const slotEnd = `${DAY}T10:30:00.000Z`;

// Read-only endpoints only. Every one is a GET and mutates nothing.
const ENDPOINTS = [
  ['events', '/ews-api/events'],
  ['ics-events', '/ews-api/ics-events'],
  ['home-tasks', '/tasks-api/home-tasks'],
  ['work-tasks', '/tasks-api/work-tasks'],
  ['agenda', `/ews-api/agenda?date=${DAY}`],
  ['free-slots', `/ews-api/free-slots?date=${DAY}`],
  ['search', '/ews-api/search?q=meeting'],
  ['weather', '/ews-api/weather'],
  ['weather-place', '/ews-api/weather?place=Munich'],
  ['plan-day', `/ews-api/plan-day?date=${DAY}`],
  ['check-conflicts', `/ews-api/check-conflicts?start=${slotStart}&end=${slotEnd}`],
  ['task-triage', '/tasks-api/task-triage'],
  ['deck-boards', '/deck-api/boards'],
  ['deck-cards', '/deck-api/cards'],
  ['deck-cards-due', '/deck-api/cards-due?days=7'],
  ['strava-activities', '/strava-api/activities?per_page=3'],
  ['strava-athlete', '/strava-api/athlete'],
  ['strava-zones', '/strava-api/zones'],
  ['strava-gear', '/strava-api/gear'],
  ['strava-ytd', '/strava-api/ytd'],
  ['strava-load', '/strava-api/load'],
  ['strava-readiness', '/strava-api/readiness'],
  ['strava-load-vs-training', '/strava-api/load-vs-training?weeks=4'],
  ['strava-series', '/strava-api/series?metric=distance&granularity=week'],
];

// Reduce a value to a sorted array of `path:type` strings. Arrays are sampled:
// their element shapes are merged so an empty vs non-empty list only differs by
// the presence of element paths, not by index.
function shape(val, path = '', acc = new Set()) {
  const t = val === null ? 'null' : Array.isArray(val) ? 'array' : typeof val;
  if (t === 'object') {
    acc.add(`${path}:object`);
    for (const k of Object.keys(val)) shape(val[k], path ? `${path}.${k}` : k, acc);
  } else if (t === 'array') {
    acc.add(`${path}:array`);
    for (const el of val) shape(el, `${path}[]`, acc);
  } else {
    acc.add(`${path}:${t}`);
  }
  return acc;
}

async function fetchShape(url) {
  const r = await fetch(`${BASE}${url}`, { headers: { 'X-Api-Token': TOKEN } });
  const body = await r.json();
  return { status: r.status, shape: [...shape(body)].sort() };
}

const args = process.argv.slice(2);
const save = args.includes('--save');

const current = {};
for (const [name, url] of ENDPOINTS) {
  try {
    current[name] = await fetchShape(url);
  } catch (e) {
    current[name] = { status: 0, error: String(e.message || e), shape: [] };
  }
}

// Internal endpoints (not proxied through nginx) reached via `docker exec`, so
// regressions like a stale reference in /status are caught too. Skipped if the
// container/CLI isn't reachable, so the harness still runs outside compose.
const INTERNAL = [
  ['status', '/status'],
  ['health', '/health'],
];
for (const [name, path] of INTERNAL) {
  try {
    const out = execFileSync('docker', [
      'exec', '-e', `TOK=${TOKEN}`, 'ics-proxy', 'node', '-e',
      `fetch("http://localhost:3000${path}",{headers:{"X-Api-Token":process.env.TOK}}).then(async r=>{process.stdout.write(r.status+"\\n"+await r.text());})`,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const nl = out.indexOf('\n');
    const status = parseInt(out.slice(0, nl), 10);
    current[name] = { status, shape: [...shape(JSON.parse(out.slice(nl + 1)))].sort() };
  } catch (e) {
    current[name] = { status: 0, error: `internal probe skipped: ${String(e.message || e).slice(0, 80)}`, shape: [] };
  }
}
const ALL = [...ENDPOINTS, ...INTERNAL];

if (save) {
  writeFileSync(BASELINE, JSON.stringify(current, null, 2) + '\n');
  const bad = Object.entries(current).filter(([, v]) => v.status !== 200);
  console.log(`saved baseline for ${ALL.length} endpoints -> ${BASELINE}`);
  if (bad.length) console.log(`  warning: non-200 at save time: ${bad.map(([n, v]) => `${n}(${v.status})`).join(', ')}`);
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error('no baseline; run: node test/smoke.mjs --save');
  process.exit(2);
}
const base = JSON.parse(readFileSync(BASELINE, 'utf8'));

let failures = 0;
for (const [name] of ALL) {
  const b = base[name];
  const c = current[name];
  if (!b) { console.log(`? ${name}: not in baseline (new endpoint)`); continue; }
  if (c.status !== b.status) {
    console.log(`FAIL ${name}: status ${b.status} -> ${c.status}`);
    failures++;
    continue;
  }
  const bs = new Set(b.shape), cs = new Set(c.shape);
  const missing = [...bs].filter((x) => !cs.has(x));
  const added = [...cs].filter((x) => !bs.has(x));
  if (missing.length || added.length) {
    console.log(`FAIL ${name}: shape drift`);
    if (missing.length) console.log(`   - missing: ${missing.join(', ')}`);
    if (added.length) console.log(`   + added:   ${added.join(', ')}`);
    failures++;
  } else {
    console.log(`ok   ${name} (${c.shape.length} paths, ${c.status})`);
  }
}

console.log(failures ? `\n${failures} endpoint(s) drifted` : `\nall ${ALL.length} endpoints stable`);
process.exit(failures ? 1 : 0);

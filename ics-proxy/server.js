const express = require('express');
const ical = require('node-ical');
const httpntlm = require('httpntlm');
const nodemailer = require('nodemailer');
const cron = require('node-cron');

// better-sqlite3 is a native addon; if it ever fails to load, the rest of the
// proxy must still run, so require it defensively and disable DB features.
let Database = null;
try { Database = require('better-sqlite3'); }
catch (e) { console.error('better-sqlite3 unavailable, Strava history disabled:', e.message); }

const {
  API_TOKEN, PORT, ICS_URL, ICS_USER, ICS_PASS, CAL_URL,
  EWS_URL, EWS_USER, EWS_PASS, EWS_DOMAIN,
  CALENDAR_FEED_TOKEN, CALENDAR_FEED_PAST_DAYS, CALENDAR_FEED_FUTURE_DAYS,
  TASKS_HOME_URL, TASKS_WORK_URL, TASKS_USER, TASKS_PASS,
  CACHE_TTL_MS, LIMIT,
  DIGEST_ENABLED, DIGEST_TO, DIGEST_CRON, DIGEST_TZ, DIGEST_PRIORITY,
  WEEKLY_ENABLED, WEEKLY_TO, WEEKLY_CRON,
  SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, SMTP_FROM,
  STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, STRAVA_REFRESH_TOKEN, STRAVA_API,
  STRAVA_CACHE_TTL_MS, STRAVA_GOAL_RUN_KM, STRAVA_GOAL_RIDE_KM, STRAVA_GOAL_SWIM_KM, STRAVA_DB,
} = require('./lib/config');
const ntfy = require('./lib/ntfy');

const app = express();
// Every route here is a live JSON API, not static content, so an HTTP-level
// ETag/If-None-Match dance buys nothing and actively breaks things: Express
// enables etag generation by default, and with Cloudflare fronting the
// origin (see nginx.conf.template), that produces bodyless 304 responses to
// plain browser fetch()es that never sent a conditional header themselves —
// calling .json() on the empty body then throws (Chrome: "Unexpected end of
// JSON input"; Safari: "The string did not match the expected pattern.").
// Every chart widget on the dashboard hit this. Disabling etag generation
// removes the 304 path entirely; explicit no-store below tells any cache in
// front (Cloudflare included) not to store or revalidate these responses.
app.set('etag', false);
app.use(express.json({ limit: '20mb' })); // Health Auto Export payloads can be large
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Token');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Protect all write operations with a shared secret token.
// GET requests are read-only and served from the Docker-internal network.
app.use((req, res, next) => {
  if (req.method !== 'POST') return next();
  if (!API_TOKEN) return next(); // token not configured, allow (dev/unconfigured)
  if (req.headers['x-api-token'] !== API_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

const fmt = new Intl.DateTimeFormat('de-DE', {
  weekday: 'short',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

const fmtDateOnly = new Intl.DateTimeFormat('de-DE', {
  weekday: 'short',
  day: '2-digit',
  month: '2-digit',
});

// node-ical returns VALUE=DATE props as raw objects { val: 'YYYYMMDD' } instead of Date instances
function parseIcalDate(val) {
  if (!val) return null;
  if (val instanceof Date) return isNaN(val.getTime()) ? null : val;
  const str = typeof val === 'object' ? (val.val || '') : String(val);
  // Date-only: YYYYMMDD
  if (/^\d{8}$/.test(str)) {
    const d = new Date(`${str.slice(0, 4)}-${str.slice(4, 6)}-${str.slice(6, 8)}`);
    return isNaN(d.getTime()) ? null : d;
  }
  // Compact ICS datetime: YYYYMMDDTHHMMSS with optional trailing Z (UTC).
  // node-ical hands VTODO DUE/DTSTART back as a raw string in this form.
  const m = str.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (m) {
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] ? 'Z' : ''}`;
    const d = new Date(iso);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

// Guard against path traversal: a uid is interpolated into CalDAV resource URLs
// ({uid}.ics), so it must be a plain identifier with no slashes or dots-dots.
function assertUid(uid) {
  if (typeof uid !== 'string' || !/^[A-Za-z0-9._@-]+$/.test(uid)) {
    throw new Error('invalid uid');
  }
}

function buildIcsHeaders() {
  if (ICS_USER && ICS_PASS) {
    const token = Buffer.from(`${ICS_USER}:${ICS_PASS}`).toString('base64');
    return { Authorization: `Basic ${token}` };
  }
  return {};
}

// Expand all VEVENTs in a parsed ICS into concrete occurrences overlapping
// [rangeStart, rangeEnd), including recurring events (RRULE). Honors EXDATE
// exclusions and per-occurrence overrides (RECURRENCE-ID / node-ical
// `recurrences`). Non-recurring events pass through if they overlap.
function collectIcsOccurrences(data, rangeStart, rangeEnd) {
  const out = [];
  for (const v of Object.values(data)) {
    if (v.type !== 'VEVENT' || !v.start) continue;
    const masterStart = new Date(v.start);
    const masterEnd = v.end ? new Date(v.end) : null;
    const durMs = masterEnd ? masterEnd - masterStart : 0;

    const make = (src, startDate) => {
      const s = new Date(startDate);
      const e = src.end ? new Date(s.getTime() + (new Date(src.end) - new Date(src.start)))
                        : (durMs ? new Date(s.getTime() + durMs) : null);
      return {
        title: src.summary || v.summary || '(ohne Titel)',
        when: fmt.format(s),
        start: s.toISOString(),
        end: e ? e.toISOString() : null,
        location: src.location || v.location || '',
        uid: v.uid || '',
      };
    };
    const overlaps = (o) => {
      const s = new Date(o.start);
      const e = o.end ? new Date(o.end) : s;
      return s < rangeEnd && e > rangeStart;
    };

    if (!v.rrule) {
      const o = make(v, masterStart);
      if (overlaps(o)) out.push(o);
      continue;
    }

    const exSet = new Set(v.exdate ? Object.values(v.exdate).map((d) => new Date(d).getTime()) : []);
    let occs = [];
    try {
      occs = v.rrule.between(new Date(rangeStart.getTime() - Math.max(durMs, 0) - 1000), rangeEnd, true);
    } catch { occs = []; }
    for (const d of occs) {
      if (exSet.has(d.getTime())) continue;
      const key = d.toISOString().slice(0, 10);
      const override = v.recurrences && v.recurrences[key];
      const o = override ? make(override, override.start || d) : make(v, d);
      if (overlaps(o)) out.push(o);
    }
  }
  return out.sort((a, b) => new Date(a.start) - new Date(b.start));
}

async function fetchIcsEvents() {
  if (!ICS_URL) throw new Error('ICS_URL is not set');
  const data = await ical.async.fromURL(ICS_URL, { headers: buildIcsHeaders() });
  const now = new Date();
  // Cap the recurrence horizon so infinite RRULEs terminate; widget shows the
  // next LIMIT upcoming/in-progress occurrences.
  const horizon = new Date(now.getTime() + 365 * 24 * 3600 * 1000);
  return collectIcsOccurrences(data, now, horizon).slice(0, LIMIT);
}

// All Nextcloud (home) events overlapping [start, end), including past ones and
// recurring-event occurrences.
async function fetchIcsRange(start, end) {
  if (!ICS_URL) throw new Error('ICS_URL is not set');
  const data = await ical.async.fromURL(ICS_URL, { headers: buildIcsHeaders() });
  return collectIcsOccurrences(data, start, end);
}

function toZoomDeepLink(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.includes('zoom')) return url;
    const confno = u.pathname.replace('/j/', '');
    const pwd = u.searchParams.get('pwd') || '';
    return `zoommtg://${u.hostname}/join?confno=${confno}${pwd ? '&pwd=' + pwd : ''}`;
  } catch { return url; }
}

function buildEwsSoap(startDate, endDate) {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">
  <soap:Header>
    <t:RequestServerVersion Version="Exchange2013"/>
  </soap:Header>
  <soap:Body>
    <m:FindItem Traversal="Shallow">
      <m:ItemShape>
        <t:BaseShape>IdOnly</t:BaseShape>
        <t:AdditionalProperties>
          <t:FieldURI FieldURI="item:Subject"/>
          <t:FieldURI FieldURI="calendar:Start"/>
          <t:FieldURI FieldURI="calendar:End"/>
          <t:FieldURI FieldURI="calendar:Location"/>
          <t:FieldURI FieldURI="calendar:CalendarItemType"/>
        </t:AdditionalProperties>
      </m:ItemShape>
      <m:CalendarView MaxReturnsTotal="${LIMIT + 20}" StartDate="${startDate}" EndDate="${endDate}"/>
      <m:ParentFolderIds>
        <t:DistinguishedFolderId Id="calendar"/>
      </m:ParentFolderIds>
    </m:FindItem>
  </soap:Body>
</soap:Envelope>`;
}

function parseEwsCalendarItems(body) {
  const items = [];
  const re = /<t:CalendarItem>([\s\S]*?)<\/t:CalendarItem>/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const block = m[1];
    const subject = (block.match(/<t:Subject>(.*?)<\/t:Subject>/) || [])[1] || '(ohne Titel)';
    const start = (block.match(/<t:Start>(.*?)<\/t:Start>/) || [])[1];
    const evEnd = (block.match(/<t:End>(.*?)<\/t:End>/) || [])[1];
    const location = (block.match(/<t:Location>(.*?)<\/t:Location>/) || [])[1] || '';
    const idMatch = block.match(/<t:ItemId Id="([^"]*)"(?:\s+ChangeKey="([^"]*)")?/);
    const calType = (block.match(/<t:CalendarItemType>(.*?)<\/t:CalendarItemType>/) || [])[1] || '';
    if (start) {
      items.push({
        title: subject,
        when: fmt.format(new Date(start)),
        start: new Date(start).toISOString(),
        end: evEnd ? new Date(evEnd).toISOString() : null,
        location: location,
        id: idMatch ? idMatch[1] : null,           // EWS ItemId (for delete)
        changeKey: idMatch ? (idMatch[2] || null) : null,
        calendarItemType: calType,                  // Single | Occurrence | Exception | RecurringMaster
      });
    }
  }
  return items;
}

// Low-level EWS CalendarView query over an explicit [start, end) window.
// Returns all items in the window (no past filter), sorted by start.
function fetchEwsRange(startISO, endISO) {
  const soap = buildEwsSoap(new Date(startISO).toISOString(), new Date(endISO).toISOString());
  return new Promise((resolve, reject) => {
    httpntlm.post({
      url: EWS_URL,
      username: EWS_USER,
      password: EWS_PASS,
      domain: EWS_DOMAIN,
      workstation: '',
      body: soap,
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': '"http://schemas.microsoft.com/exchange/services/2006/messages/FindItem"',
      },
    }, (err, res) => {
      if (err) return reject(err);
      if (res.statusCode !== 200) {
        return reject(new Error(`EWS returned ${res.statusCode}: ${String(res.body).slice(0, 300)}`));
      }
      resolve(parseEwsCalendarItems(res.body).sort((a, b) => new Date(a.start) - new Date(b.start)));
    });
  });
}

function fetchEwsEvents() {
  const now = new Date();
  // Start from the beginning of today so events already in progress are
  // included (CalendarView returns occurrences overlapping the window).
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setMonth(end.getMonth() + 3);
  const soap = buildEwsSoap(startOfDay.toISOString(), end.toISOString());

  return new Promise((resolve, reject) => {
    httpntlm.post({
      url: EWS_URL,
      username: EWS_USER,
      password: EWS_PASS,
      domain: EWS_DOMAIN,
      workstation: '',
      body: soap,
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': '"http://schemas.microsoft.com/exchange/services/2006/messages/FindItem"',
      },
    }, (err, res) => {
      if (err) return reject(err);
      if (res.statusCode !== 200) {
        return reject(new Error(`EWS returned ${res.statusCode}: ${String(res.body).slice(0, 300)}`));
      }

      const items = parseEwsCalendarItems(res.body);
      // Drop events that already ended; keep in-progress and upcoming.
      const upcoming = items
        .filter((i) => !i.end || new Date(i.end) >= now)
        .sort((a, b) => new Date(a.start) - new Date(b.start));
      // Count today's events by Berlin date, not UTC.
      const berlinDate = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date(iso));
      const todayBerlin = berlinDate(now);
      const todayCount = upcoming.filter((i) => berlinDate(i.start) === todayBerlin).length;
      resolve({ events: upcoming.slice(0, LIMIT), todayCount });
    });
  });
}

async function fetchTasks(url) {
  if (!url) throw new Error('Tasks URL not configured');
  const headers = {};
  if (TASKS_USER && TASKS_PASS) {
    headers.Authorization = `Basic ${Buffer.from(`${TASKS_USER}:${TASKS_PASS}`).toString('base64')}`;
  }
  const data = await ical.async.fromURL(url, { headers });
  return Object.values(data)
    .filter(v => v.type === 'VTODO' && v.status !== 'COMPLETED' && v.status !== 'CANCELLED')
    .sort((a, b) => {
      const da = parseIcalDate(a.due);
      const db = parseIcalDate(b.due);
      if (da && db) return da - db;
      if (da) return -1;
      if (db) return 1;
      return 0;
    })
    .map(v => {
      const startDate = parseIcalDate(v.start);
      const dueDate = parseIcalDate(v.due);
      const fmtTask = (d) => (isAllDay(d) ? fmtDateOnly : fmt).format(d);
      return {
        title: v.summary || '(ohne Titel)',
        start: startDate ? fmtTask(startDate) : null,
        due: dueDate ? fmtTask(dueDate) : null,
        uid: v.uid || '',
      };
    });
}

let ewsCache = { ts: 0, data: null };
let icsCache = { ts: 0, data: null };
let homeTasksCache = { ts: 0, data: null };
let workTasksCache = { ts: 0, data: null };

// Invalidate a cache after a write. Clearing `data` (not just `ts`) matters:
// handleRequest() serves `data` immediately if present, so leaving stale data
// in place means the very next GET (e.g. a post-write verification read)
// returns pre-write results and only kicks off a background refresh. Clearing
// `data` forces that next GET to synchronously fetch fresh state instead.
function invalidateCache(cacheObj) {
  cacheObj.ts = 0;
  cacheObj.data = null;
}

async function handleRequest(res, fetchFn, cacheObj) {
  try {
    if (cacheObj.data) {
      res.json(cacheObj.data);
      if (Date.now() - cacheObj.ts >= CACHE_TTL_MS) {
        fetchFn()
          .then(data => { cacheObj.ts = Date.now(); cacheObj.data = data; })
          .catch(err => console.error('background refresh failed:', err.message));
      }
      return;
    }
    const data = await fetchFn();
    cacheObj.ts = Date.now();
    cacheObj.data = data;
    res.json(data);
  } catch (err) {
    console.error('fetch failed:', err.message);
    res.status(500).json({ error: err.message });
  }
}

function prewarm(fetchFn, cacheObj, name) {
  fetchFn()
    .then(data => { cacheObj.ts = Date.now(); cacheObj.data = data; console.log(`prewarm ok: ${name}`); })
    .catch(err => console.error(`prewarm failed: ${name}:`, err.message));
}

// --- Strava ---------------------------------------------------------------
// Access tokens last ~6h; we refresh on demand and cache in memory. Strava can
// rotate the refresh token on refresh, so we surface a warning if it changes.
let stravaToken = { access: null, expiresAt: 0 };

async function stravaAccessToken() {
  if (stravaToken.access && Date.now() < stravaToken.expiresAt - 60000) return stravaToken.access;
  if (!STRAVA_CLIENT_ID || !STRAVA_CLIENT_SECRET || !STRAVA_REFRESH_TOKEN) {
    throw new Error('Strava not configured (set STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, STRAVA_REFRESH_TOKEN)');
  }
  const r = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: STRAVA_CLIENT_ID,
      client_secret: STRAVA_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: STRAVA_REFRESH_TOKEN,
    }),
  });
  if (!r.ok) throw new Error(`Strava token refresh -> ${r.status}: ${await r.text()}`);
  const j = await r.json();
  stravaToken = { access: j.access_token, expiresAt: (j.expires_at || 0) * 1000 };
  if (j.refresh_token && j.refresh_token !== STRAVA_REFRESH_TOKEN) {
    console.warn('Strava rotated the refresh token. Update STRAVA_REFRESH_TOKEN in .env to:', j.refresh_token);
  }
  return stravaToken.access;
}

async function stravaGet(path) {
  const token = await stravaAccessToken();
  const r = await fetch(`${STRAVA_API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Strava GET ${path} -> ${r.status}: ${await r.text()}`);
  return r.json();
}

// Keyed serve-stale cache (mirrors handleRequest, but per query string).
const stravaCache = new Map(); // key -> { ts, data }
async function stravaCached(key, fetchFn, res) {
  const hit = stravaCache.get(key);
  if (hit) {
    res.json(hit.data);
    if (Date.now() - hit.ts >= STRAVA_CACHE_TTL_MS) {
      fetchFn()
        .then(data => stravaCache.set(key, { ts: Date.now(), data }))
        .catch(err => console.error('strava background refresh failed:', err.message));
    }
    return;
  }
  try {
    const data = await fetchFn();
    stravaCache.set(key, { ts: Date.now(), data });
    res.json(data);
  } catch (err) {
    console.error('strava fetch failed:', err.message);
    res.status(500).json({ error: err.message });
  }
}

// Reuses the same 'gear' cache entry the /strava/gear route populates,
// rather than a second independent Strava API call — bike maintenance
// status gets checked often (dashboard widget, weekly digest) and Strava's
// app-wide rate limit is easy to exhaust.
async function getBikeGearDistanceKm(bikeId) {
  const hit = stravaCache.get('gear');
  let data = hit && hit.data;
  if (!data || Date.now() - hit.ts >= STRAVA_CACHE_TTL_MS) {
    data = await stravaGet('/athlete').then((a) => ({ bikes: a.bikes || [], shoes: a.shoes || [] }));
    stravaCache.set('gear', { ts: Date.now(), data });
  }
  const bike = (data.bikes || []).find((b) => b.id === bikeId);
  if (!bike) throw new Error(`bike ${bikeId} not found in Strava gear`);
  return bike.distance / 1000;
}

function hms(seconds) {
  if (seconds == null) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
               : `${m}:${String(s).padStart(2, '0')}`;
}

// Trim Strava's verbose activity summary to widget/assistant-friendly fields,
// converting to km/km-h and adding a Berlin-formatted `when`. Units are metric.
function simplifyActivities(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(a => {
    const start = a.start_date ? new Date(a.start_date) : null;
    return {
      id: a.id,
      name: a.name,
      sport_type: a.sport_type || a.type || null,
      start: a.start_date || null,        // UTC ISO
      start_local: a.start_date_local || null,
      when: start ? fmt.format(start) : null,
      distance_km: a.distance != null ? +(a.distance / 1000).toFixed(2) : null,
      moving_time: hms(a.moving_time),
      elapsed_time: hms(a.elapsed_time),
      moving_time_s: a.moving_time ?? null,
      elevation_gain_m: a.total_elevation_gain ?? null,
      avg_speed_kmh: a.average_speed != null ? +(a.average_speed * 3.6).toFixed(2) : null,
      max_speed_kmh: a.max_speed != null ? +(a.max_speed * 3.6).toFixed(2) : null,
      avg_hr: a.average_heartrate ?? null,
      max_hr: a.max_heartrate ?? null,
      avg_watts: a.average_watts ?? null,
      avg_cadence: a.average_cadence ?? null,
      relative_effort: a.suffer_score ?? null, // Strava "Relative Effort" / activity score
      kudos: a.kudos_count ?? null,
      pr_count: a.pr_count ?? null,
      achievement_count: a.achievement_count ?? null,
      gear_id: a.gear_id ?? null,
      is_commute: a.commute ?? null,
      is_trainer: a.trainer ?? null,
    };
  });
}

// Decode a Google/Strava encoded polyline (precision 5) into [lat, lng] pairs.
// https://developers.google.com/maps/documentation/utilities/polylinealgorithm
function decodePolyline(str) {
  if (!str) return null;
  let index = 0, lat = 0, lng = 0;
  const coords = [];
  while (index < str.length) {
    let result = 1, shift = 0, b;
    do {
      b = str.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);

    result = 1;
    shift = 0;
    do {
      b = str.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);

    coords.push([+(lat * 1e-5).toFixed(5), +(lng * 1e-5).toFixed(5)]);
  }
  return coords;
}

// Trim Strava's verbose detailed-activity payload to widget/assistant-friendly
// fields, mirroring simplifyActivities' philosophy (metric units, Berlin
// `when`), extended with the extra detail this endpoint carries: cadence,
// power, effort, elevation range, environment, location, full gear, and route.
// Drops social counters (kudos/comment/photo/athlete_count) and
// account/visibility flags (commute, trainer, manual, flagged, private,
// visibility) - noise for the assistant, not metrics. `route_latlng` decodes
// the compact summary_polyline (not the full-resolution one, which can run to
// thousands of points); laps/segment_efforts/splits pass through as Strava
// shapes them.
function simplifyActivity(a) {
  if (!a || typeof a !== 'object') return a;
  const start = a.start_date ? new Date(a.start_date) : null;
  return {
    id: a.id,
    name: a.name,
    sport_type: a.sport_type || a.type || null,
    start: a.start_date || null,
    start_local: a.start_date_local || null,
    when: start ? fmt.format(start) : null,
    timezone: a.timezone ?? null,

    distance_km: a.distance != null ? +(a.distance / 1000).toFixed(2) : null,
    moving_time: hms(a.moving_time),
    elapsed_time: hms(a.elapsed_time),
    moving_time_s: a.moving_time ?? null,
    elevation_gain_m: a.total_elevation_gain ?? null,
    elev_high_m: a.elev_high ?? null,
    elev_low_m: a.elev_low ?? null,

    avg_speed_kmh: a.average_speed != null ? +(a.average_speed * 3.6).toFixed(2) : null,
    max_speed_kmh: a.max_speed != null ? +(a.max_speed * 3.6).toFixed(2) : null,
    avg_hr: a.average_heartrate ?? null,
    max_hr: a.max_heartrate ?? null,
    avg_watts: a.average_watts ?? null,
    device_watts: a.device_watts ?? null,
    kilojoules: a.kilojoules ?? null,
    avg_cadence: a.average_cadence ?? null,
    calories: a.calories ?? null,

    relative_effort: a.suffer_score ?? null,
    perceived_exertion: a.perceived_exertion ?? null,
    workout_type: a.workout_type ?? null,
    pr_count: a.pr_count ?? null,
    achievement_count: a.achievement_count ?? null,

    avg_temp_c: a.average_temp ?? null,
    device_name: a.device_name ?? null,
    location_city: a.location_city ?? null,
    location_state: a.location_state ?? null,
    location_country: a.location_country ?? null,
    start_latlng: a.start_latlng ?? null,
    end_latlng: a.end_latlng ?? null,

    gear: a.gear ? {
      id: a.gear.id ?? null,
      name: a.gear.name ?? null,
      distance_km: a.gear.distance != null ? +(a.gear.distance / 1000).toFixed(2) : null,
      retired: a.gear.retired ?? null,
    } : (a.gear_id ? { id: a.gear_id } : null),

    map: a.map ? {
      polyline: a.map.polyline ?? null,
      summary_polyline: a.map.summary_polyline ?? null,
      route_latlng: decodePolyline(a.map.summary_polyline),
    } : null,

    laps: a.laps ?? null,
    segment_efforts: a.segment_efforts ?? null,
    splits_metric: a.splits_metric ?? null,
    splits_standard: a.splits_standard ?? null,
  };
}

async function createTask(calUrl, title, startDate, endDate) {
  const uid = 'glance-' + Date.now();
  const now = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VTODO',
    `UID:${uid}`, `SUMMARY:${icsEscape(title)}`, `DTSTAMP:${now}`,
    'STATUS:NEEDS-ACTION',
  ];
  if (startDate) lines.push(icsDateProp('DTSTART', startDate));
  if (endDate) lines.push(icsDateProp('DUE', endDate));
  lines.push('END:VTODO', 'END:VCALENDAR');
  const ics = reconcileTodoDateTypes(lines.join('\r\n'));
  const taskUrl = calUrl.replace('/?export', '') + `/${uid}.ics`;
  const headers = { 'Content-Type': 'text/calendar; charset=utf-8' };
  if (TASKS_USER && TASKS_PASS) {
    headers.Authorization = `Basic ${Buffer.from(`${TASKS_USER}:${TASKS_PASS}`).toString('base64')}`;
  }
  const res = await fetch(taskUrl, { method: 'PUT', headers, body: ics });
  if (!res.ok) throw new Error(`Nextcloud returned ${res.status}`);
  return uid;
}

// Create a VEVENT in the Nextcloud calendar (ICS_URL) via CalDAV PUT.
// start/end: 'YYYY-MM-DD' for an all-day event, or ISO datetime for a timed one.
function icsStamp(d) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

// Resolve the effective due (endDate) for a task from start/end/duration.
// `duration` (minutes) is sugar for a timed block: due = start + duration. It
// requires a timed start and is mutually exclusive with an explicit endDate.
function resolveTaskEnd({ startDate, endDate, duration }) {
  if (duration == null || duration === '') return endDate;
  if (endDate) throw new Error('provide either endDate or duration, not both');
  if (!startDate || /^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    throw new Error('duration requires a timed start (ISO datetime with a time)');
  }
  const s = new Date(startDate);
  const mins = Number(duration);
  if (isNaN(s.getTime())) throw new Error('invalid startDate');
  if (!Number.isFinite(mins) || mins <= 0) throw new Error('duration must be a positive number of minutes');
  return new Date(s.getTime() + mins * 60000).toISOString();
}

// Build a VTODO/VEVENT date property. `val` is either 'YYYY-MM-DD' (all-day,
// VALUE=DATE) or an ISO datetime (timed, written as a UTC stamp).
function icsDateProp(name, val) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(val)) return `${name};VALUE=DATE:${val.replace(/-/g, '')}`;
  const d = new Date(val);
  if (isNaN(d.getTime())) throw new Error(`invalid date/datetime: ${val}`);
  return `${name}:${icsStamp(d)}`;
}

// A parsed all-day date lands on UTC midnight; a timed value does not.
function isAllDay(d) {
  return d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0;
}

// A VTODO requires DTSTART and DUE to share a value type (both DATE or both
// DATE-TIME), or Sabre rejects the PUT with 415. If they differ, upgrade the
// DATE one to a UTC-midnight DATE-TIME: same calendar date, still shows as
// all-day in our display (isAllDay stays true).
function reconcileTodoDateTypes(ics) {
  const get = (n) => (ics.match(new RegExp(`^${n}[;:][^\\r\\n]*`, 'm')) || [])[0];
  const ds = get('DTSTART'), du = get('DUE');
  if (!ds || !du) return ics;
  const isDate = (s) => /;VALUE=DATE:/.test(s);
  if (isDate(ds) === isDate(du)) return ics;
  const upgrade = (line, name) => `${name}:${(line.match(/:(\d{8})/) || [])[1]}T000000Z`;
  if (isDate(ds)) return ics.replace(/^DTSTART[;:][^\r\n]*/m, upgrade(ds, 'DTSTART'));
  return ics.replace(/^DUE[;:][^\r\n]*/m, upgrade(du, 'DUE'));
}

async function createCalEvent(summary, start, end, location, description) {
  if (!CAL_URL) throw new Error('CAL_URL (writable calendar) is not set');
  const uid = 'glance-' + Date.now();
  const now = icsStamp(new Date());
  const allDay = /^\d{4}-\d{2}-\d{2}$/.test(start);
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//glance//EN', 'BEGIN:VEVENT',
    `UID:${uid}`, `DTSTAMP:${now}`, `SUMMARY:${icsEscape(summary)}`,
  ];
  if (allDay) {
    const endDate = end || start;
    lines.push(`DTSTART;VALUE=DATE:${start.replace(/-/g, '')}`);
    lines.push(`DTEND;VALUE=DATE:${endDate.replace(/-/g, '')}`);
  } else {
    const s = new Date(start);
    const e = end ? new Date(end) : new Date(s.getTime() + 60 * 60 * 1000);
    lines.push(`DTSTART:${icsStamp(s)}`);
    lines.push(`DTEND:${icsStamp(e)}`);
  }
  if (location) lines.push(`LOCATION:${icsEscape(location)}`);
  if (description) lines.push(`DESCRIPTION:${icsEscape(description)}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  const ics = lines.join('\r\n');

  const eventUrl = CAL_URL.replace(/\/$/, '') + `/${uid}.ics`;
  const headers = { 'Content-Type': 'text/calendar; charset=utf-8' };
  if (ICS_USER && ICS_PASS) {
    headers.Authorization = `Basic ${Buffer.from(`${ICS_USER}:${ICS_PASS}`).toString('base64')}`;
  }
  const res = await fetch(eventUrl, { method: 'PUT', headers, body: ics });
  if (!res.ok) throw new Error(`Nextcloud returned ${res.status}`);
  return uid;
}

app.post('/ics-events', async (req, res) => {
  try {
    const { summary, start, end, location, description } = req.body;
    if (!summary || !start) return res.status(400).json({ error: 'summary and start required' });
    const uid = await createCalEvent(summary, start, end, location, description);
    invalidateCache(icsCache);
    res.json({ ok: true, uid });
  } catch (err) {
    console.error('create cal event failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

async function completeTask(calUrl, uid) {
  assertUid(uid);
  const baseUrl = calUrl.replace('/?export', '');
  const taskUrl = `${baseUrl}/${uid}.ics`;
  const authHeader = `Basic ${Buffer.from(`${TASKS_USER}:${TASKS_PASS}`).toString('base64')}`;
  const getResp = await fetch(taskUrl, { headers: { Authorization: authHeader } });
  if (!getResp.ok) throw new Error(`GET task failed: ${getResp.status}`);
  const etag = getResp.headers.get('etag');
  let ics = await getResp.text();
  const now = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
  ics = ics.replace(/STATUS:[^\r\n]*/g, 'STATUS:COMPLETED');
  if (!ics.includes('COMPLETED:')) ics = ics.replace('END:VTODO', `COMPLETED:${now}\r\nEND:VTODO`);
  const putResp = await fetch(taskUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8', Authorization: authHeader,
      ...(etag ? { 'If-Match': etag } : {}),
    },
    body: ics,
  });
  if (putResp.status === 412) throw new Error('task was modified concurrently — refetch and retry');
  if (!putResp.ok) throw new Error(`PUT task failed: ${putResp.status}`);
}

async function renameTask(calUrl, uid, newTitle) {
  assertUid(uid);
  const baseUrl = calUrl.replace('/?export', '');
  const taskUrl = `${baseUrl}/${uid}.ics`;
  const authHeader = `Basic ${Buffer.from(`${TASKS_USER}:${TASKS_PASS}`).toString('base64')}`;
  const getResp = await fetch(taskUrl, { headers: { Authorization: authHeader } });
  if (!getResp.ok) throw new Error(`GET task failed: ${getResp.status}`);
  const etag = getResp.headers.get('etag');
  let ics = await getResp.text();
  ics = ics.replace(/SUMMARY:[^\r\n]*/, `SUMMARY:${icsEscape(newTitle)}`);
  const putResp = await fetch(taskUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8', Authorization: authHeader,
      ...(etag ? { 'If-Match': etag } : {}),
    },
    body: ics,
  });
  if (putResp.status === 412) throw new Error('task was modified concurrently — refetch and retry');
  if (!putResp.ok) throw new Error(`PUT task failed: ${putResp.status}`);
}

app.post('/rename-home-task', async (req, res) => {
  try {
    const { uid, newTitle } = req.body;
    if (!uid || !newTitle) return res.status(400).json({ error: 'uid and newTitle required' });
    await renameTask(TASKS_HOME_URL, uid, newTitle);
    invalidateCache(homeTasksCache);
    res.json({ ok: true });
  } catch (err) {
    console.error('rename task failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/rename-work-task', async (req, res) => {
  try {
    const { uid, newTitle } = req.body;
    if (!uid || !newTitle) return res.status(400).json({ error: 'uid and newTitle required' });
    await renameTask(TASKS_WORK_URL, uid, newTitle);
    invalidateCache(workTasksCache);
    res.json({ ok: true });
  } catch (err) {
    console.error('rename task failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/complete-home-task', async (req, res) => {
  try {
    const { uid } = req.body;
    if (!uid) return res.status(400).json({ error: 'uid required' });
    await completeTask(TASKS_HOME_URL, uid);
    invalidateCache(homeTasksCache);
    res.json({ ok: true });
  } catch (err) {
    console.error('complete task failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/complete-work-task', async (req, res) => {
  try {
    const { uid } = req.body;
    if (!uid) return res.status(400).json({ error: 'uid required' });
    await completeTask(TASKS_WORK_URL, uid);
    invalidateCache(workTasksCache);
    res.json({ ok: true });
  } catch (err) {
    console.error('complete task failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/home-tasks', async (req, res) => {
  try {
    const { title, startDate, endDate, duration } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    const uid = await createTask(TASKS_HOME_URL, title, startDate, resolveTaskEnd({ startDate, endDate, duration }));
    invalidateCache(homeTasksCache);
    res.json({ ok: true, uid });
  } catch (err) {
    console.error('create task failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/work-tasks', async (req, res) => {
  try {
    const { title, startDate, endDate, duration } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    const uid = await createTask(TASKS_WORK_URL, title, startDate, resolveTaskEnd({ startDate, endDate, duration }));
    invalidateCache(workTasksCache);
    res.json({ ok: true, uid });
  } catch (err) {
    console.error('create task failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

function createMeetingSoap({ subject, start, end, location, attendees, body }) {
  const attendeeXml = (attendees || []).map(email => `
        <t:Attendee><t:Mailbox><t:EmailAddress>${xmlEscape(email)}</t:EmailAddress></t:Mailbox></t:Attendee>`).join('');

  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">
  <soap:Header>
    <t:RequestServerVersion Version="Exchange2013"/>
  </soap:Header>
  <soap:Body>
    <m:CreateItem SendMeetingInvitations="SendToAllAndSaveCopy">
      <m:SavedItemFolderId>
        <t:DistinguishedFolderId Id="calendar"/>
      </m:SavedItemFolderId>
      <m:Items>
        <t:CalendarItem>
          <t:Subject>${xmlEscape(subject)}</t:Subject>
          ${body ? `<t:Body BodyType="Text">${xmlEscape(body)}</t:Body>` : ''}
          <t:Start>${start}</t:Start>
          <t:End>${end}</t:End>
          ${location ? `<t:Location>${xmlEscape(location)}</t:Location>` : ''}
          ${attendeeXml ? `<t:RequiredAttendees>${attendeeXml}</t:RequiredAttendees>` : ''}
        </t:CalendarItem>
      </m:Items>
    </m:CreateItem>
  </soap:Body>
</soap:Envelope>`;
}

function createMeeting(params) {
  const soap = createMeetingSoap(params);
  return new Promise((resolve, reject) => {
    httpntlm.post({
      url: EWS_URL,
      username: EWS_USER,
      password: EWS_PASS,
      domain: EWS_DOMAIN,
      workstation: '',
      body: soap,
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': '"http://schemas.microsoft.com/exchange/services/2006/messages/CreateItem"',
      },
    }, (err, res) => {
      if (err) return reject(err);
      if (res.statusCode !== 200) {
        return reject(new Error(`EWS returned ${res.statusCode}: ${String(res.body).slice(0, 300)}`));
      }
      if (res.body.includes('ResponseClass="Error"')) {
        const msg = (res.body.match(/<m:MessageText>(.*?)<\/m:MessageText>/) || [])[1] || 'Unknown error';
        return reject(new Error(msg));
      }
      resolve();
    });
  });
}

// --- EWS generic POST + delete (defensive: refuses recurring-series master) -
function ewsPost(soap, action) {
  return new Promise((resolve, reject) => {
    httpntlm.post({
      url: EWS_URL, username: EWS_USER, password: EWS_PASS, domain: EWS_DOMAIN, workstation: '',
      body: soap,
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': `"http://schemas.microsoft.com/exchange/services/2006/messages/${action}"`,
      },
    }, (err, res) => {
      if (err) return reject(err);
      if (res.statusCode !== 200) return reject(new Error(`EWS returned ${res.statusCode}: ${String(res.body).slice(0, 300)}`));
      resolve(String(res.body));
    });
  });
}

// Look up an item's CalendarItemType (Single | Occurrence | Exception | RecurringMaster).
async function ewsCalendarItemType(id) {
  const soap = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">
  <soap:Header><t:RequestServerVersion Version="Exchange2013"/></soap:Header>
  <soap:Body>
    <m:GetItem>
      <m:ItemShape>
        <t:BaseShape>IdOnly</t:BaseShape>
        <t:AdditionalProperties><t:FieldURI FieldURI="calendar:CalendarItemType"/></t:AdditionalProperties>
      </m:ItemShape>
      <m:ItemIds><t:ItemId Id="${xmlEscape(id)}"/></m:ItemIds>
    </m:GetItem>
  </soap:Body>
</soap:Envelope>`;
  const body = await ewsPost(soap, 'GetItem');
  return (body.match(/<t:CalendarItemType>(.*?)<\/t:CalendarItemType>/) || [])[1] || '';
}

// Delete a single Exchange calendar item by ItemId. Deletes by Id only (no
// ChangeKey) to avoid stale-key errors. Refuses a RecurringMaster (the whole
// series) unless allowSeries is explicitly set. Sends cancellations to attendees.
async function deleteExchangeEvent({ id, allowSeries }) {
  if (!id) throw new Error('id is required');
  let type = '';
  try {
    type = await ewsCalendarItemType(id);
  } catch (e) {
    // Fail closed: if allowSeries isn't set, we can't confirm this ISN'T a
    // recurring series master, so refuse rather than silently proceeding as
    // if it were a single occurrence (a transient lookup failure must not
    // downgrade a destructive delete's safety guard). If allowSeries is
    // already true the guard below is moot anyway, so a lookup failure there
    // is genuinely best-effort (only affects the informational `type` in the
    // response).
    if (!allowSeries) {
      const err = new Error(`Could not verify whether this id is a recurring series (lookup failed: ${e.message}). Refusing to delete without confirming — retry, or pass allowSeries:true if you're certain.`);
      err.code = 'SERIES_GUARD_UNVERIFIED';
      throw err;
    }
  }
  if (type === 'RecurringMaster' && !allowSeries) {
    const e = new Error('This id is a recurring SERIES master. Deleting it would remove the whole series. Use a single occurrence id (list_events returns occurrences), or pass allowSeries:true to delete the entire series on purpose.');
    e.code = 'SERIES_GUARD';
    throw e;
  }
  const soap = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">
  <soap:Header><t:RequestServerVersion Version="Exchange2013"/></soap:Header>
  <soap:Body>
    <m:DeleteItem DeleteType="MoveToDeletedItems" SendMeetingCancellations="SendToAllAndSaveCopy">
      <m:ItemIds><t:ItemId Id="${xmlEscape(id)}"/></m:ItemIds>
    </m:DeleteItem>
  </soap:Body>
</soap:Envelope>`;
  const body = await ewsPost(soap, 'DeleteItem');
  if (body.includes('ResponseClass="Error"')) {
    const msg = (body.match(/<m:MessageText>(.*?)<\/m:MessageText>/) || [])[1] || 'Unknown error';
    throw new Error(msg);
  }
  return { deleted: true, type: type || 'unknown' };
}

// Fetch an item's current ChangeKey + CalendarItemType (UpdateItem needs a
// fresh ChangeKey, and we reuse the type for the recurring-series guard).
async function ewsGetItemMeta(id) {
  const soap = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">
  <soap:Header><t:RequestServerVersion Version="Exchange2013"/></soap:Header>
  <soap:Body>
    <m:GetItem>
      <m:ItemShape>
        <t:BaseShape>IdOnly</t:BaseShape>
        <t:AdditionalProperties><t:FieldURI FieldURI="calendar:CalendarItemType"/></t:AdditionalProperties>
      </m:ItemShape>
      <m:ItemIds><t:ItemId Id="${xmlEscape(id)}"/></m:ItemIds>
    </m:GetItem>
  </soap:Body>
</soap:Envelope>`;
  const body = await ewsPost(soap, 'GetItem');
  const idm = body.match(/<t:ItemId Id="([^"]*)"(?:\s+ChangeKey="([^"]*)")?/);
  return {
    id: idm ? idm[1] : id,
    changeKey: idm ? (idm[2] || '') : '',
    type: (body.match(/<t:CalendarItemType>(.*?)<\/t:CalendarItemType>/) || [])[1] || '',
  };
}

// Move an Exchange calendar item to a new start/end via UpdateItem. Refuses a
// recurring SERIES master unless allowSeries; moving a single occurrence id
// only shifts that instance. Notifies attendees of the change.
async function rescheduleExchangeEvent({ id, start, end, allowSeries }) {
  if (!id) throw new Error('id is required');
  if (!start || !end) throw new Error('start and end are required (ISO 8601 with offset)');
  const meta = await ewsGetItemMeta(id);
  if (meta.type === 'RecurringMaster' && !allowSeries) {
    const e = new Error('This id is a recurring SERIES master. Moving it would shift the whole series. Use a single occurrence id, or pass allowSeries:true on purpose.');
    e.code = 'SERIES_GUARD';
    throw e;
  }
  const startIso = new Date(start).toISOString();
  const endIso = new Date(end).toISOString();
  const idXml = meta.changeKey ? `<t:ItemId Id="${xmlEscape(meta.id)}" ChangeKey="${xmlEscape(meta.changeKey)}"/>` : `<t:ItemId Id="${xmlEscape(meta.id)}"/>`;
  const soap = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">
  <soap:Header><t:RequestServerVersion Version="Exchange2013"/></soap:Header>
  <soap:Body>
    <m:UpdateItem ConflictResolution="AutoResolve" MessageDisposition="SendAndSaveCopy" SendMeetingInvitationsOrCancellations="SendToAllAndSaveCopy">
      <m:ItemChanges>
        <t:ItemChange>
          ${idXml}
          <t:Updates>
            <t:SetItemField>
              <t:FieldURI FieldURI="calendar:Start"/>
              <t:CalendarItem><t:Start>${startIso}</t:Start></t:CalendarItem>
            </t:SetItemField>
            <t:SetItemField>
              <t:FieldURI FieldURI="calendar:End"/>
              <t:CalendarItem><t:End>${endIso}</t:End></t:CalendarItem>
            </t:SetItemField>
          </t:Updates>
        </t:ItemChange>
      </m:ItemChanges>
    </m:UpdateItem>
  </soap:Body>
</soap:Envelope>`;
  const body = await ewsPost(soap, 'UpdateItem');
  if (body.includes('ResponseClass="Error"')) {
    const msg = (body.match(/<m:MessageText>(.*?)<\/m:MessageText>/) || [])[1] || 'Unknown error';
    throw new Error(msg);
  }
  return { rescheduled: true, type: meta.type || 'unknown', start: startIso, end: endIso };
}

// --- EWS ResolveNames: directory/contact lookup for meeting attendees -------
function xmlEscape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}
function decodeXml(s) {
  return String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'");
}
function buildResolveNamesSoap(query) {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">
  <soap:Header>
    <t:RequestServerVersion Version="Exchange2013"/>
  </soap:Header>
  <soap:Body>
    <m:ResolveNames ReturnFullContactData="true" SearchScope="ActiveDirectoryContacts">
      <m:UnresolvedEntry>${xmlEscape(query)}</m:UnresolvedEntry>
    </m:ResolveNames>
  </soap:Body>
</soap:Envelope>`;
}

// Pull SMTP address + name from each <t:Resolution>. AD entries often expose a
// legacy EX address on the Mailbox, so fall back to the Contact's SMTP entries.
function parseResolveNames(xml) {
  const out = [];
  const resolutions = String(xml).match(/<t:Resolution>[\s\S]*?<\/t:Resolution>/g) || [];
  for (const r of resolutions) {
    const pick = (re) => { const m = r.match(re); return m ? m[1].trim() : ''; };
    // Prefer the contact display name ("Doe, Jane"); the mailbox Name is
    // often just the login alias at the organization.
    const name = pick(/<t:DisplayName>([\s\S]*?)<\/t:DisplayName>/) || pick(/<t:Mailbox>[\s\S]*?<t:Name>([\s\S]*?)<\/t:Name>/);
    const routing = pick(/<t:RoutingType>([\s\S]*?)<\/t:RoutingType>/);
    const mboxAddr = pick(/<t:Mailbox>[\s\S]*?<t:EmailAddress>([\s\S]*?)<\/t:EmailAddress>/);
    let email = routing === 'SMTP' && /@/.test(mboxAddr) ? mboxAddr : '';
    if (!email) {
      // scan the Contact's EmailAddresses entries for an SMTP-looking value
      const entries = r.match(/<t:Entry[^>]*>([\s\S]*?)<\/t:Entry>/g) || [];
      for (const e of entries) {
        const v = (e.match(/>([^<]*)</) || [])[1] || '';
        const addr = v.replace(/^SMTP:/i, '').trim();
        if (/@/.test(addr)) { email = addr; break; }
      }
    }
    if (!email) continue;
    const phoneOf = (key) => pick(new RegExp(`<t:Entry Key="${key}">([\\s\\S]*?)<\\/t:Entry>`));
    out.push({
      email: decodeXml(email),
      name: decodeXml(name),
      department: decodeXml(pick(/<t:Department>([\s\S]*?)<\/t:Department>/)),
      office: decodeXml(pick(/<t:OfficeLocation>([\s\S]*?)<\/t:OfficeLocation>/)),
      phone: decodeXml(phoneOf('BusinessPhone')),
      mobile: decodeXml(phoneOf('MobilePhone')),
    });
  }
  // dedupe by email, keep first
  const seen = new Set();
  return out.filter((x) => { const k = x.email.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

function resolveNames(query) {
  const soap = buildResolveNamesSoap(query);
  return new Promise((resolve, reject) => {
    httpntlm.post({
      url: EWS_URL, username: EWS_USER, password: EWS_PASS, domain: EWS_DOMAIN, workstation: '',
      body: soap,
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': '"http://schemas.microsoft.com/exchange/services/2006/messages/ResolveNames"',
      },
    }, (err, res) => {
      if (err) return reject(err);
      if (res.statusCode !== 200) return reject(new Error(`EWS returned ${res.statusCode}: ${String(res.body).slice(0, 300)}`));
      // ErrorNameResolutionNoResults is a normal "no matches" outcome, not a failure.
      if (/ErrorNameResolutionNoResults/.test(res.body)) return resolve([]);
      if (res.body.includes('ResponseClass="Error"')) {
        const msg = (res.body.match(/<m:MessageText>(.*?)<\/m:MessageText>/) || [])[1] || 'Unknown error';
        return reject(new Error(msg));
      }
      resolve(parseResolveNames(res.body));
    });
  });
}

// Search the directory + contacts for people to invite (returns email first).
// nginx strips the /ews-api/ prefix, so this is reached as /ews-api/resolve-attendees
// externally and /resolve-attendees internally (MCP).
app.get('/resolve-attendees', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.status(400).json({ error: 'q must be at least 2 characters' });
  if (!EWS_URL) return res.status(503).json({ error: 'EWS not configured' });
  try {
    res.json({ query: q, matches: await resolveNames(q) });
  } catch (e) {
    console.error('resolve-attendees failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/meetings', async (req, res) => {
  try {
    const { subject, start, end, location, attendees, body } = req.body;
    if (!subject || !start || !end) return res.status(400).json({ error: 'subject, start and end are required' });
    await createMeeting({ subject, start, end, location, attendees, body });
    invalidateCache(ewsCache);
    res.json({ ok: true });
  } catch (err) {
    console.error('create meeting failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Delete an Exchange (work) event by EWS itemId (from /events, field "id").
// Refuses a recurring series master unless allowSeries:true. Body: {id, allowSeries?}
app.post('/delete-exchange-event', async (req, res) => {
  try {
    const { id, allowSeries } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id is required' });
    const r = await deleteExchangeEvent({ id, allowSeries: !!allowSeries });
    invalidateCache(ewsCache);
    res.json({ ok: true, ...r });
  } catch (e) {
    console.error('delete exchange event failed:', e.message);
    res.status(e.code === 'SERIES_GUARD' ? 409 : 500).json({ error: e.message, code: e.code });
  }
});

// Move an Exchange (work) event to a new start/end by EWS itemId.
// Body: {id, start, end, allowSeries?}. ISO 8601 with offset.
app.post('/reschedule-exchange-event', async (req, res) => {
  try {
    const { id, start, end, allowSeries } = req.body || {};
    if (!id || !start || !end) return res.status(400).json({ error: 'id, start and end are required' });
    const r = await rescheduleExchangeEvent({ id, start, end, allowSeries: !!allowSeries });
    invalidateCache(ewsCache);
    res.json({ ok: true, ...r });
  } catch (e) {
    console.error('reschedule exchange event failed:', e.message);
    res.status(e.code === 'SERIES_GUARD' ? 409 : 500).json({ error: e.message, code: e.code });
  }
});

// ---- Daily email digest ----------------------------------------------------

const berlinDay = (d) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: DIGEST_TZ }).format(new Date(d));

// Weather feature module (routes registered below; weatherForRequest is reused
// by the digest and plan-day).
const weather = require('./lib/weather')({ berlinDay });
weather.register(app);
const weatherForRequest = weather.weatherForRequest;

// Nextcloud Deck (kanban) read layer, reused by the weekly digest and MCP.
const deck = require('./lib/deck');

// Bike maintenance tracking (km/day-based reminders), reused by the weekly
// digest and MCP. Registers its own /bike/* routes.
const bikeMaintenance = require('./lib/bikeMaintenance')({ getGearDistanceKm: getBikeGearDistanceKm });
bikeMaintenance.register(app);

// Garmin Connect: push structured training-session workouts. Registers its
// own /garmin/* routes.
const garmin = require('./lib/garmin');
garmin.register(app);

// SiYuan Note read-only search (RAG-style knowledge base lookup).
const siyuan = require('./lib/siyuan');

// Local semantic (embedding) search over the same RAG notebook.
const embeddings = require('./lib/embeddings');

app.get('/siyuan/notes', async (_req, res) => {
  try {
    res.json({ notes: await siyuan.listAllNotes() });
  } catch (e) {
    console.error('siyuan list notes failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/siyuan/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'q required' });
    const limit = parseInt(req.query.limit, 10) || 10;
    res.json({ query: q, results: await siyuan.searchNotes(q, limit) });
  } catch (e) {
    console.error('siyuan search failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/siyuan/note', async (req, res) => {
  try {
    const id = String(req.query.id || '').trim();
    if (!id) return res.status(400).json({ error: 'id required' });
    res.json(await siyuan.getNote(id));
  } catch (e) {
    console.error('siyuan get note failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/siyuan/note', async (req, res) => {
  try {
    const { title, markdown, parentDocId } = req.body || {};
    if (!title) return res.status(400).json({ error: 'title required' });
    const result = await siyuan.createNote(title, markdown, parentDocId);
    res.json({ ok: true, ...result });
    // Fire-and-forget: index the new note for semantic search without
    // delaying the response or failing the create if embedding errors.
    embeddings.upsertNoteEmbedding(result.docId, title)
      .catch((e) => console.error(`embeddings upsert failed for ${result.docId}:`, e.message));
  } catch (e) {
    console.error('siyuan create note failed:', e.message);
    res.status(400).json({ error: e.message });
  }
});

app.post('/siyuan/move-note', async (req, res) => {
  try {
    const { docId, parentDocId } = req.body || {};
    if (!docId) return res.status(400).json({ error: 'docId required' });
    res.json({ ok: true, ...(await siyuan.moveNote(docId, parentDocId)) });
  } catch (e) {
    console.error('siyuan move note failed:', e.message);
    res.status(400).json({ error: e.message });
  }
});

app.post('/siyuan/update-note', async (req, res) => {
  try {
    const { docId, markdown, title, mode } = req.body || {};
    if (!docId || markdown == null) return res.status(400).json({ error: 'docId and markdown required' });
    if (mode && mode !== 'replace' && mode !== 'append') return res.status(400).json({ error: 'mode must be "replace" or "append"' });
    const result = await siyuan.updateNote(docId, markdown, title, mode);
    res.json({ ok: true, ...result });
    // Re-embed from the note's fresh full content (not just the submitted
    // body, which in "append" mode is only the added chunk).
    embeddings.upsertNoteEmbedding(docId, title)
      .catch((e) => console.error(`embeddings upsert failed for ${docId}:`, e.message));
  } catch (e) {
    console.error('siyuan update note failed:', e.message);
    res.status(400).json({ error: e.message });
  }
});

app.post('/siyuan/delete-note', async (req, res) => {
  try {
    const { docId } = req.body || {};
    if (!docId) return res.status(400).json({ error: 'docId required' });
    const result = await siyuan.deleteNote(docId);
    res.json(result);
    try { embeddings.removeNoteEmbedding(docId); }
    catch (e) { console.error(`embeddings delete failed for ${docId}:`, e.message); }
  } catch (e) {
    console.error('siyuan delete note failed:', e.message);
    res.status(400).json({ error: e.message });
  }
});

app.get('/siyuan/note-attrs', async (req, res) => {
  try {
    const id = String(req.query.id || '').trim();
    if (!id) return res.status(400).json({ error: 'id required' });
    res.json(await siyuan.getNoteAttrs(id));
  } catch (e) {
    console.error('siyuan get note attrs failed:', e.message);
    res.status(400).json({ error: e.message });
  }
});

// Notes that link to this one via SiYuan's own block-reference syntax
// (((docId 'text'))), not a text/keyword match — real backlinks.
app.get('/siyuan/backlinks', async (req, res) => {
  try {
    const id = String(req.query.id || '').trim();
    if (!id) return res.status(400).json({ error: 'id required' });
    res.json({ docId: id, backlinks: await siyuan.getBacklinks(id) });
  } catch (e) {
    console.error('siyuan get backlinks failed:', e.message);
    res.status(400).json({ error: e.message });
  }
});

app.post('/siyuan/note-attrs', async (req, res) => {
  try {
    const { docId, attrs } = req.body || {};
    if (!docId || !attrs || typeof attrs !== 'object') return res.status(400).json({ error: 'docId and attrs required' });
    res.json({ ok: true, ...(await siyuan.setNoteAttrs(docId, attrs)) });
  } catch (e) {
    console.error('siyuan set note attrs failed:', e.message);
    res.status(400).json({ error: e.message });
  }
});

// Meaning-based search over the same RAG notebook (embeddings, not
// keywords) — complements /siyuan/search for conceptual/paraphrased or
// cross-language (German/English) matches full-text search would miss.
app.get('/siyuan/semantic-search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'q required' });
    const limit = parseInt(req.query.limit, 10) || 10;
    const minScore = req.query.minScore != null ? parseFloat(req.query.minScore) : undefined;
    res.json({ query: q, results: await embeddings.semanticSearch(q, limit, minScore) });
  } catch (e) {
    console.error('siyuan semantic search failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Default entry point for most searches: fuses full-text (searchNotes) and
// semantic (semanticSearch) results via reciprocal rank fusion, so an exact
// term/ID and a paraphrased/conceptual match both surface without the
// caller having to guess which mode fits a given query up front. See
// lib/embeddings.js hybridSearch for the fusion method.
app.get('/siyuan/hybrid-search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'q required' });
    const limit = parseInt(req.query.limit, 10) || 10;
    const minScore = req.query.minScore != null ? parseFloat(req.query.minScore) : undefined;
    res.json({ query: q, results: await embeddings.hybridSearch(q, limit, minScore) });
  } catch (e) {
    console.error('siyuan hybrid search failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Manual trigger to reconcile the embeddings index against the notebook's
// current state (see lib/embeddings.js syncEmbeddings for what this covers).
app.post('/siyuan/embeddings-sync', async (req, res) => {
  try {
    res.json({ ok: true, ...(await embeddings.syncEmbeddings(!!(req.body && req.body.full))) });
  } catch (e) {
    console.error('siyuan embeddings sync failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

const fmtTime = new Intl.DateTimeFormat('de-DE', {
  timeZone: DIGEST_TZ, hour: '2-digit', minute: '2-digit',
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Small colored tag for the calendar an event belongs to.
function calBadge(cal) {
  const c = cal === 'Arbeit' ? ['#eff6ff', '#2563eb'] : ['#ecfdf5', '#059669'];
  return `<span style="display:inline-block;margin-left:8px;padding:1px 8px;border-radius:10px;font-size:11px;background:${c[0]};color:${c[1]};vertical-align:1px;">${cal}</span>`;
}

// Render an event's location: a clickable join link for URLs (e.g. Zoom),
// plain text for a physical room.
function renderLocation(loc) {
  if (!loc) return '';
  if (/^https?:\/\//i.test(loc)) {
    const label = /zoom/i.test(loc) ? 'Zoom beitreten' : 'Link öffnen';
    return `<br><a href="${escapeHtml(loc)}" style="color:#2563eb;font-size:13px;">${label}</a>`;
  }
  return `<br><span style="color:#888;font-size:13px;">Ort: ${escapeHtml(loc)}</span>`;
}

// Gather a given day's events (work + home) and all open tasks. Defaults to
// today (Berlin). Each source is fetched best-effort so one backend failing
// does not kill the whole digest.
async function buildDigestData(targetDay) {
  const day = targetDay || berlinDay(new Date());
  // Use a full-day range (incl. past events) so the mail shows ALL of the day's
  // appointments regardless of send time, not just the ones still upcoming.
  const dayStart = new Date(`${day}T00:00:00`);
  const dayEnd = new Date(dayStart.getTime() + 86400000);
  const [ews, ics, homeTasks, workTasks] = await Promise.all([
    EWS_URL ? fetchEwsRange(dayStart, dayEnd).catch(() => []) : Promise.resolve([]),
    ICS_URL ? fetchIcsRange(dayStart, dayEnd).catch(() => []) : Promise.resolve([]),
    TASKS_HOME_URL ? fetchTasks(TASKS_HOME_URL).catch(() => []) : Promise.resolve([]),
    TASKS_WORK_URL ? fetchTasks(TASKS_WORK_URL).catch(() => []) : Promise.resolve([]),
  ]);
  const events = [
    ...ews.filter((e) => berlinDay(e.start) === day).map((e) => ({ ...e, cal: 'Arbeit' })),
    ...ics.filter((e) => berlinDay(e.start) === day).map((e) => ({ ...e, cal: 'Privat' })),
  ].sort((a, b) => new Date(a.start) - new Date(b.start));
  // Strava recap of the day before (so the morning mail shows yesterday's training).
  const strava = await buildStravaWeekRecap(new Date(dayStart.getTime() - 86400000), dayStart);
  const weather = await weatherForRequest(day).catch((e) => {
    console.error(`digest weather for ${day} failed:`, e.message);
    return null;
  });
  return { day, events, homeTasks, workTasks, strava, weather };
}

// Strava training recap block for the weekly digest (Strava orange accent).
function renderStravaSection(recap, heading) {
  if (!recap) return '';
  const title = heading || 'Letzte Woche Training &middot; Strava';
  const stat = (v, l) =>
    `<td style="text-align:center;padding:4px 6px;"><div style="font-size:20px;font-weight:700;color:#111827;">${v}</div><div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;">${l}</div></td>`;
  const rows = recap.activities.length
    ? recap.activities.map((a) => `
        <tr>
          <td style="padding:6px 10px 6px 0;white-space:nowrap;color:#fc4c02;font-weight:600;font-size:13px;vertical-align:top;">${escapeHtml(a.when || '')}</td>
          <td style="padding:6px 0;vertical-align:top;border-bottom:1px solid #f3f4f6;">
            <a href="https://www.strava.com/activities/${a.id}" style="font-weight:600;color:#fc4c02;text-decoration:underline;">${escapeHtml(a.name)}</a>
            <span style="color:#6b7280;font-size:13px;"> ${escapeHtml(a.sport_type || '')}${a.distance_km ? ` &middot; ${a.distance_km} km` : ''}${a.moving_time ? ` &middot; ${escapeHtml(a.moving_time)}` : ''}${a.relative_effort ? ` &middot; Score ${a.relative_effort}` : ''}${a.pr_count ? ` &middot; 🏅${a.pr_count}` : ''}</span>
          </td>
        </tr>`).join('')
    : '<tr><td colspan="2" style="padding:7px 0;color:#cbd5e1;font-style:italic;">Keine Aktivitäten.</td></tr>';
  return `
    <div style="font-size:12px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#fc4c02;margin-top:22px;padding-bottom:5px;border-bottom:2px solid #fde4d8;">${title}</div>
    <table style="width:100%;border-collapse:collapse;margin-top:8px;"><tbody><tr>
      ${stat(recap.count, 'Akt.')}${stat(recap.km + ' km', 'Distanz')}${stat(recap.hours + ' h', 'Zeit')}${stat(recap.effort, 'Score')}${stat(recap.elevation_m + ' m', 'Höhe')}
    </tr></tbody></table>
    <table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:6px;"><tbody>${rows}</tbody></table>`;
}

// Compact weather banner for the daily digest (today's forecast).
function renderWeatherSection(w) {
  if (!w) return '';
  const hrs = (w.hourly || []).map((h) =>
    `<td style="text-align:center;padding:2px 8px;"><div style="font-size:12px;color:#6b7280;">${h.time}</div><div style="font-size:15px;font-weight:600;color:#111827;">${h.temp}°</div>${h.precipProb != null ? `<div style="font-size:11px;color:#2563eb;">${h.precipProb}%</div>` : ''}</td>`).join('');
  return `
    <table style="width:100%;border-collapse:collapse;margin-top:14px;background:#f8fafc;border-radius:10px;" cellpadding="0" cellspacing="0"><tbody><tr>
      <td style="width:48px;padding:12px 10px 12px 16px;font-size:34px;line-height:1;vertical-align:middle;">${w.emoji}</td>
      <td style="padding:12px 16px 12px 0;vertical-align:middle;">
        ${w.place ? `<div style="font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;">${escapeHtml(w.place)}</div>` : ''}
        <div style="font-size:15px;font-weight:700;color:#111827;">${w.tempMax}° / ${w.tempMin}° &middot; ${escapeHtml(w.text)}</div>
        <div style="font-size:12px;color:#6b7280;margin-top:2px;">${w.precipProb != null ? `Regen ${w.precipProb}% &middot; ` : ''}${w.precip} mm &middot; Wind ${w.windMax} km/h${w.sunrise ? ` &middot; ☀ ${w.sunrise}–${w.sunset}` : ''}</div>
      </td>
    </tr></tbody></table>
    ${hrs ? `<table style="width:100%;border-collapse:collapse;margin-top:6px;"><tbody><tr>${hrs}</tr></tbody></table>` : ''}`;
}

function digestSectionHeader(label, color) {
  return `<div style="font-size:12px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:${color || '#6b7280'};margin-top:22px;padding-bottom:5px;border-bottom:2px solid #e5e7eb;">${label}</div>`;
}

// Weekly training insight: ACWR status, YTD goal pace, and PR count. Rendered
// under the Strava recap block in the weekly digest.
function renderTrainingSummary(load, ytd, strava) {
  const bits = [];
  if (load && load.ratio != null) {
    bits.push(`<div style="margin:6px 0;">Trainingsbelastung: <b style="color:${load.color};">${load.status}</b> <span style="color:#6b7280;">(ACWR ${load.ratio})</span></div>`);
  }
  const prs = strava && strava.activities ? strava.activities.reduce((n, a) => n + (a.pr_count || 0), 0) : 0;
  if (prs > 0) bits.push(`<div style="margin:6px 0;">🏅 ${prs} neue Bestleistung${prs === 1 ? '' : 'en'} letzte Woche</div>`);
  if (ytd && ytd.sports) {
    const dayOfYear = Math.floor((Date.now() - Date.UTC(new Date().getUTCFullYear(), 0, 0)) / 86400000);
    for (const s of ytd.sports) {
      if (!s.goalKm) continue;
      const expected = s.goalKm * (dayOfYear / 365);
      const ahead = s.km - expected;
      const onPace = ahead >= 0;
      bits.push(`<div style="margin:6px 0;">${escapeHtml(s.label)}: ${s.km} / ${s.goalKm} km <span style="color:${onPace ? '#059669' : '#d97706'};">(${onPace ? '+' : ''}${Math.round(ahead)} km vs. Ziel-Tempo)</span></div>`);
    }
  }
  if (!bits.length) return '';
  return `
    <div style="font-size:12px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#fc4c02;margin-top:22px;padding-bottom:5px;border-bottom:2px solid #fde4d8;">Trainingsüberblick</div>
    <div style="font-size:14px;margin-top:8px;">${bits.join('')}</div>`;
}

function digestTaskList(tasks) {
  return tasks.length
    ? `<ul style="margin:8px 0 0;padding-left:20px;font-size:14px;">${tasks.map((t) =>
        `<li style="margin:4px 0;">${escapeHtml(t.title)}${t.due ? ` <span style="color:#9ca3af;font-size:12px;">fällig ${escapeHtml(t.due)}</span>` : ''}</li>`).join('')}</ul>`
    : '<p style="margin:8px 0 0;color:#9ca3af;font-size:14px;">Keine offenen Aufgaben.</p>';
}

function renderDigestHtml({ day, events, homeTasks, workTasks, strava, weather }) {
  // Anchor the label to noon on the target day so the formatted weekday/date
  // is correct regardless of UTC offset.
  const labelDate = day ? new Date(`${day}T12:00:00`) : new Date();
  const dateLabel = new Intl.DateTimeFormat('de-DE', {
    timeZone: DIGEST_TZ, weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
  }).format(labelDate);

  const eventRows = events.length
    ? events.map((e) => `
        <tr>
          <td style="padding:7px 14px 7px 0;white-space:nowrap;color:#2563eb;font-weight:600;font-size:13px;vertical-align:top;width:48px;">${fmtTime.format(new Date(e.start))}</td>
          <td style="padding:7px 0;vertical-align:top;border-bottom:1px solid #f3f4f6;">
            <span style="font-weight:600;color:#111827;">${escapeHtml(e.title)}</span>${calBadge(e.cal)}${renderLocation(e.location)}
          </td>
        </tr>`).join('')
    : '<tr><td colspan="2" style="padding:7px 0;color:#cbd5e1;font-style:italic;">Keine Termine.</td></tr>';

  return `<!doctype html><html><body style="margin:0;background:#f3f4f6;padding:16px 0;">
    <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2937;max-width:640px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);">
      <div style="background:#1f2937;color:#ffffff;padding:22px 26px;">
        <div style="font-size:21px;font-weight:700;">Dein Tag</div>
        <div style="font-size:13px;color:#9ca3af;margin-top:3px;">${dateLabel} &middot; ${events.length} Termine &middot; ${workTasks.length + homeTasks.length} Aufgaben</div>
      </div>
      <div style="padding:6px 26px 26px;">
        ${renderWeatherSection(weather)}
        ${digestSectionHeader('Termine')}
        <table style="width:100%;border-collapse:collapse;font-size:14px;"><tbody>${eventRows}</tbody></table>
        ${renderStravaSection(strava, 'Gestern Training &middot; Strava')}
        ${digestSectionHeader('Aufgaben &middot; Arbeit')}
        ${digestTaskList(workTasks)}
        ${digestSectionHeader('Aufgaben &middot; Privat')}
        ${digestTaskList(homeTasks)}
        <p style="margin-top:26px;color:#cbd5e1;font-size:11px;">Automatisch erstellt von Glance.</p>
      </div>
    </div>
  </body></html>`;
}

let mailer = null;
function getMailer() {
  if (!SMTP_HOST) throw new Error('SMTP_HOST is not set');
  if (!mailer) {
    mailer = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
    });
  }
  return mailer;
}

// opts: { day?: 'YYYY-MM-DD' (default today), preview?: bool (build HTML, don't send) }
async function sendDigest(opts = {}) {
  const data = await buildDigestData(opts.day);
  const html = renderDigestHtml(data);
  const subject = `Dein Tag, ${new Intl.DateTimeFormat('de-DE', {
    timeZone: DIGEST_TZ, weekday: 'short', day: '2-digit', month: '2-digit',
  }).format(new Date(`${data.day}T12:00:00`))} (${data.events.length} Termine, ${data.workTasks.length + data.homeTasks.length} Aufgaben)`;
  if (opts.preview) {
    return { preview: true, day: data.day, subject, html,
      counts: { events: data.events.length, tasks: data.workTasks.length + data.homeTasks.length } };
  }
  if (!DIGEST_TO) throw new Error('DIGEST_TO is not set');
  const info = await getMailer().sendMail({ from: SMTP_FROM, to: DIGEST_TO, subject, html, priority: DIGEST_PRIORITY });
  return { messageId: info.messageId, accepted: info.accepted };
}

// Monday-anchored week window containing the reference day (default today).
function weekWindow(refDay) {
  const base = new Date(`${refDay || berlinDay(new Date())}T00:00:00`);
  const dow = base.getDay(); // 0=Sun..6=Sat, in container TZ (Berlin)
  const monday = new Date(base.getTime() + (dow === 0 ? -6 : 1 - dow) * 86400000);
  monday.setHours(0, 0, 0, 0);
  return { start: monday, end: new Date(monday.getTime() + 7 * 86400000) };
}

async function buildWeeklyData(refDay) {
  const { start, end } = weekWindow(refDay);
  const [ews, ics, homeDetailed, workDetailed, deckCards, bikeItems] = await Promise.all([
    EWS_URL ? fetchEwsRange(start, end).catch(() => []) : Promise.resolve([]),
    ICS_URL ? fetchIcsRange(start, end).catch(() => []) : Promise.resolve([]),
    TASKS_HOME_URL ? fetchTasksDetailed(TASKS_HOME_URL).catch(() => []) : Promise.resolve([]),
    TASKS_WORK_URL ? fetchTasksDetailed(TASKS_WORK_URL).catch(() => []) : Promise.resolve([]),
    deck.configured() ? deck.cardsDue(end.toISOString()).catch(() => []) : Promise.resolve([]),
    bikeMaintenance.getStatus().catch(() => []),
  ]);
  const events = [
    ...ews.map((e) => ({ ...e, cal: 'Arbeit' })),
    ...ics.map((e) => ({ ...e, cal: 'Privat' })),
  ].sort((a, b) => new Date(a.start) - new Date(b.start));
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start.getTime() + i * 86400000);
    const key = berlinDay(d);
    days.push({ key, date: d, events: events.filter((e) => berlinDay(e.start) === key) });
  }
  // Per-day forecast for the day headers. Days outside the 7-day forecast
  // window (e.g. when previewing a past week) resolve to null and are skipped.
  await Promise.all(days.map(async (d) => {
    d.weather = await weatherForRequest(d.key).catch((e) => {
      console.error(`weekly digest weather for ${d.key} failed:`, e.message);
      return null;
    });
  }));
  const strava = await buildStravaWeekRecap(
    new Date(start.getTime() - 7 * 86400000),
    new Date(end.getTime() - 7 * 86400000),
  );
  // Training context for the summary block: current load and YTD goal pace.
  const [load, ytd] = await Promise.all([
    buildStravaLoad().catch(() => null),
    buildStravaYtd().catch(() => null),
  ]);

  // Keep the task + Deck blocks focused: only what is overdue or due within
  // this week's window (drops undated and far-future items that were noise).
  const todayStart = new Date(`${berlinDay(new Date())}T00:00:00`);
  const fmtDue = (iso) => { const d = new Date(iso); return (isAllDay(d) ? fmtDateOnly : fmt).format(d); };
  const dueThisWeek = (list) => list
    .filter((t) => t.due && new Date(t.due) < end)
    .sort((a, b) => new Date(a.due) - new Date(b.due))
    .map((t) => ({ title: t.title, due: fmtDue(t.due), overdue: new Date(t.due) < todayStart }));
  const homeTasks = dueThisWeek(homeDetailed);
  const workTasks = dueThisWeek(workDetailed);
  const deckDue = deckCards.map((c) => ({
    title: c.title, board: c.board, stack: c.stack,
    due: fmtDue(c.due), overdue: new Date(c.due) < todayStart,
  }));
  // Keep this lean too: only surface items that actually need attention,
  // not the whole maintenance list every week.
  const bikeDue = bikeItems.filter((it) => it.status !== 'Bereit zum Fahren');

  return { start, end, days, homeTasks, workTasks, deck: deckDue, bike: bikeDue, strava, load, ytd };
}

function renderWeeklyHtml({ start, end, days, homeTasks, workTasks, deck = [], bike = [], strava, load, ytd }) {
  const dayHdrFmt = new Intl.DateTimeFormat('de-DE', { timeZone: DIGEST_TZ, weekday: 'long', day: '2-digit', month: '2-digit' });
  const rangeFmt = new Intl.DateTimeFormat('de-DE', { timeZone: DIGEST_TZ, day: '2-digit', month: '2-digit' });
  const lastDay = new Date(end.getTime() - 86400000);
  const eventCount = days.reduce((n, d) => n + d.events.length, 0);
  const taskCount = workTasks.length + homeTasks.length;
  const todayKey = berlinDay(new Date());

  const badge = calBadge;

  const dayBlocks = days.map((d) => {
    const isToday = d.key === todayKey;
    // Compact forecast on the right of the day header (empty if unavailable).
    const wx = d.weather
      ? `<span style="float:right;font-weight:600;color:#6b7280;text-transform:none;letter-spacing:0;">${d.weather.emoji} ${d.weather.tempMax}&deg;/${d.weather.tempMin}&deg;${d.weather.precipProb ? ` &middot; ☂ ${d.weather.precipProb}%` : ''}</span>`
      : '';
    const rows = d.events.length
      ? d.events.map((e) => `
          <tr>
            <td style="padding:7px 14px 7px 0;white-space:nowrap;color:#2563eb;font-weight:600;font-size:13px;vertical-align:top;width:48px;">${fmtTime.format(new Date(e.start))}</td>
            <td style="padding:7px 0;vertical-align:top;border-bottom:1px solid #f3f4f6;">
              <span style="font-weight:600;color:#111827;">${escapeHtml(e.title)}</span>${badge(e.cal)}${renderLocation(e.location)}
            </td>
          </tr>`).join('')
      : '<tr><td colspan="2" style="padding:7px 0;color:#cbd5e1;font-style:italic;border-bottom:1px solid #f3f4f6;">frei</td></tr>';
    return `
      <div style="margin-top:20px;">
        <div style="font-size:12px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:${isToday ? '#2563eb' : '#6b7280'};padding-bottom:5px;border-bottom:2px solid ${isToday ? '#bfdbfe' : '#e5e7eb'};">
          ${wx}${dayHdrFmt.format(d.date)}${isToday ? ' &middot; heute' : ''}
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:14px;"><tbody>${rows}</tbody></table>
      </div>`;
  }).join('');

  const dueTag = (overdue, due) =>
    `<span style="color:${overdue ? '#dc2626' : '#9ca3af'};font-size:12px;">${overdue ? 'überfällig' : 'fällig'} ${escapeHtml(due)}</span>`;

  // Tasks are pre-filtered to due/overdue this week, so every item has a date.
  const taskSection = (label, tasks) => `
    <div style="font-size:12px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#6b7280;margin-top:22px;padding-bottom:5px;border-bottom:2px solid #e5e7eb;">${label}</div>
    ${tasks.length
      ? `<ul style="margin:8px 0 0;padding-left:20px;font-size:14px;">${tasks.map((t) =>
          `<li style="margin:4px 0;">${escapeHtml(t.title)} ${dueTag(t.overdue, t.due)}</li>`).join('')}</ul>`
      : '<p style="margin:8px 0 0;color:#9ca3af;font-size:14px;">Nichts fällig diese Woche.</p>'}`;

  // Deck block only appears when there are cards due this week (keeps it lean).
  const deckSection = deck.length ? `
    <div style="font-size:12px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#6b7280;margin-top:22px;padding-bottom:5px;border-bottom:2px solid #e5e7eb;">Deck &middot; Karten fällig diese Woche</div>
    <ul style="margin:8px 0 0;padding-left:20px;font-size:14px;">${deck.map((c) =>
      `<li style="margin:4px 0;">${escapeHtml(c.title)} <span style="color:#9ca3af;font-size:12px;">${escapeHtml(c.board)}${c.stack ? ` / ${escapeHtml(c.stack)}` : ''} &middot; ${dueTag(c.overdue, c.due)}</span></li>`).join('')}</ul>` : '';

  // Bike maintenance block only appears when something's due-soon/overdue
  // (bikeMaintenance.getStatus is pre-filtered to that in buildWeeklyData).
  const bikeSection = bike.length ? `
    <div style="font-size:12px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#6b7280;margin-top:22px;padding-bottom:5px;border-bottom:2px solid #e5e7eb;">Fahrrad &middot; Wartung fällig</div>
    <ul style="margin:8px 0 0;padding-left:20px;font-size:14px;">${bike.map((it) =>
      `<li style="margin:4px 0;">${escapeHtml(it.label)} <span style="color:${it.color};font-weight:600;font-size:12px;">${escapeHtml(it.status)}</span> <span style="color:#9ca3af;font-size:12px;">&middot; ${it.progress}/${it.interval} ${it.unit}</span></li>`).join('')}</ul>` : '';

  return `<!doctype html><html><body style="margin:0;background:#f3f4f6;padding:16px 0;">
    <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2937;max-width:640px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);">
      <div style="background:#1f2937;color:#ffffff;padding:22px 26px;">
        <div style="font-size:21px;font-weight:700;">Deine Woche</div>
        <div style="font-size:13px;color:#9ca3af;margin-top:3px;">${rangeFmt.format(start)} bis ${rangeFmt.format(lastDay)} &middot; ${eventCount} Termine &middot; ${taskCount} Aufgaben${deck.length ? ` &middot; ${deck.length} Deck-Karten` : ''}${bike.length ? ` &middot; ${bike.length} Fahrrad-Wartung` : ''}</div>
      </div>
      <div style="padding:6px 26px 26px;">
        ${dayBlocks}
        ${renderStravaSection(strava)}
        ${renderTrainingSummary(load, ytd, strava)}
        ${taskSection('Aufgaben &middot; Arbeit', workTasks)}
        ${taskSection('Aufgaben &middot; Privat', homeTasks)}
        ${deckSection}
        ${bikeSection}
        <p style="margin-top:26px;color:#cbd5e1;font-size:11px;">Automatisch erstellt von Glance.</p>
      </div>
    </div>
  </body></html>`;
}

async function sendWeeklyDigest(opts = {}) {
  const data = await buildWeeklyData(opts.ref);
  const html = renderWeeklyHtml(data);
  const dd = (d) => new Intl.DateTimeFormat('de-DE', { timeZone: DIGEST_TZ, day: '2-digit', month: '2-digit' }).format(d);
  const lastDay = new Date(data.end.getTime() - 86400000);
  const eventCount = data.days.reduce((n, d) => n + d.events.length, 0);
  const taskCount = data.workTasks.length + data.homeTasks.length;
  const deckCount = (data.deck || []).length;
  const bikeCount = (data.bike || []).length;
  const subject = `Deine Woche, ${dd(data.start)} bis ${dd(lastDay)} (${eventCount} Termine, ${taskCount} Aufgaben${deckCount ? `, ${deckCount} Deck` : ''}${bikeCount ? `, ${bikeCount} Fahrrad` : ''})`;
  if (opts.preview) return { preview: true, subject, html, counts: { events: eventCount, tasks: taskCount, deck: deckCount, bike: bikeCount } };
  if (!WEEKLY_TO) throw new Error('WEEKLY_DIGEST_TO is not set');
  const info = await getMailer().sendMail({ from: SMTP_FROM, to: WEEKLY_TO, subject, html, priority: DIGEST_PRIORITY });
  return { messageId: info.messageId, accepted: info.accepted };
}

// Manual trigger (POST, token-protected by the middleware above). Use for tests.
// Body (optional): { "date": "YYYY-MM-DD", "preview": true, "weekly": true }
app.post('/send-digest', async (req, res) => {
  try {
    const { date, preview, weekly } = req.body || {};
    const result = weekly
      ? await sendWeeklyDigest({ ref: date, preview })
      : await sendDigest({ day: date, preview });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('send-digest failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---- Agenda / free-slots / search ------------------------------------------

// Container TZ is Europe/Berlin, so 'YYYY-MM-DDT00:00:00' parses as the correct
// local midnight instant.
function dayWindow(dateStr) {
  const start = new Date(`${dateStr}T00:00:00`);
  if (isNaN(start.getTime())) throw new Error('invalid date (expected YYYY-MM-DD)');
  return { start, end: new Date(start.getTime() + 24 * 3600 * 1000) };
}

// Merged events (work + home) and open tasks for a single day or an explicit
// [from, to) window. Each source is best-effort.
async function buildAgenda({ date, from, to }) {
  let start, end;
  if (date) ({ start, end } = dayWindow(date));
  else {
    start = new Date(from); end = new Date(to);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) throw new Error('invalid from/to');
  }
  const [ews, ics, homeTasks, workTasks] = await Promise.all([
    EWS_URL ? fetchEwsRange(start, end).catch(() => []) : Promise.resolve([]),
    ICS_URL ? fetchIcsRange(start, end).catch(() => []) : Promise.resolve([]),
    TASKS_HOME_URL ? fetchTasks(TASKS_HOME_URL).catch(() => []) : Promise.resolve([]),
    TASKS_WORK_URL ? fetchTasks(TASKS_WORK_URL).catch(() => []) : Promise.resolve([]),
  ]);
  const events = [
    ...ews.map((e) => ({ ...e, cal: 'work' })),
    ...ics.map((e) => ({ ...e, cal: 'home' })),
  ].sort((a, b) => new Date(a.start) - new Date(b.start));
  return {
    from: start.toISOString(), to: end.toISOString(),
    events, tasks: { home: homeTasks, work: workTasks },
  };
}

app.get('/agenda', async (req, res) => {
  try {
    const { date, from, to } = req.query;
    if (!date && !(from && to)) return res.status(400).json({ error: 'provide date=YYYY-MM-DD or from & to' });
    res.json(await buildAgenda({ date, from, to }));
  } catch (err) {
    console.error('agenda failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Nextcloud Deck (read-only) --------------------------------------------
app.get('/deck/boards', async (_req, res) => {
  try { res.json(await deck.boards()); }
  catch (e) { console.error('deck boards failed:', e.message); res.status(500).json({ error: e.message }); }
});
app.get('/deck/cards', async (_req, res) => {
  try { res.json(await deck.cards()); }
  catch (e) { console.error('deck cards failed:', e.message); res.status(500).json({ error: e.message }); }
});
// Overdue + cards due within the next N days (default 7).
app.get('/deck/cards-due', async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 90);
    const end = new Date(Date.now() + days * 86400000);
    res.json(await deck.cardsDue(end.toISOString()));
  } catch (e) { console.error('deck cards-due failed:', e.message); res.status(500).json({ error: e.message }); }
});
app.get('/deck/stacks', async (req, res) => {
  try {
    if (!req.query.board) return res.status(400).json({ error: 'board query param required' });
    res.json(await deck.stacks(req.query.board));
  } catch (e) { console.error('deck stacks failed:', e.message); res.status(500).json({ error: e.message }); }
});
// Full detail (incl. description) for one card — fetched on demand when the
// dashboard's edit form opens, since the list endpoint above omits it.
app.get('/deck/card', async (req, res) => {
  try {
    const { boardId, stackId, cardId } = req.query;
    if (!boardId || !stackId || !cardId) return res.status(400).json({ error: 'boardId, stackId and cardId required' });
    res.json(await deck.cardDetail({ boardId, stackId, cardId }));
  } catch (e) { console.error('deck card detail failed:', e.message); res.status(400).json({ error: e.message }); }
});

// Writes (token-gated by the global POST middleware).
app.post('/deck/boards', async (req, res) => {
  try { res.json({ ok: true, board: await deck.createBoard(req.body || {}) }); }
  catch (e) { console.error('deck create board failed:', e.message); res.status(400).json({ error: e.message }); }
});
app.post('/deck/stacks', async (req, res) => {
  try { res.json({ ok: true, stack: await deck.createStack(req.body || {}) }); }
  catch (e) { console.error('deck create stack failed:', e.message); res.status(400).json({ error: e.message }); }
});
app.post('/deck/cards', async (req, res) => {
  try { res.json({ ok: true, card: await deck.createCard(req.body || {}) }); }
  catch (e) { console.error('deck create card failed:', e.message); res.status(400).json({ error: e.message }); }
});
app.post('/deck/delete-card', async (req, res) => {
  try { res.json({ ok: true, ...(await deck.deleteCard(req.body || {})) }); }
  catch (e) { console.error('deck delete card failed:', e.message); res.status(400).json({ error: e.message }); }
});
app.post('/deck/update-card', async (req, res) => {
  try { res.json({ ok: true, ...(await deck.updateCard(req.body || {})) }); }
  catch (e) { console.error('deck update card failed:', e.message); res.status(400).json({ error: e.message }); }
});
app.post('/deck/move-card', async (req, res) => {
  try { res.json({ ok: true, ...(await deck.moveCard(req.body || {})) }); }
  catch (e) { console.error('deck move card failed:', e.message); res.status(400).json({ error: e.message }); }
});

// Open slots on a given day within working hours, given a duration in minutes.
app.get('/free-slots', async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'date=YYYY-MM-DD required' });
    const duration = parseInt(req.query.duration || '30', 10);
    const dayStart = req.query.dayStart || '09:00';
    const dayEnd = req.query.dayEnd || '17:00';
    const ws = new Date(`${date}T${dayStart}:00`);
    const we = new Date(`${date}T${dayEnd}:00`);
    if (isNaN(ws.getTime()) || isNaN(we.getTime())) return res.status(400).json({ error: 'invalid date/dayStart/dayEnd' });

    const { events } = await buildAgenda({ date });
    const busy = events
      .filter((e) => e.end)
      .map((e) => ({ s: new Date(e.start), e: new Date(e.end) }))
      .sort((a, b) => a.s - b.s);

    const free = [];
    let cursor = ws;
    for (const b of busy) {
      if (b.e <= ws || b.s >= we) continue;
      if (b.s > cursor && (b.s - cursor) >= duration * 60000) {
        free.push({ start: cursor.toISOString(), end: b.s.toISOString() });
      }
      if (b.e > cursor) cursor = b.e;
    }
    if (we > cursor && (we - cursor) >= duration * 60000) {
      free.push({ start: cursor.toISOString(), end: we.toISOString() });
    }
    res.json({ date, duration, dayStart, dayEnd, free });
  } catch (err) {
    console.error('free-slots failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Keyword search over events (default window today..+90d) and open tasks.
app.get('/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    if (!q) return res.status(400).json({ error: 'q required' });
    const start = req.query.from ? new Date(req.query.from) : new Date();
    const end = req.query.to ? new Date(req.query.to) : new Date(start.getTime() + 90 * 24 * 3600 * 1000);
    const [ews, ics, homeTasks, workTasks] = await Promise.all([
      EWS_URL ? fetchEwsRange(start, end).catch(() => []) : Promise.resolve([]),
      ICS_URL ? fetchIcsRange(start, end).catch(() => []) : Promise.resolve([]),
      TASKS_HOME_URL ? fetchTasks(TASKS_HOME_URL).catch(() => []) : Promise.resolve([]),
      TASKS_WORK_URL ? fetchTasks(TASKS_WORK_URL).catch(() => []) : Promise.resolve([]),
    ]);
    const matchEvent = (e) => `${e.title} ${e.location || ''}`.toLowerCase().includes(q);
    const matchTask = (t) => t.title.toLowerCase().includes(q);
    res.json({
      query: q,
      events: [
        ...ews.filter(matchEvent).map((e) => ({ ...e, cal: 'work' })),
        ...ics.filter(matchEvent).map((e) => ({ ...e, cal: 'home' })),
      ].sort((a, b) => new Date(a.start) - new Date(b.start)),
      tasks: { home: homeTasks.filter(matchTask), work: workTasks.filter(matchTask) },
    });
  } catch (err) {
    console.error('search failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---- Delete / reschedule (Nextcloud / CalDAV only) -------------------------

function caldavAuth(user, pass) {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

async function deleteResource(resourceUrl, authHeader) {
  const r = await fetch(resourceUrl, { method: 'DELETE', headers: { Authorization: authHeader } });
  if (!r.ok && r.status !== 404) throw new Error(`DELETE returned ${r.status}`);
}

async function rescheduleCalEvent(uid, start, end) {
  assertUid(uid);
  if (!CAL_URL) throw new Error('CAL_URL is not set');
  const eventUrl = CAL_URL.replace(/\/$/, '') + `/${uid}.ics`;
  const auth = caldavAuth(ICS_USER, ICS_PASS);
  const g = await fetch(eventUrl, { headers: { Authorization: auth } });
  if (!g.ok) throw new Error(`GET event failed: ${g.status}`);
  const etag = g.headers.get('etag');
  let ics = await g.text();
  const allDay = /^\d{4}-\d{2}-\d{2}$/.test(start);
  let dtstart, dtend;
  if (allDay) {
    const endDate = end || start;
    dtstart = `DTSTART;VALUE=DATE:${start.replace(/-/g, '')}`;
    dtend = `DTEND;VALUE=DATE:${endDate.replace(/-/g, '')}`;
  } else {
    const s = new Date(start);
    const e = end ? new Date(end) : new Date(s.getTime() + 60 * 60 * 1000);
    dtstart = `DTSTART:${icsStamp(s)}`;
    dtend = `DTEND:${icsStamp(e)}`;
  }
  ics = ics.replace(/DTSTART[^\r\n]*/, dtstart);
  if (/DTEND[^\r\n]*/.test(ics)) ics = ics.replace(/DTEND[^\r\n]*/, dtend);
  else ics = ics.replace(dtstart, `${dtstart}\r\n${dtend}`);
  const p = await fetch(eventUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8', Authorization: auth,
      ...(etag ? { 'If-Match': etag } : {}),
    },
    body: ics,
  });
  if (p.status === 412) throw new Error('event was modified concurrently — refetch and retry');
  if (!p.ok) throw new Error(`PUT event failed: ${p.status}`);
}

// Escape a value for an ICS text property (commas, semicolons, backslashes, newlines).
function icsEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
}

// Update fields of a Nextcloud (home) event in place. Any of start/end/location/
// summary may be provided; omitted fields are left unchanged.
async function updateCalEvent(uid, { start, end, location, summary, description }) {
  assertUid(uid);
  if (!CAL_URL) throw new Error('CAL_URL is not set');
  const eventUrl = CAL_URL.replace(/\/$/, '') + `/${uid}.ics`;
  const auth = caldavAuth(ICS_USER, ICS_PASS);
  const g = await fetch(eventUrl, { headers: { Authorization: auth } });
  if (!g.ok) throw new Error(`GET event failed: ${g.status}`);
  const etag = g.headers.get('etag');
  let ics = await g.text();

  if (start) {
    const allDay = /^\d{4}-\d{2}-\d{2}$/.test(start);
    let dtstart, dtend;
    if (allDay) {
      const endDate = end || start;
      dtstart = `DTSTART;VALUE=DATE:${start.replace(/-/g, '')}`;
      dtend = `DTEND;VALUE=DATE:${endDate.replace(/-/g, '')}`;
    } else {
      const s = new Date(start);
      const e = end ? new Date(end) : new Date(s.getTime() + 60 * 60 * 1000);
      dtstart = `DTSTART:${icsStamp(s)}`;
      dtend = `DTEND:${icsStamp(e)}`;
    }
    ics = ics.replace(/DTSTART[^\r\n]*/, dtstart);
    if (/DTEND[^\r\n]*/.test(ics)) ics = ics.replace(/DTEND[^\r\n]*/, dtend);
    else ics = ics.replace(dtstart, `${dtstart}\r\n${dtend}`);
  }
  if (location !== undefined) {
    const line = `LOCATION:${icsEscape(location)}`;
    if (/^LOCATION[:;][^\r\n]*/m.test(ics)) ics = ics.replace(/^LOCATION[:;][^\r\n]*/m, line);
    else ics = ics.replace('END:VEVENT', `${line}\r\nEND:VEVENT`);
  }
  if (summary !== undefined) {
    ics = ics.replace(/SUMMARY:[^\r\n]*/, `SUMMARY:${icsEscape(summary)}`);
  }
  if (description !== undefined) {
    const line = `DESCRIPTION:${icsEscape(description)}`;
    if (/^DESCRIPTION[:;][^\r\n]*/m.test(ics)) ics = ics.replace(/^DESCRIPTION[:;][^\r\n]*/m, line);
    else ics = ics.replace('END:VEVENT', `${line}\r\nEND:VEVENT`);
  }

  const p = await fetch(eventUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8', Authorization: auth,
      ...(etag ? { 'If-Match': etag } : {}),
    },
    body: ics,
  });
  if (p.status === 412) throw new Error('event was modified concurrently — refetch and retry');
  if (!p.ok) throw new Error(`PUT event failed: ${p.status}`);
}

async function setTaskDates(calUrl, uid, startDate, endDate) {
  assertUid(uid);
  const baseUrl = calUrl.replace('/?export', '');
  const taskUrl = `${baseUrl}/${uid}.ics`;
  const auth = caldavAuth(TASKS_USER, TASKS_PASS);
  const g = await fetch(taskUrl, { headers: { Authorization: auth } });
  if (!g.ok) throw new Error(`GET task failed: ${g.status}`);
  const etag = g.headers.get('etag');
  let ics = await g.text();
  const setLine = (name, val) => {
    const line = icsDateProp(name, val);
    // Anchored to line-start (unlike a bare `${name};?[^\r\n]*`, which would
    // also match the property name appearing as a literal substring
    // elsewhere — e.g. a task titled "Invoice DUE end of month" would have
    // its SUMMARY line corrupted instead of its actual DUE line touched).
    const re = new RegExp(`^${name}[;:][^\\r\\n]*`, 'm');
    if (re.test(ics)) ics = ics.replace(re, line);
    else ics = ics.replace('END:VTODO', `${line}\r\nEND:VTODO`);
  };
  if (startDate) setLine('DTSTART', startDate);
  if (endDate) setLine('DUE', endDate);
  ics = reconcileTodoDateTypes(ics);
  const p = await fetch(taskUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8', Authorization: auth,
      ...(etag ? { 'If-Match': etag } : {}),
    },
    body: ics,
  });
  if (p.status === 412) throw new Error('task was modified concurrently — refetch and retry');
  if (!p.ok) throw new Error(`PUT task failed: ${p.status}`);
}

app.post('/delete-ics-event', async (req, res) => {
  try {
    const { uid } = req.body;
    if (!uid) return res.status(400).json({ error: 'uid required' });
    assertUid(uid);
    if (!CAL_URL) throw new Error('CAL_URL is not set');
    await deleteResource(CAL_URL.replace(/\/$/, '') + `/${uid}.ics`, caldavAuth(ICS_USER, ICS_PASS));
    invalidateCache(icsCache);
    res.json({ ok: true });
  } catch (err) {
    console.error('delete event failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/reschedule-ics-event', async (req, res) => {
  try {
    const { uid, start, end } = req.body;
    if (!uid || !start) return res.status(400).json({ error: 'uid and start required' });
    await rescheduleCalEvent(uid, start, end);
    invalidateCache(icsCache);
    res.json({ ok: true });
  } catch (err) {
    console.error('reschedule event failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/update-ics-event', async (req, res) => {
  try {
    const { uid, start, end, location, summary, description } = req.body;
    if (!uid) return res.status(400).json({ error: 'uid required' });
    if (start === undefined && end === undefined && location === undefined && summary === undefined && description === undefined) {
      return res.status(400).json({ error: 'provide at least one of start, end, location, summary, description' });
    }
    await updateCalEvent(uid, { start, end, location, summary, description });
    invalidateCache(icsCache);
    res.json({ ok: true });
  } catch (err) {
    console.error('update event failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/delete-home-task', async (req, res) => {
  try {
    const { uid } = req.body;
    if (!uid) return res.status(400).json({ error: 'uid required' });
    assertUid(uid);
    await deleteResource(`${TASKS_HOME_URL.replace('/?export', '')}/${uid}.ics`, caldavAuth(TASKS_USER, TASKS_PASS));
    invalidateCache(homeTasksCache);
    res.json({ ok: true });
  } catch (err) {
    console.error('delete task failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/delete-work-task', async (req, res) => {
  try {
    const { uid } = req.body;
    if (!uid) return res.status(400).json({ error: 'uid required' });
    assertUid(uid);
    await deleteResource(`${TASKS_WORK_URL.replace('/?export', '')}/${uid}.ics`, caldavAuth(TASKS_USER, TASKS_PASS));
    invalidateCache(workTasksCache);
    res.json({ ok: true });
  } catch (err) {
    console.error('delete task failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/set-home-task-dates', async (req, res) => {
  try {
    const { uid, startDate, endDate, duration } = req.body;
    if (!uid || (!startDate && !endDate && duration == null)) return res.status(400).json({ error: 'uid and startDate, endDate or duration required' });
    await setTaskDates(TASKS_HOME_URL, uid, startDate, resolveTaskEnd({ startDate, endDate, duration }));
    invalidateCache(homeTasksCache);
    res.json({ ok: true });
  } catch (err) {
    console.error('set task dates failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/set-work-task-dates', async (req, res) => {
  try {
    const { uid, startDate, endDate, duration } = req.body;
    if (!uid || (!startDate && !endDate && duration == null)) return res.status(400).json({ error: 'uid and startDate, endDate or duration required' });
    await setTaskDates(TASKS_WORK_URL, uid, startDate, resolveTaskEnd({ startDate, endDate, duration }));
    invalidateCache(workTasksCache);
    res.json({ ok: true });
  } catch (err) {
    console.error('set task dates failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ICS export of the Exchange calendar, for external read-only subscription
// (e.g. Nextcloud's "New subscription"). CalendarView already expands
// recurring events into individual occurrences within the window, so no
// RRULE/EXDATE handling is needed here — each occurrence gets its own
// VEVENT, reusing fetchEwsRange (same low-level query /events itself uses)
// over a [past, future) window suited to a standing subscription rather than
// a "what's upcoming" widget.
//
// Deliberately NOT gated by the shared X-Api-Token like every other endpoint
// (see the nginx location for this path) — a subscription client can't send
// custom headers, so the ?token= query param is the entire access control,
// same "URL-as-secret" trust model as this proxy's own ICS_URL (Nextcloud's
// public read share). Unset CALENDAR_FEED_TOKEN disables the route (404, not
// 403, so an unconfigured deployment doesn't even reveal it exists).
function buildCalendarFeedIcs(items) {
  const now = icsStamp(new Date());
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//glance//calendar-feed//EN',
    'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Exchange (work)',
  ];
  for (const it of items) {
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${icsEscape(it.id || `${it.start}-${it.title}`)}@ics-proxy.local`);
    lines.push(`DTSTAMP:${now}`);
    lines.push(`DTSTART:${icsStamp(new Date(it.start))}`);
    if (it.end) lines.push(`DTEND:${icsStamp(new Date(it.end))}`);
    lines.push(`SUMMARY:${icsEscape(it.title)}`);
    if (it.location) lines.push(`LOCATION:${icsEscape(it.location)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

let calendarFeedCache = { ts: 0, data: null };
async function fetchCalendarFeedItems() {
  if (calendarFeedCache.data && Date.now() - calendarFeedCache.ts < CACHE_TTL_MS) return calendarFeedCache.data;
  const start = new Date(Date.now() - CALENDAR_FEED_PAST_DAYS * 86400000);
  const end = new Date(Date.now() + CALENDAR_FEED_FUTURE_DAYS * 86400000);
  const data = await fetchEwsRange(start.toISOString(), end.toISOString());
  calendarFeedCache = { ts: Date.now(), data };
  return data;
}

app.get('/calendar-feed.ics', async (req, res) => {
  if (!CALENDAR_FEED_TOKEN) return res.status(404).send('not found');
  if (req.query.token !== CALENDAR_FEED_TOKEN) return res.status(403).send('forbidden');
  try {
    const items = await fetchCalendarFeedItems();
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="exchange-calendar.ics"');
    res.send(buildCalendarFeedIcs(items));
  } catch (err) {
    console.error('calendar-feed error:', err.message);
    res.status(500).send('calendar feed error');
  }
});

app.get('/events', (req, res) => handleRequest(res, fetchEwsEvents, ewsCache));
app.get('/ics-events', (req, res) => handleRequest(res, fetchIcsEvents, icsCache));
app.get('/home-tasks', (req, res) => handleRequest(res, () => fetchTasks(TASKS_HOME_URL), homeTasksCache));
app.get('/work-tasks', (req, res) => handleRequest(res, () => fetchTasks(TASKS_WORK_URL), workTasksCache));

// Monday (UTC) of the week containing a YYYY-MM-DD date, as YYYY-MM-DD.
function mondayOf(yyyymmdd) {
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = (dt.getUTCDay() + 6) % 7; // 0 = Monday
  dt.setUTCDate(dt.getUTCDate() - dow);
  return dt.toISOString().slice(0, 10);
}

// Time-in-zone distribution for one activity by id. Pure fetch+shape, no
// "find the right activity" logic -- that's the callers' job (latestHrZones
// picks the most recent HR-bearing one; buildCoachBriefing calls this per
// recent activity so each one gets its own breakdown, not just the latest).
async function zoneDistributionForActivity(id, meta) {
  try {
    const z = await stravaGet(`/activities/${id}/zones`);
    const hr = Array.isArray(z) ? z.find(b => b.type === 'heartrate') : null;
    const buckets = hr && hr.distribution_buckets;
    if (!buckets || !buckets.length) return null;
    const total = buckets.reduce((s, b) => s + (b.time || 0), 0) || 1;
    return {
      ...meta,
      zones: buckets.map((b, i) => ({
        zone: `Z${i + 1}`,
        range: b.max > 0 ? `${b.min}-${b.max}` : `${b.min}+`,
        minutes: Math.round((b.time || 0) / 60),
        pct: Math.round((b.time || 0) / total * 100),
      })),
    };
  } catch (e) {
    console.error('strava zones failed:', e.message);
    return null;
  }
}

// Time-in-zone distribution for the most recent activity that has HR data.
async function latestHrZones(simplified) {
  const a = simplified.find(x => x.avg_hr != null);
  if (!a) return null;
  // id must be in the returned object, not just used to fetch it -- without
  // it, a caller has no way to drill down further (get_strava_activity,
  // get_strava_activity_zones) on the exact activity this data is about.
  return zoneDistributionForActivity(a.id, { id: a.id, activity: a.name, sport: a.sport_type, when: a.when });
}

// The athlete's configured HR zone boundaries, labeled Z1..Zn.
async function hrZoneBoundaries() {
  try {
    const z = await stravaGet('/athlete/zones');
    const zones = z && z.heart_rate && z.heart_rate.zones;
    if (!zones || !zones.length) return null;
    return zones.map((b, i) => ({
      zone: `Z${i + 1}`,
      range: b.max > 0 ? `${b.min}-${b.max}` : `${b.min}+`,
      color: ZONE_COLORS[i % ZONE_COLORS.length],
    }));
  } catch (e) {
    console.error('strava athlete zones failed:', e.message);
    return null;
  }
}

// Build SVG line-chart geometry from a series of { value, label }. Returns a
// polyline points string, an area polygon, and per-point dots with label
// positions, so the Glance template only has to drop them into an <svg>.
function lineChart(items) {
  if (!items || !items.length) return null;
  const W = 320, H = 130, px = 16, pyTop = 16, pyBot = 26;
  const vals = items.map(i => i.value);
  let min = Math.min(...vals), max = Math.max(...vals);
  if (max === min) max = min + 1;
  const n = items.length;
  const xAt = i => n === 1 ? W / 2 : +(px + (W - 2 * px) * i / (n - 1)).toFixed(1);
  const yAt = v => +(H - pyBot - (v - min) / (max - min) * (H - pyTop - pyBot)).toFixed(1);
  const dots = items.map((it, i) => {
    const x = xAt(i), y = yAt(it.value);
    return { x, y, value: Math.round(it.value), label: it.label, valY: +(y - 5).toFixed(1), lblY: H - 8 };
  });
  const points = dots.map(d => `${d.x},${d.y}`).join(' ');
  const baseY = H - pyBot;
  const area = `${dots[0].x},${baseY} ${points} ${dots[dots.length - 1].x},${baseY}`;
  return { w: W, h: H, points, area, dots };
}

// Conventional Strava zone colors (Z1 grey ... Z5 red).
const ZONE_COLORS = ['#7e8a97', '#4a90d9', '#2e9e5b', '#e8913a', '#d0473f'];

// Pie-slice paths for a time-in-zone distribution. Pure coordinate geometry
// (no stroke-dash tricks), so it renders predictably.
function zonePie(zones) {
  if (!zones || !zones.length) return null;
  const cx = 21, cy = 21, r = 20;
  let a0 = 0;
  return zones.map((z, i) => {
    const frac = Math.min(1, (z.pct || 0) / 100);
    const color = ZONE_COLORS[i % ZONE_COLORS.length];
    if (frac >= 0.999) return { ...z, color, full: true, d: '' };
    const a1 = a0 + frac * 2 * Math.PI;
    const p0x = +(cx + r * Math.sin(a0)).toFixed(2), p0y = +(cy - r * Math.cos(a0)).toFixed(2);
    const p1x = +(cx + r * Math.sin(a1)).toFixed(2), p1y = +(cy - r * Math.cos(a1)).toFixed(2);
    const large = (a1 - a0) > Math.PI ? 1 : 0;
    const d = `M${cx},${cy} L${p0x},${p0y} A${r},${r} 0 ${large} 1 ${p1x},${p1y} Z`;
    a0 = a1;
    return { ...z, color, full: false, d };
  });
}

// Chart-ready aggregates over the last 30 activities. Computed server-side so
// the Glance templates only have to render the chart geometry.
async function buildStravaStats() {
  const s = simplifyActivities(await stravaGet('/athlete/activities?per_page=30'));

  // Average HR trend: last 12 activities that recorded HR, oldest-first.
  const hrSeries = s.filter(a => a.avg_hr != null).slice(0, 12).reverse();
  const maxHr = Math.max(1, ...hrSeries.map(a => a.avg_hr));
  const avgHrTrend = hrSeries.map(a => ({
    label: a.start_local ? a.start_local.slice(8, 10) + '.' + a.start_local.slice(5, 7) + '.' : '',
    name: a.name,
    sport: a.sport_type,
    value: Math.round(a.avg_hr),
    pct: Math.round(a.avg_hr / maxHr * 100),
  }));

  // Weekly distance, last 8 weeks (Monday buckets), including empty weeks.
  const now = new Date();
  const dow = (now.getUTCDay() + 6) % 7;
  const thisMon = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - dow));
  const weeks = [];
  for (let i = 7; i >= 0; i--) {
    const mon = new Date(thisMon);
    mon.setUTCDate(mon.getUTCDate() - i * 7);
    weeks.push({ key: mon.toISOString().slice(0, 10), km: 0, label: `${mon.getUTCDate()}.${mon.getUTCMonth() + 1}.` });
  }
  const wIdx = Object.fromEntries(weeks.map((w, i) => [w.key, i]));
  for (const a of s) {
    if (!a.start_local || !a.distance_km) continue;
    const k = mondayOf(a.start_local.slice(0, 10));
    if (k in wIdx) weeks[wIdx[k]].km += a.distance_km;
  }
  const maxKm = Math.max(1, ...weeks.map(w => w.km));
  const weeklyKm = weeks.map(w => ({ label: w.label, km: +w.km.toFixed(1), pct: Math.round(w.km / maxKm * 100) }));

  // Relative Effort ("activity score") trend: last 12 activities that have it.
  const reSeries = s.filter(a => a.relative_effort != null).slice(0, 12).reverse();
  const maxRe = Math.max(1, ...reSeries.map(a => a.relative_effort));
  const effortTrend = reSeries.map(a => ({
    label: a.start_local ? a.start_local.slice(8, 10) + '.' + a.start_local.slice(5, 7) + '.' : '',
    name: a.name,
    sport: a.sport_type,
    value: Math.round(a.relative_effort),
    pct: Math.round(a.relative_effort / maxRe * 100),
  }));

  const totals = {
    count: s.length,
    km: +s.reduce((t, a) => t + (a.distance_km || 0), 0).toFixed(1),
    hours: +(s.reduce((t, a) => t + (a.moving_time_s || 0), 0) / 3600).toFixed(1),
    elevation_m: Math.round(s.reduce((t, a) => t + (a.elevation_gain_m || 0), 0)),
    relative_effort: s.reduce((t, a) => t + (a.relative_effort || 0), 0),
  };

  const hrZones = await latestHrZones(s);
  return {
    totals,
    avgHrChart: lineChart(avgHrTrend),
    effortChart: lineChart(effortTrend),
    weeklyChart: lineChart(weeklyKm.map(w => ({ value: w.km, label: w.label }))),
    hrZones,
    hrPie: zonePie(hrZones && hrZones.zones),
    hrZoneBoundaries: await hrZoneBoundaries(),
    recent: s.slice(0, 10),
  };
}

// Year-to-date totals per sport with optional goal progress. Uses Strava's
// athlete totals endpoint (needs the athlete id from the profile).
async function buildStravaYtd() {
  const me = await stravaGet('/athlete');
  const st = await stravaGet(`/athletes/${me.id}/stats`);
  const km = m => +((m || 0) / 1000).toFixed(1);
  const sport = (label, totals, goalKm) => {
    const dist = km(totals && totals.distance);
    return {
      label,
      count: (totals && totals.count) || 0,
      km: dist,
      hours: +(((totals && totals.moving_time) || 0) / 3600).toFixed(1),
      elevation_m: Math.round((totals && totals.elevation_gain) || 0),
      goalKm: Math.round(goalKm || 0),
      pct: goalKm ? Math.min(100, Math.round(dist / goalKm * 100)) : 0,
    };
  };
  const year = new Date().getFullYear();
  const all = [
    sport('Laufen', st.ytd_run_totals, STRAVA_GOAL_RUN_KM),
    sport('Radfahren', st.ytd_ride_totals, STRAVA_GOAL_RIDE_KM),
    sport('Schwimmen', st.ytd_swim_totals, STRAVA_GOAL_SWIM_KM),
  ];
  return { year, sports: all.filter(s => s.count > 0 || s.goalKm > 0) };
}

// Acute:Chronic Workload Ratio from Relative Effort over the last 28 days.
// acute = last 7 days total; chronic = average weekly load over 28 days.
// preActs: an already-fetched, already-simplified activity list to reuse
// instead of making a fresh call (buildCoachBriefing shares one list across
// several functions this way). The 7/28-day sums are computed from each
// activity's own timestamp regardless of how the list was fetched, so this
// is correct as long as the list actually covers the last 28 days -- true
// for the default fetch below, and true for buildCoachBriefing's shared
// per_page=100 list for any realistic training frequency.
async function buildStravaLoad(preActs) {
  const now = Date.now();
  let acts = preActs;
  if (!acts) {
    const after = Math.floor((now - 28 * 86400000) / 1000);
    acts = simplifyActivities(await stravaGet(`/athlete/activities?after=${after}&per_page=100`));
  }
  let acute = 0, chronic28 = 0;
  for (const a of acts) {
    const re = a.relative_effort || 0;
    if (!a.start) continue;
    const ageDays = (now - new Date(a.start).getTime()) / 86400000;
    if (ageDays <= 7) acute += re;
    if (ageDays <= 28) chronic28 += re;
  }
  const chronicWeekly = chronic28 / 4;
  const ratio = chronicWeekly > 0 ? +(acute / chronicWeekly).toFixed(2) : null;
  let status = 'Keine Daten', color = '#7e8a97';
  if (ratio != null) {
    if (ratio < 0.8) { status = 'Untertraining'; color = '#4a90d9'; }
    else if (ratio <= 1.3) { status = 'Optimal'; color = '#2e9e5b'; }
    else if (ratio <= 1.5) { status = 'Erhöht'; color = '#e8913a'; }
    else { status = 'Hohes Risiko'; color = '#d0473f'; }
  }
  return {
    acute: Math.round(acute),
    chronicWeekly: Math.round(chronicWeekly),
    ratio,
    status,
    color,
    gaugePct: ratio != null ? Math.min(100, Math.round(ratio / 2 * 100)) : 0,
  };
}

// Strava summary for a week window [start, end), used in the weekly digest.
async function buildStravaWeekRecap(start, end) {
  if (!STRAVA_CLIENT_ID || !STRAVA_REFRESH_TOKEN) return null;
  try {
    const after = Math.floor(start.getTime() / 1000);
    const before = Math.floor(end.getTime() / 1000);
    const acts = simplifyActivities(await stravaGet(`/athlete/activities?after=${after}&before=${before}&per_page=100`));
    return {
      count: acts.length,
      km: +acts.reduce((t, a) => t + (a.distance_km || 0), 0).toFixed(1),
      hours: +(acts.reduce((t, a) => t + (a.moving_time_s || 0), 0) / 3600).toFixed(1),
      effort: acts.reduce((t, a) => t + (a.relative_effort || 0), 0),
      elevation_m: Math.round(acts.reduce((t, a) => t + (a.elevation_gain_m || 0), 0)),
      activities: acts,
    };
  } catch (e) {
    console.error('strava week recap failed:', e.message);
    return null;
  }
}

// --- Strava history DB (SQLite) -------------------------------------------
// Activities are synced into SQLite so charts can aggregate over any range
// (day/week/month/custom) without hammering the Strava API each time.
let _db = null;
// Last Strava sync outcome, surfaced on /status.
let lastStravaSync = { at: null, synced: null, error: null };
function stravaDb() {
  if (_db) return _db;
  if (!Database) throw new Error('database unavailable');
  _db = new Database(STRAVA_DB);
  _db.pragma('journal_mode = WAL');
  _db.exec(`CREATE TABLE IF NOT EXISTS activities (
    id INTEGER PRIMARY KEY,
    name TEXT, sport TEXT,
    start_utc TEXT, start_local TEXT,
    distance_m REAL, moving_s INTEGER, elapsed_s INTEGER,
    elev_m REAL, avg_hr REAL, max_hr REAL, avg_watts REAL,
    rel_effort INTEGER, kudos INTEGER
  )`);
  // Added after the table already existed in production, so CREATE TABLE IF
  // NOT EXISTS above won't add it to a pre-existing file — migrate with an
  // explicit ALTER, ignoring the "duplicate column" error on a DB that
  // already has it (no IF NOT EXISTS support for ALTER TABLE ADD COLUMN).
  try { _db.exec('ALTER TABLE activities ADD COLUMN avg_cadence REAL'); } catch { /* already migrated */ }
  return _db;
}

// Average speed (km/h) over recent outdoor rides, for deriving ride duration
// from a distance when the caller doesn't supply one. Excludes e-bike rides
// (sport LIKE '%EBike%') so an assisted average doesn't skew a normal-bike
// estimate. Returns null if there's no ride history to derive from.
function avgCyclingSpeedKmh(sampleSize = 20) {
  const db = stravaDb();
  const rows = db.prepare(`
    SELECT distance_m, moving_s FROM activities
    WHERE sport LIKE '%Ride%' AND sport NOT LIKE '%EBike%'
      AND moving_s > 0 AND distance_m > 0
    ORDER BY start_utc DESC LIMIT ?
  `).all(sampleSize);
  if (!rows.length) return null;
  const totalDist = rows.reduce((s, r) => s + r.distance_m, 0);
  const totalTime = rows.reduce((s, r) => s + r.moving_s, 0);
  if (!totalTime) return null;
  return { kmh: +(totalDist / totalTime * 3.6).toFixed(1), sampleSize: rows.length };
}

function mapActivityRow(a) {
  return {
    id: a.id,
    name: a.name || '',
    sport: a.sport_type || a.type || '',
    start_utc: a.start_date || null,
    start_local: a.start_date_local || null,
    distance_m: a.distance ?? null,
    moving_s: a.moving_time ?? null,
    elapsed_s: a.elapsed_time ?? null,
    elev_m: a.total_elevation_gain ?? null,
    avg_hr: a.average_heartrate ?? null,
    max_hr: a.max_heartrate ?? null,
    avg_watts: a.average_watts ?? null,
    avg_cadence: a.average_cadence ?? null,
    rel_effort: a.suffer_score ?? null,
    kudos: a.kudos_count ?? null,
  };
}

// Pull activities from Strava into the DB. full=true backfills all history;
// otherwise only fetches activities newer than the latest stored one.
async function stravaSync(full) {
  if (!Database || !STRAVA_CLIENT_ID || !STRAVA_REFRESH_TOKEN) return { synced: 0, skipped: 'not configured' };
  const db = stravaDb();
  let after = 0;
  if (!full) {
    const row = db.prepare('SELECT MAX(start_utc) m FROM activities').get();
    if (row && row.m) after = Math.floor(new Date(row.m).getTime() / 1000) - 3600; // 1h overlap
  }
  const ins = db.prepare(`INSERT INTO activities
    (id,name,sport,start_utc,start_local,distance_m,moving_s,elapsed_s,elev_m,avg_hr,max_hr,avg_watts,avg_cadence,rel_effort,kudos)
    VALUES (@id,@name,@sport,@start_utc,@start_local,@distance_m,@moving_s,@elapsed_s,@elev_m,@avg_hr,@max_hr,@avg_watts,@avg_cadence,@rel_effort,@kudos)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, sport=excluded.sport, distance_m=excluded.distance_m,
      moving_s=excluded.moving_s, elapsed_s=excluded.elapsed_s, elev_m=excluded.elev_m,
      avg_hr=excluded.avg_hr, max_hr=excluded.max_hr, avg_watts=excluded.avg_watts,
      avg_cadence=excluded.avg_cadence, rel_effort=excluded.rel_effort, kudos=excluded.kudos`);
  let page = 1, total = 0;
  for (;;) {
    const batch = await stravaGet(`/athlete/activities?after=${after}&per_page=200&page=${page}`);
    if (!Array.isArray(batch) || !batch.length) break;
    const tx = db.transaction((rows) => { for (const a of rows) ins.run(mapActivityRow(a)); });
    tx(batch);
    total += batch.length;
    page += 1;
    if (batch.length < 200 || page > 25) break; // safety cap ~5000 activities
  }
  lastStravaSync = { at: new Date().toISOString(), synced: total, error: null };
  return { synced: total };
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
function seriesLabel(granularity, isoLocal) {
  const d = (isoLocal || '').slice(0, 10);
  if (!d) return '';
  const [y, m, day] = d.split('-');
  if (granularity === 'year') return y;
  if (granularity === 'month') return MONTH_ABBR[parseInt(m, 10) - 1] || m;
  return `${day}.${m}.`;
}

// Aggregate the stored activities into a labeled series for one metric.
function stravaSeries({ metric, granularity, from, to, count, offset }) {
  const db = stravaDb();
  const unit = metric === 'hr' ? 'bpm' : metric === 'distance' ? 'km' : metric === 'cadence' ? 'rpm' : 'Score';
  // hr/cadence are averages (no such thing as "total cadence"), so both null
  // out an activity that never recorded them rather than counting it as 0.
  const avgMetric = metric === 'hr' || metric === 'cadence';
  const col = metric === 'hr' ? 'avg_hr' : metric === 'cadence' ? 'avg_cadence' : null;
  // Per-activity mode: one point per workout (most recent N), not bucketed.
  if (granularity === 'activity') {
    const ve = col || (metric === 'distance' ? 'distance_m/1000.0' : 'COALESCE(rel_effort,0)');
    const wsql = avgMetric ? `WHERE ${col} IS NOT NULL` : '';
    const lim = Math.min(count > 0 ? count : 12, 200);
    const off = offset > 0 ? offset : 0;
    const rows = db.prepare(`SELECT start_local ms, ${ve} val FROM activities ${wsql} ORDER BY start_utc DESC LIMIT ${lim} OFFSET ${off}`).all();
    rows.reverse();
    return { metric, granularity, unit, points: rows.map(r => ({ key: r.ms, value: Math.round((r.val || 0) * 10) / 10, label: seriesLabel('day', r.ms) })) };
  }
  const bucket = granularity === 'day' ? `strftime('%Y-%m-%d', start_local)`
    : granularity === 'year' ? `strftime('%Y', start_local)`
    : granularity === 'month' ? `strftime('%Y-%m', start_local)`
    // Monday-anchored week-start date via date arithmetic — NOT
    // strftime('%Y-%W', ...), which resets the week number to 00 on Jan 1
    // regardless of weekday, splitting a week that spans Dec 31 -> Jan 1
    // into two separate buckets (two chart bars for one real training week).
    : `date(start_local, '-' || ((CAST(strftime('%w', start_local) AS INTEGER) + 6) % 7) || ' days')`;
  let valExpr;
  if (col) valExpr = `AVG(${col})`;
  else if (metric === 'distance') valExpr = 'SUM(distance_m)/1000.0';
  else valExpr = 'SUM(COALESCE(rel_effort,0))';
  const where = [], params = {};
  if (avgMetric) where.push(`${col} IS NOT NULL`);
  if (from) { where.push('start_utc >= @from'); params.from = from; }
  if (to) { where.push('start_utc <= @to'); params.to = to; }
  const wsql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = db.prepare(`SELECT ${bucket} bucket, ${valExpr} val, MIN(start_local) ms
    FROM activities ${wsql} GROUP BY bucket ORDER BY bucket`).all(params);
  let pts = rows.map(r => ({ key: r.bucket, value: Math.round((r.val || 0) * 10) / 10, ms: r.ms }));
  if (!from && !to) {
    const def = granularity === 'day' ? 30 : granularity === 'year' ? 6 : 12;
    const lim = Math.min(count > 0 ? count : def, 366); // window length (slider-controlled)
    pts = pts.slice(-lim);
  }
  return {
    metric, granularity, unit,
    points: pts.map(p => ({ key: p.key, value: p.value, label: seriesLabel(granularity, p.ms) })),
  };
}

// --- Strava read endpoints (mirror the Strava MCP read tools) -------------
// All read-only. Access token is refreshed automatically from STRAVA_*.

// list_activities. Query: per_page (<=100), page, before/after (unix seconds).
app.get('/strava/activities', (req, res) => {
  const perPage = Math.min(parseInt(req.query.per_page || '30', 10) || 30, 100);
  const page = parseInt(req.query.page || '1', 10) || 1;
  const qs = new URLSearchParams({ per_page: String(perPage), page: String(page) });
  if (req.query.before) qs.set('before', String(req.query.before));
  if (req.query.after) qs.set('after', String(req.query.after));
  stravaCached(`activities?${qs}`, () => stravaGet(`/athlete/activities?${qs}`).then(simplifyActivities), res);
});

// get_athlete_profile. Includes bikes[] and shoes[] (used by gear too).
app.get('/strava/athlete', (req, res) =>
  stravaCached('athlete', () => stravaGet('/athlete'), res));

// get_athlete_zones. HR + power zones.
app.get('/strava/zones', (req, res) =>
  stravaCached('zones', () => stravaGet('/athlete/zones'), res));

// get_gear. Derived from the athlete profile (REST has no list-gear endpoint).
app.get('/strava/gear', (req, res) =>
  stravaCached('gear', () => stravaGet('/athlete').then(a => ({
    bikes: a.bikes || [],
    shoes: a.shoes || [],
  })), res));

// get_gear by id (full detail incl. brand/model, weight).
app.get('/strava/gear/:id', (req, res) =>
  stravaCached(`gear/${req.params.id}`, () => stravaGet(`/gear/${encodeURIComponent(req.params.id)}`), res));

// get_activity_performance. Detailed activity: HR/watts/cadence, calories,
// effort, elevation range, environment, location, gear, route, laps,
// segment_efforts, achievements. Trimmed by simplifyActivity (drops social
// counters and account/visibility flags).
app.get('/strava/activity/:id', (req, res) =>
  stravaCached(`activity/${req.params.id}`, () => stravaGet(`/activities/${encodeURIComponent(req.params.id)}`).then(simplifyActivity), res));

// get_activity_streams. Query: keys (csv), resolution (low|medium|high).
app.get('/strava/activity/:id/streams', (req, res) => {
  const keys = String(req.query.keys || 'time,heartrate,watts,cadence,distance,altitude,velocity_smooth,latlng,grade_smooth,temp,moving');
  const resolution = req.query.resolution ? `&resolution=${encodeURIComponent(req.query.resolution)}` : '';
  stravaCached(`streams/${req.params.id}/${keys}${resolution}`,
    () => stravaGet(`/activities/${encodeURIComponent(req.params.id)}/streams?keys=${encodeURIComponent(keys)}&key_by_type=true${resolution}`), res);
});

// get_club_info. Clubs the athlete belongs to.
app.get('/strava/clubs', (req, res) =>
  stravaCached('clubs', () => stravaGet('/athlete/clubs'), res));

// Upcoming events for a club.
app.get('/strava/club/:id/events', (req, res) =>
  stravaCached(`club/${req.params.id}/events`, () => stravaGet(`/clubs/${encodeURIComponent(req.params.id)}/group_events`), res));

// Time-in-zone distribution for one activity (HR + power buckets).
app.get('/strava/activity/:id/zones', (req, res) =>
  stravaCached(`actzones/${req.params.id}`, () => stravaGet(`/activities/${encodeURIComponent(req.params.id)}/zones`), res));

// Chart-ready aggregates for the Strava dashboard page.
app.get('/strava/stats', (req, res) => stravaCached('stats', buildStravaStats, res));

// Year-to-date totals + goal progress.
app.get('/strava/ytd', (req, res) => stravaCached('ytd', buildStravaYtd, res));

// Training load (acute:chronic workload ratio).
app.get('/strava/load', (req, res) => stravaCached('load', buildStravaLoad, res));

// DB-backed time series for the customizable charts. Reads SQLite directly
// (fast, no Strava call). metric: hr|effort|distance|cadence; granularity: day|week|month.
app.get('/strava/series', (req, res) => {
  if (!Database) return res.status(503).json({ error: 'database unavailable' });
  try {
    const metric = ['hr', 'effort', 'distance', 'cadence'].includes(req.query.metric) ? req.query.metric : 'distance';
    const granularity = ['day', 'week', 'month', 'year', 'activity'].includes(req.query.granularity) ? req.query.granularity : 'week';
    let from = req.query.from, to = req.query.to;
    if (from && from.length === 10) from = from + 'T00:00:00Z';
    if (to && to.length === 10) to = to + 'T23:59:59Z';
    const count = parseInt(req.query.count, 10) || 0;
    const offset = parseInt(req.query.offset, 10) || 0;
    res.json(stravaSeries({ metric, granularity, from, to, count, offset }));
  } catch (e) {
    console.error('strava series failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Manual sync trigger (POST, token-gated). Body: { full: true } for a backfill.
app.post('/strava/sync', async (req, res) => {
  try {
    const r = await stravaSync(!!(req.body && req.body.full));
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Apple Health ingest (Health Auto Export) -----------------------------
// Capture stub: stores the raw payload so we can inspect its real shape before
// building a typed parser. Shares the Strava SQLite file.
function healthDb() {
  const db = stravaDb();
  db.exec(`CREATE TABLE IF NOT EXISTS health_raw (
    id INTEGER PRIMARY KEY AUTOINCREMENT, received_at TEXT, bytes INTEGER, body TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS health_metrics (
    metric TEXT, day TEXT, value REAL, PRIMARY KEY (metric, day)
  )`);
  return db;
}

// Map Health Auto Export metric names to our canonical keys. Names can vary by
// app version/locale, so each canonical key lists candidate source names.
// Each canonical metric: the source names it can arrive under, its display
// unit, and how to aggregate the day's raw samples (Health Auto Export sends
// per-sample data, e.g. per-minute steps, so this is essential).
//   sum: total the day (steps, energy)
//   avg: mean of the day's readings (resting HR, HRV, VO2 max)
//   sleep: nightly totalSleep hours
const HEALTH_DEFS = {
  steps:         { names: ['step_count'], unit: '', agg: 'sum' },
  active_energy: { names: ['active_energy'], unit: 'kcal', agg: 'sum' },
  resting_hr:    { names: ['resting_heart_rate'], unit: 'bpm', agg: 'avg' },
  hrv:           { names: ['heart_rate_variability', 'heart_rate_variability_sdnn'], unit: 'ms', agg: 'avg' },
  vo2_max:       { names: ['vo2_max'], unit: 'ml/kg/min', agg: 'avg' },
  sleep:         { names: ['sleep_analysis'], unit: 'h', agg: 'sleep' },
  weight:        { names: ['weight_body_mass'], unit: 'kg', agg: 'avg' },
  body_fat:      { names: ['body_fat_percentage'], unit: '%', agg: 'avg' },
  bmi:           { names: ['body_mass_index'], unit: '', agg: 'avg' },
  // Additional daily signals (captured so charts can be added on demand).
  exercise_min:  { names: ['apple_exercise_time'], unit: 'min', agg: 'sum' },
  respiratory:   { names: ['respiratory_rate'], unit: '/min', agg: 'avg' },
  walking_hr:    { names: ['walking_heart_rate_average'], unit: 'bpm', agg: 'avg' },
  flights:       { names: ['flights_climbed'], unit: '', agg: 'sum' },
  daylight:      { names: ['time_in_daylight'], unit: 'min', agg: 'sum' },
  water:         { names: ['dietary_water'], unit: 'mL', agg: 'sum' },
  energy_intake: { names: ['dietary_energy'], unit: 'kcal', agg: 'sum' },
  carbs:         { names: ['carbohydrates'], unit: 'g', agg: 'sum' },
  protein:       { names: ['protein'], unit: 'g', agg: 'sum' },
  fat:           { names: ['total_fat'], unit: 'g', agg: 'sum' },
};
const HEALTH_MAP = Object.fromEntries(Object.entries(HEALTH_DEFS).map(([k, v]) => [k, v.names]));
const HEALTH_UNITS = Object.fromEntries(Object.entries(HEALTH_DEFS).map(([k, v]) => [k, v.unit]));
function healthCanon(name) {
  const n = String(name || '').toLowerCase();
  for (const k of Object.keys(HEALTH_DEFS)) if (HEALTH_DEFS[k].names.includes(n)) return k;
  return null;
}

// Parse a Health Auto Export REST payload into daily metric values. Samples are
// grouped by day and reduced per the metric's aggregation mode. Energy arriving
// in kJ is converted to kcal. Returns the number of (metric, day) rows written.
function parseHealthPayload(body) {
  const metrics = body && body.data && Array.isArray(body.data.metrics) ? body.data.metrics : [];
  if (!metrics.length) return 0;
  const db = healthDb();
  const up = db.prepare('INSERT INTO health_metrics (metric,day,value) VALUES (?,?,?) ON CONFLICT(metric,day) DO UPDATE SET value=excluded.value');
  let rows = 0;
  const tx = db.transaction(() => {
    for (const m of metrics) {
      const canon = healthCanon(m.name);
      if (!canon) continue;
      const def = HEALTH_DEFS[canon];
      const kjToKcal = canon === 'active_energy' && /kj/i.test(m.units || '');
      // Accumulate per day: { sum, count, max } over the day's samples.
      const byDay = new Map();
      for (const d of (m.data || [])) {
        const day = String(d.date || '').slice(0, 10);
        if (!day) continue;
        let v;
        if (def.agg === 'sleep') {
          v = d.totalSleep ?? d.asleep;
          if (v == null) v = (d.core || 0) + (d.deep || 0) + (d.rem || 0);
        } else {
          v = d.qty ?? d.Avg ?? d.avg;
        }
        if (v == null || isNaN(+v)) continue;
        v = +v;
        if (kjToKcal) v = v / 4.184;
        const a = byDay.get(day) || { sum: 0, count: 0, max: 0 };
        a.sum += v; a.count += 1; a.max = Math.max(a.max, v);
        byDay.set(day, a);
      }
      for (const [day, a] of byDay) {
        const val = def.agg === 'avg' ? a.sum / a.count
          : def.agg === 'sleep' ? a.max // longest nightly sleep block for the day
          : a.sum;                       // sum (steps, energy)
        up.run(canon, day, val);
        rows += 1;
      }
    }
  });
  tx();
  return rows;
}

// POST from the iOS app. Token-gated by the global POST middleware (X-Api-Token).
app.post('/health-api/ingest', (req, res) => {
  try {
    const raw = JSON.stringify(req.body || {});
    const keys = req.body && typeof req.body === 'object' ? Object.keys(req.body) : [];
    console.log(`health ingest: ${raw.length} bytes, top-level keys: [${keys.join(', ')}]`);
    let stored = 0;
    if (Database) {
      const db = healthDb();
      db.prepare('INSERT INTO health_raw (received_at, bytes, body) VALUES (?,?,?)')
        .run(new Date().toISOString(), raw.length, raw);
      db.exec('DELETE FROM health_raw WHERE id NOT IN (SELECT id FROM health_raw ORDER BY id DESC LIMIT 20)');
      try { stored = parseHealthPayload(req.body); } catch (e) { console.error('health parse failed:', e.message); }
    }
    console.log(`health ingest stored ${stored} metric points`);
    res.json({ ok: true, received: raw.length, keys, stored });
  } catch (e) {
    console.error('health ingest failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Inspect the most recent captured payload (token-gated GET) so we can design
// the parser. ?meta=1 returns only sizes/keys (skips the full body).
app.get('/health-api/raw', (req, res) => {
  if (!Database) return res.status(503).json({ error: 'database unavailable' });
  const row = healthDb().prepare('SELECT received_at, bytes, body FROM health_raw ORDER BY id DESC LIMIT 1').get();
  if (!row) return res.json({ empty: true });
  let body = null;
  try { body = JSON.parse(row.body); } catch (e) { body = row.body; }
  if (req.query.meta) {
    return res.json({ received_at: row.received_at, bytes: row.bytes, keys: body && typeof body === 'object' ? Object.keys(body) : [] });
  }
  res.json({ received_at: row.received_at, bytes: row.bytes, body });
});

// Latest value per health metric (for the summary widget / tools).
app.get('/health-api/summary', (req, res) => {
  if (!Database) return res.status(503).json({ error: 'database unavailable' });
  try {
    const db = healthDb();
    const out = {};
    for (const k of Object.keys(HEALTH_MAP)) {
      const row = db.prepare('SELECT day, value FROM health_metrics WHERE metric=? ORDER BY day DESC LIMIT 1').get(k);
      if (row) out[k] = { day: row.day, value: Math.round(row.value * 10) / 10, unit: HEALTH_UNITS[k] || '' };
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Daily series for one health metric (for charts). ?metric=&days=
app.get('/health-api/series', (req, res) => {
  if (!Database) return res.status(503).json({ error: 'database unavailable' });
  try {
    const metric = req.query.metric;
    if (!HEALTH_MAP[metric]) return res.status(400).json({ error: 'unknown metric' });
    const days = Math.min(parseInt(req.query.days, 10) || 30, 366);
    const rows = healthDb().prepare('SELECT day, value FROM health_metrics WHERE metric=? ORDER BY day DESC LIMIT ?').all(metric, days);
    rows.reverse();
    res.json({
      metric, unit: HEALTH_UNITS[metric] || '',
      points: rows.map(r => ({ key: r.day, value: Math.round(r.value * 10) / 10, label: r.day.slice(8, 10) + '.' + r.day.slice(5, 7) + '.' })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Readiness signal (ACWR + resting HR / HRV / sleep) --------------------
// Latest value of a health metric plus the mean of the prior `baselineDays`.
function healthLatestAndBaseline(metric, baselineDays = 14) {
  if (!Database) return null;
  try {
    const rows = healthDb().prepare('SELECT day, value FROM health_metrics WHERE metric=? ORDER BY day DESC LIMIT ?').all(metric, baselineDays + 1);
    if (!rows.length) return null;
    const prior = rows.slice(1);
    const baseline = prior.length ? prior.reduce((s, r) => s + r.value, 0) / prior.length : null;
    return { day: rows[0].day, value: rows[0].value, baseline };
  } catch { return null; }
}

// A simple "hard / easy / rest" recommendation from training load and the
// morning recovery signals. Score starts at 100 and each stressor deducts.
// preActs: reuse an already-fetched list instead of this function's own
// fetch, and pass it straight through to buildStravaLoad too -- see its
// comment. Default (no preActs) behavior is unchanged for other callers.
async function buildReadiness(preActs) {
  let acts = preActs;
  if (!acts) {
    try { acts = simplifyActivities(await stravaGet('/athlete/activities?per_page=15')); } catch { acts = []; }
  }
  const load = await buildStravaLoad(preActs).catch(() => null);
  const last = acts[0];
  const daysSinceLast = last && last.start ? Math.floor((Date.now() - new Date(last.start).getTime()) / 86400000) : null;
  const rhr = healthLatestAndBaseline('resting_hr');
  const hrv = healthLatestAndBaseline('hrv');
  const sleep = healthLatestAndBaseline('sleep');

  let score = 100;
  const reasons = [];
  const acwr = load ? load.ratio : null;
  if (acwr != null) {
    if (acwr > 1.5) { score -= 35; reasons.push(`Trainingsbelastung sehr hoch (ACWR ${acwr})`); }
    else if (acwr > 1.3) { score -= 18; reasons.push(`Belastung erhöht (ACWR ${acwr})`); }
    else if (acwr < 0.8) { score += 4; reasons.push(`Frisch, geringe jüngste Belastung (ACWR ${acwr})`); }
    else reasons.push(`Belastung optimal (ACWR ${acwr})`);
  }
  if (rhr && rhr.baseline != null) {
    const d = rhr.value - rhr.baseline;
    if (d >= 5) { score -= 20; reasons.push(`Ruhepuls ${Math.round(rhr.value)} bpm deutlich über Ø (${Math.round(rhr.baseline)})`); }
    else if (d >= 2) { score -= 8; reasons.push('Ruhepuls leicht erhöht'); }
    else if (d <= -2) { score += 4; reasons.push('Ruhepuls niedrig, gute Erholung'); }
  }
  if (hrv && hrv.baseline) {
    const ratio = hrv.value / hrv.baseline;
    if (ratio < 0.85) { score -= 20; reasons.push(`HRV ${Math.round(hrv.value)} ms unter Ø (${Math.round(hrv.baseline)})`); }
    else if (ratio < 0.93) { score -= 8; reasons.push('HRV leicht unter Ø'); }
    else if (ratio > 1.05) { score += 4; reasons.push('HRV über Ø, gut erholt'); }
  }
  if (sleep && sleep.value != null) {
    if (sleep.value < 6) { score -= 12; reasons.push(`Wenig Schlaf (${sleep.value.toFixed(1)} h)`); }
    else if (sleep.value >= 7.5) { score += 3; }
  }
  if (daysSinceLast === 0 && last && last.relative_effort && last.relative_effort > 80) {
    score -= 10; reasons.push('Harte Einheit heute bereits absolviert');
  }
  if (daysSinceLast != null && daysSinceLast >= 3) { score += 4; reasons.push(`${daysSinceLast} Tage seit letzter Aktivität`); }

  score = Math.max(0, Math.min(100, Math.round(score)));
  // A dangerously high training load caps readiness regardless of how good the
  // recovery signals look: ACWR is a load/injury-risk metric, not recovery, so
  // feeling fresh must not turn a high-risk load day into "ready for hard".
  if (acwr != null && acwr > 1.5 && score > 40) { score = 40; reasons.push('Durch hohe Belastung gedeckelt (ACWR > 1.5)'); }
  else if (acwr != null && acwr > 1.3 && score > 65) { score = 65; reasons.push('Durch erhöhte Belastung gedeckelt (ACWR > 1.3)'); }
  let recommendation, color;
  if (score >= 70) { recommendation = 'Bereit für hart'; color = '#2e9e5b'; }
  else if (score >= 45) { recommendation = 'Locker / moderat'; color = '#e8913a'; }
  else { recommendation = 'Ruhetag empfohlen'; color = '#d0473f'; }

  return {
    score, recommendation, color,
    acwr, acwrStatus: load ? load.status : null,
    restingHr: rhr ? { value: Math.round(rhr.value), baseline: rhr.baseline != null ? Math.round(rhr.baseline) : null } : null,
    hrv: hrv ? { value: Math.round(hrv.value), baseline: hrv.baseline != null ? Math.round(hrv.baseline) : null } : null,
    sleepHours: sleep && sleep.value != null ? +sleep.value.toFixed(1) : null,
    daysSinceLast,
    reasons,
    note: reasons.join(' · '),
  };
}

app.get('/strava/readiness', (req, res) => stravaCached('readiness', buildReadiness, res));

// --- Cycling training planner -----------------------------------------------
// Given a start + destination (+ either a duration or a distance), builds a
// weather-aware packing list and a carb/gel target for the ride. Read-only:
// returns a descriptionDraft meant to be handed to create_event/create_task
// as-is, so the actual calendar write still goes through the normal
// confirm-then-POST flow rather than this endpoint writing anything itself.
const CARBS_PER_HOUR_G = 60;
const GEL_CARBS_G = 25;
// Straight-line distance is a poor proxy for an actual road route; this rough
// multiplier turns it into a distance estimate when the caller gives neither
// distanceKm nor durationMinutes. It is NOT a real route (no roads/elevation),
// just a fallback so the tool still works with only a start + destination.
const ROUTE_DISTANCE_FACTOR = 1.3;

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Packing list needs to cover both ends of the ride, so combine the worse
// condition from each leg (colder low, hotter high, wetter, windier) rather
// than just looking at the destination.
function worstCaseWeather(a, b) {
  if (!b) return a;
  return {
    tempMin: Math.min(a.tempMin, b.tempMin),
    tempMax: Math.max(a.tempMax, b.tempMax),
    precip: Math.max(a.precip, b.precip),
    precipProb: Math.max(a.precipProb ?? 0, b.precipProb ?? 0),
    windMax: Math.max(a.windMax, b.windMax),
  };
}

function cyclingPackingList(w) {
  const list = ['Helmet', 'Phone + ID', 'Water bottles', 'Repair kit (spare tube, tire levers, mini pump/CO2, multitool)'];
  const tempMin = w.tempMin, tempMax = w.tempMax;
  const wet = (w.precipProb != null && w.precipProb >= 40) || w.precip >= 1;

  if (tempMin < 5) list.push('Thermal jacket', 'Thermal gloves', 'Shoe covers', 'Neck warmer/buff');
  else if (tempMin < 10) list.push('Arm & leg warmers', 'Light jacket', 'Full-finger gloves');
  else if (tempMin < 15) list.push('Arm warmers or light vest', 'Light gloves');

  if (tempMax > 25) list.push('Extra water bottle', 'Sunscreen', 'Lightweight/breathable jersey');

  if (wet) {
    list.push('Rain jacket', 'Waterproof shoe covers');
    if (tempMin < 12) list.push('Extra dry layer (cold + wet risks a big chill on descents)');
  }

  if (w.windMax >= 30) list.push('Windbreaker vest (strong wind expected)');

  return list;
}

function cyclingNutritionPlan(durationMinutes) {
  if (durationMinutes < 60) {
    return {
      carbsPerHour: CARBS_PER_HOUR_G, gelCarbsG: GEL_CARBS_G,
      totalCarbsG: 0, gelsNeeded: 0,
      note: 'Under an hour — water is enough, no gels needed.',
    };
  }
  const totalCarbsG = Math.round(CARBS_PER_HOUR_G * (durationMinutes / 60));
  const gelsNeeded = Math.ceil(totalCarbsG / GEL_CARBS_G);
  return {
    carbsPerHour: CARBS_PER_HOUR_G, gelCarbsG: GEL_CARBS_G, totalCarbsG, gelsNeeded,
    note: `~${totalCarbsG}g carbs total → ~${gelsNeeded} gel(s) @ ${GEL_CARBS_G}g, spaced through the ride.`,
  };
}

app.get('/plan-cycling-training', async (req, res) => {
  try {
    const destinationQ = String(req.query.destination || '').trim();
    if (!destinationQ) return res.status(400).json({ error: 'destination required' });
    const startQ = String(req.query.start || '').trim();
    const date = req.query.date || berlinDay(new Date());

    const [startLoc, destLoc] = await Promise.all([
      startQ ? weather.geocodePlace(startQ) : weather.resolveLocation({}),
      weather.geocodePlace(destinationQ),
    ]);
    const [startWeather, destWeather] = await Promise.all([
      weather.weatherCached(date, startLoc),
      weather.weatherCached(date, destLoc),
    ]);

    let durationMinutes = req.query.durationMinutes ? Number(req.query.durationMinutes) : null;
    let distanceKm = req.query.distanceKm ? Number(req.query.distanceKm) : null;
    let distanceSource = distanceKm ? 'given' : null;
    let avgSpeedKmh = req.query.avgSpeedKmh ? Number(req.query.avgSpeedKmh) : null;
    let speedSource = avgSpeedKmh ? 'given' : null;
    let straightLineKm = null;

    if (durationMinutes == null || isNaN(durationMinutes)) {
      if (distanceKm == null || isNaN(distanceKm)) {
        straightLineKm = haversineKm(
          parseFloat(startLoc.lat), parseFloat(startLoc.lon),
          parseFloat(destLoc.lat), parseFloat(destLoc.lon),
        );
        distanceKm = +(straightLineKm * ROUTE_DISTANCE_FACTOR).toFixed(1);
        distanceSource = `estimated from straight-line start→destination distance (${straightLineKm.toFixed(1)}km) × ${ROUTE_DISTANCE_FACTOR} — not a real route`;
      }
      if (avgSpeedKmh == null || isNaN(avgSpeedKmh)) {
        const avg = avgCyclingSpeedKmh();
        if (!avg) return res.status(400).json({ error: 'no ride history to derive avgSpeedKmh from — provide avgSpeedKmh or durationMinutes' });
        avgSpeedKmh = avg.kmh;
        speedSource = `strava average (last ${avg.sampleSize} rides)`;
      }
      durationMinutes = Math.round((distanceKm / avgSpeedKmh) * 60);
    }
    if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
      return res.status(400).json({ error: 'invalid duration' });
    }

    const combinedWeather = worstCaseWeather(destWeather, startWeather);
    const packingList = cyclingPackingList(combinedWeather);
    const nutrition = cyclingNutritionPlan(durationMinutes);

    const hours = Math.floor(durationMinutes / 60), mins = durationMinutes % 60;
    const durationLabel = hours ? `${hours}h${mins ? ` ${mins}m` : ''}` : `${mins}m`;
    const fmtWeather = (w) => `${w.text} ${w.emoji}, ${w.tempMin}–${w.tempMax}°C, precip ${w.precipProb ?? 0}%, wind ${w.windMax}km/h`;
    const descriptionDraft = [
      `Route: ${startLoc.place} → ${destLoc.place}`,
      `Weather at start (${startLoc.place}): ${fmtWeather(startWeather)}`,
      `Weather at destination (${destLoc.place}): ${fmtWeather(destWeather)}`,
      `Duration: ${durationLabel}${distanceKm ? ` (~${distanceKm}km @ ~${avgSpeedKmh}km/h)` : ''}`,
      '',
      'Pack:',
      ...packingList.map((i) => `- ${i}`),
      '',
      `Nutrition: ${nutrition.note}`,
    ].join('\n');

    res.json({
      start: startLoc.place, destination: destLoc.place, date,
      straightLineKm: straightLineKm != null ? +straightLineKm.toFixed(1) : null,
      weather: { start: startWeather, destination: destWeather },
      duration: { minutes: durationMinutes, label: durationLabel },
      distanceKm: distanceKm ?? null, distanceSource,
      avgSpeedKmh: avgSpeedKmh ?? null, speedSource,
      packingList, nutrition, descriptionDraft,
    });
  } catch (err) {
    console.error('plan-cycling-training failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Calendar load vs training correlation ---------------------------------
// Per-week work-meeting hours (Exchange) alongside training volume/effort
// (synced DB), for the last N Monday-anchored weeks.
async function buildLoadVsTraining(weeks) {
  const n = Math.min(Math.max(parseInt(weeks, 10) || 8, 1), 26);
  const now = new Date();
  const dow = (now.getDay() + 6) % 7;
  const thisMon = new Date(now); thisMon.setHours(0, 0, 0, 0); thisMon.setDate(thisMon.getDate() - dow);
  const start = new Date(thisMon.getTime() - (n - 1) * 7 * 86400000);
  const end = new Date(thisMon.getTime() + 7 * 86400000);
  const idxOf = (d) => Math.floor((new Date(d).getTime() - start.getTime()) / (7 * 86400000));

  const buckets = [];
  for (let i = 0; i < n; i++) {
    const m = new Date(start.getTime() + i * 7 * 86400000);
    buckets.push({ key: m.toISOString().slice(0, 10), label: `${m.getDate()}.${m.getMonth() + 1}.`, meetingHours: 0, meetingCount: 0, trainingKm: 0, effort: 0 });
  }

  let ews = [];
  if (EWS_URL) { try { ews = await fetchEwsRange(start, end); } catch (e) { console.error('load-vs-training ews:', e.message); } }
  for (const e of ews) {
    if (!e.end) continue;
    const i = idxOf(e.start);
    if (i < 0 || i >= n) continue;
    buckets[i].meetingHours += (new Date(e.end) - new Date(e.start)) / 3600000;
    buckets[i].meetingCount += 1;
  }
  if (Database) {
    try {
      const rows = stravaDb().prepare('SELECT start_utc, distance_m, rel_effort FROM activities WHERE start_utc >= ? AND start_utc < ?').all(start.toISOString(), end.toISOString());
      for (const r of rows) {
        const i = idxOf(r.start_utc);
        if (i < 0 || i >= n) continue;
        buckets[i].trainingKm += (r.distance_m || 0) / 1000;
        buckets[i].effort += r.rel_effort || 0;
      }
    } catch (e) { console.error('load-vs-training db:', e.message); }
  }
  const round = (v) => Math.round(v * 10) / 10;
  const maxHours = Math.max(1, ...buckets.map((b) => b.meetingHours));
  const maxEffort = Math.max(1, ...buckets.map((b) => b.effort));
  return {
    weeks: n,
    series: buckets.map((b) => ({
      ...b,
      meetingHours: round(b.meetingHours),
      trainingKm: round(b.trainingKm),
      effort: Math.round(b.effort),
      meetingPct: Math.round(b.meetingHours / maxHours * 100),
      effortPct: Math.round(b.effort / maxEffort * 100),
    })),
  };
}

app.get('/strava/load-vs-training', (req, res) => {
  stravaCached(`lvt/${parseInt(req.query.weeks, 10) || 8}`, () => buildLoadVsTraining(req.query.weeks), res);
});

// --- Task triage / aging ----------------------------------------------------
// Open VTODOs with real (ISO) start/due dates, for classification.
async function fetchTasksDetailed(url) {
  if (!url) return [];
  const headers = {};
  if (TASKS_USER && TASKS_PASS) headers.Authorization = `Basic ${Buffer.from(`${TASKS_USER}:${TASKS_PASS}`).toString('base64')}`;
  const data = await ical.async.fromURL(url, { headers });
  return Object.values(data)
    .filter((v) => v.type === 'VTODO' && v.status !== 'COMPLETED' && v.status !== 'CANCELLED')
    .map((v) => {
      const s = parseIcalDate(v.start), d = parseIcalDate(v.due);
      return { uid: v.uid || '', title: v.summary || '(ohne Titel)', start: s ? s.toISOString() : null, due: d ? d.toISOString() : null };
    });
}

// Split each list into: no due date, overdue, and due within `soonDays`.
async function buildTaskTriage(soonDays = 3) {
  const [home, work] = await Promise.all([
    fetchTasksDetailed(TASKS_HOME_URL).catch(() => []),
    fetchTasksDetailed(TASKS_WORK_URL).catch(() => []),
  ]);
  const todayStr = berlinDay(new Date());
  const today = new Date(`${todayStr}T00:00:00`);
  const soon = new Date(today.getTime() + soonDays * 86400000);
  const classify = (list) => {
    const no_due = [], overdue = [], due_soon = [];
    for (const t of list) {
      if (!t.due) { no_due.push(t); continue; }
      const d = new Date(t.due);
      if (d < today) overdue.push(t);
      else if (d < soon) due_soon.push(t);
    }
    overdue.sort((a, b) => new Date(a.due) - new Date(b.due));
    due_soon.sort((a, b) => new Date(a.due) - new Date(b.due));
    return { no_due, overdue, due_soon };
  };
  return { today: todayStr, soonDays, home: classify(home), work: classify(work) };
}

app.get('/task-triage', async (req, res) => {
  try {
    const soonDays = Math.min(Math.max(parseInt(req.query.soonDays, 10) || 3, 1), 30);
    res.json(await buildTaskTriage(soonDays));
  } catch (e) {
    console.error('task-triage failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// --- Proactive ntfy alerts ---------------------------------------------------
// Bike maintenance gone overdue, tasks overdue/due soon, Deck cards due —
// things worth a push instead of waiting for the next digest email. Skips
// sending entirely when nothing needs attention, so it stays occasional
// rather than a daily ping regardless of content.
async function buildAlertSections() {
  const sections = [];

  const bike = await bikeMaintenance.getStatus().catch(() => []);
  const bikeDue = bike.filter((it) => it.status !== 'Bereit zum Fahren');
  if (bikeDue.length) {
    sections.push([
      '🚲 Fahrrad-Wartung',
      ...bikeDue.map((it) => `• ${it.label}: ${it.status}, ${it.progress}/${it.interval} ${it.unit}`),
    ].join('\n'));
  }

  const triage = await buildTaskTriage(3).catch(() => null);
  if (triage) {
    const overdue = [...triage.home.overdue, ...triage.work.overdue];
    const dueSoon = [...triage.home.due_soon, ...triage.work.due_soon];
    if (overdue.length) {
      sections.push([`✅ Überfällige Aufgaben (${overdue.length})`, ...overdue.map((t) => `• ${t.title}`)].join('\n'));
    }
    if (dueSoon.length) {
      sections.push([`⏳ Bald fällig (${dueSoon.length})`, ...dueSoon.map((t) => `• ${t.title}`)].join('\n'));
    }
  }

  if (deck.configured()) {
    const end = new Date(Date.now() + 3 * 86400000);
    const deckDue = await deck.cardsDue(end.toISOString()).catch(() => []);
    if (deckDue.length) {
      sections.push([`📋 Deck fällig (${deckDue.length})`, ...deckDue.map((c) => `• ${c.title}`)].join('\n'));
    }
  }

  return sections;
}

async function sendAlerts() {
  const sections = await buildAlertSections();
  if (!sections.length) return { sent: false, reason: 'nothing to report' };
  await ntfy.send({
    title: 'Fällig / überfällig',
    message: sections.join('\n\n'),
    tags: 'rotating_light',
    priority: 4,
  });
  return { sent: true, sections: sections.length };
}

// Manual trigger for testing, mirrors /send-digest. Body optional; `preview:
// true` returns the composed sections without pushing to ntfy.
app.post('/send-alerts', async (req, res) => {
  try {
    if (req.body && req.body.preview) {
      return res.json({ preview: true, sections: await buildAlertSections() });
    }
    res.json({ ok: true, ...(await sendAlerts()) });
  } catch (err) {
    console.error('send-alerts failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Conflict check ---------------------------------------------------------
// Events across both calendars that overlap a proposed [start, end) slot.
app.get('/check-conflicts', async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start and end (ISO) required' });
    const s = new Date(start), e = new Date(end);
    if (isNaN(s.getTime()) || isNaN(e.getTime())) return res.status(400).json({ error: 'invalid start/end' });
    const { events } = await buildAgenda({ from: s.toISOString(), to: e.toISOString() });
    const conflicts = events.filter((ev) => {
      const es = new Date(ev.start), ee = ev.end ? new Date(ev.end) : es;
      return es < e && ee > s;
    });
    res.json({ start: s.toISOString(), end: e.toISOString(), hasConflict: conflicts.length > 0, conflicts });
  } catch (err) {
    console.error('check-conflicts failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Duplicate/orphan event check -------------------------------------------
// Meant to be called right after creating or rescheduling an event, to catch
// two classes of self-inflicted mistakes: an accidental double-create, or a
// manual "move" (create new + forgot to delete old) that left the original
// behind. Flags events with the same normalized title whose times overlap or
// sit within DUPLICATE_NEAR_MINUTES of each other, across both calendars.
const DUPLICATE_NEAR_MINUTES = 15;

function normalizeEventTitle(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function findDuplicateEvents(events) {
  const items = events
    .map((e) => ({ ...e, _title: normalizeEventTitle(e.title), _start: new Date(e.start).getTime() }))
    .filter((e) => e._title && !isNaN(e._start))
    .map((e) => ({ ...e, _end: e.end ? new Date(e.end).getTime() : e._start }));

  const groups = [];
  const used = new Set();
  for (let i = 0; i < items.length; i++) {
    if (used.has(i)) continue;
    const a = items[i];
    const cluster = [a];
    for (let j = i + 1; j < items.length; j++) {
      if (used.has(j)) continue;
      const b = items[j];
      if (b._title !== a._title) continue;
      const overlaps = a._start < b._end && b._start < a._end;
      const nearMs = DUPLICATE_NEAR_MINUTES * 60000;
      const near = Math.min(
        Math.abs(a._start - b._start),
        Math.abs(a._start - b._end),
        Math.abs(a._end - b._start),
      ) <= nearMs;
      if (overlaps || near) { cluster.push(b); used.add(j); }
    }
    if (cluster.length > 1) {
      used.add(i);
      groups.push(cluster.map((e) => ({
        cal: e.cal, title: e.title, start: e.start, end: e.end || null,
        location: e.location || null, id: e.id || null, uid: e.uid || null,
      })));
    }
  }
  return groups;
}

app.get('/check-duplicates', async (req, res) => {
  try {
    const { date, from, to } = req.query;
    if (!date && !(from && to)) return res.status(400).json({ error: 'provide date=YYYY-MM-DD or from & to' });
    const { events } = await buildAgenda({ date, from, to });
    const duplicates = findDuplicateEvents(events);
    res.json({ hasDuplicates: duplicates.length > 0, duplicates });
  } catch (err) {
    console.error('check-duplicates failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Daily planning bundle --------------------------------------------------
// Everything needed to propose a time-blocked day in one call: the day's
// agenda, open free slots, open tasks, and the weather.
app.get('/plan-day', async (req, res) => {
  try {
    const date = req.query.date || berlinDay(new Date());
    const duration = parseInt(req.query.duration || '30', 10);
    const dayStart = req.query.dayStart || '09:00';
    const dayEnd = req.query.dayEnd || '17:00';
    const agenda = await buildAgenda({ date });
    // Reuse the free-slots computation over the working window.
    const ws = new Date(`${date}T${dayStart}:00`);
    const we = new Date(`${date}T${dayEnd}:00`);
    const busy = agenda.events.filter((e) => e.end).map((e) => ({ s: new Date(e.start), e: new Date(e.end) })).sort((a, b) => a.s - b.s);
    const free = [];
    let cursor = ws;
    for (const b of busy) {
      if (b.e <= ws || b.s >= we) continue;
      if (b.s > cursor && (b.s - cursor) >= duration * 60000) free.push({ start: cursor.toISOString(), end: b.s.toISOString() });
      if (b.e > cursor) cursor = b.e;
    }
    if (we > cursor && (we - cursor) >= duration * 60000) free.push({ start: cursor.toISOString(), end: we.toISOString() });
    const weather = await weatherForRequest(date, req.query).catch(() => null);
    res.json({ date, weather, events: agenda.events, free, tasks: agenda.tasks });
  } catch (err) {
    console.error('plan-day failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Write a set of confirmed plan blocks as timed tasks. Body:
// { blocks: [{ title, start (ISO), end? | duration?, list? 'home'|'work' }] }
async function commitDayPlan(blocks) {
  if (!Array.isArray(blocks) || !blocks.length) throw new Error('blocks[] required');
  const created = [];
  for (const b of blocks) {
    if (!b.title || !b.start) throw new Error('each block needs title and start');
    const list = b.list === 'work' ? 'work' : 'home';
    const calUrl = list === 'work' ? TASKS_WORK_URL : TASKS_HOME_URL;
    const end = b.end || resolveTaskEnd({ startDate: b.start, duration: b.duration });
    const uid = await createTask(calUrl, b.title, b.start, end);
    created.push({ uid, title: b.title, start: b.start, end: end || null, list });
  }
  return created;
}

app.post('/plan-day', async (req, res) => {
  try {
    const created = await commitDayPlan((req.body || {}).blocks);
    invalidateCache(homeTasksCache); invalidateCache(workTasksCache);
    res.json({ ok: true, created });
  } catch (err) {
    console.error('commit plan-day failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Coach briefing ----------------------------------------------------
// Data bundle combining training load/recovery signals with the day's
// calendar/task load, so a single call answers "how should today (and
// this training block) go". Same philosophy as plan-day/plan-cycling-
// training: bundle facts + a couple of cheap derived flags here, leave
// the actual coaching narrative (the wording, the recommendation, the
// written report) to whoever calls this. Read-only.
async function buildCoachBriefing(date) {
  const day = date || berlinDay(new Date());
  // One shared activity list feeds readiness (its own ACWR calc + "days
  // since last"), load, and recentActivities -- these used to be 4 separate
  // /athlete/activities calls (buildStravaLoad's own fetch, buildReadiness's
  // own fetch, a duplicate direct buildStravaLoad() call, and recentRaw's
  // fetch), 2 of which were the literal same request run twice. per_page=100
  // with no age filter comfortably covers the 28-day ACWR window and the
  // last-10-for-recentActivities need in one call, for any realistic
  // training frequency.
  const sharedActs = await stravaGet('/athlete/activities?per_page=100').then(simplifyActivities).catch(() => []);

  const [readiness, load, ytd, agenda, triage, weatherData, bikeStatus, hrZones] = await Promise.all([
    buildReadiness(sharedActs).catch(() => null),
    buildStravaLoad(sharedActs).catch(() => null),
    buildStravaYtd().catch(() => null),
    buildAgenda({ date: day }).catch(() => ({ events: [], tasks: { home: [], work: [] } })),
    buildTaskTriage().catch(() => null),
    weatherForRequest(day, {}).catch(() => null),
    bikeMaintenance.getStatus().catch(() => []),
    // The athlete's configured Z1..Z5 bpm ranges -- without these, an avg_hr
    // or a get_strava_activity_zones time-in-zone number has nothing to be
    // read against.
    hrZoneBoundaries().catch(() => null),
  ]);
  const recentRaw = sharedActs;
  let weeklyTrend = null;
  try {
    // Only the multi-week trend stays DB-backed -- aggregating 8 weeks
    // needs history a 10-item live fetch can't cover, so this is the one
    // piece that can lag behind a stalled sync cron.
    weeklyTrend = {
      distanceKm: stravaSeries({ metric: 'distance', granularity: 'week', count: 8 }),
      effort: stravaSeries({ metric: 'effort', granularity: 'week', count: 8 }),
      cadence: stravaSeries({ metric: 'cadence', granularity: 'week', count: 8 }),
    };
  } catch { /* DB unavailable, leave null */ }

  // Per-session execution detail (HR, power, cadence, tempo/pace, climbing),
  // not just aggregate scores -- how the last few sessions were actually
  // ridden/run, not just how much load they added. Sourced from recentRaw
  // above (live), so this is always current, never DB-lag-affected.
  const recentActivities = recentRaw.slice(0, 5).map((a) => {
    const hasPace = a.distance_km && a.moving_time_s && /run|walk/i.test(a.sport_type || '');
    return {
      id: a.id,
      name: a.name,
      sport: a.sport_type,
      when: a.start_local,
      distance_km: a.distance_km,
      moving_time_s: a.moving_time_s,
      elevation_gain_m: a.elevation_gain_m,
      avg_hr: a.avg_hr,
      max_hr: a.max_hr,
      avg_watts: a.avg_watts,
      avg_cadence: a.avg_cadence,
      avg_speed_kmh: a.avg_speed_kmh,
      pace_min_per_km: hasPace ? +((a.moving_time_s / 60) / a.distance_km).toFixed(2) : null,
      relative_effort: a.relative_effort,
    };
  });
  // Zone-time breakdown for every recent activity that has HR data, not
  // just the single most recent one -- one live Strava call per activity
  // (up to 5), run concurrently. Cheap enough for an interactive coaching
  // call (not a polled endpoint), and each one gets attached to its own
  // recentActivities entry so "how was each of the last few sessions
  // actually run" doesn't stop at averages.
  await Promise.all(recentActivities.map(async (act) => {
    if (act.avg_hr == null) return;
    const dist = await zoneDistributionForActivity(act.id, {});
    act.hrZones = dist ? dist.zones : null;
  }));

  // The most recent HR-bearing activity is, in the common case, already one
  // of the 5 above -- reuse its hrZones instead of a second live zone call
  // for the same activity. Only falls back to a fresh lookup if it isn't
  // (e.g. after a run of several non-HR activities pushed it past index 5).
  const firstHr = recentActivities.find((a) => a.avg_hr != null);
  const latestZones = firstHr
    ? { id: firstHr.id, activity: firstHr.name, sport: firstHr.sport, when: firstHr.when, zones: firstHr.hrZones || null }
    : await latestHrZones(recentRaw).catch(() => null);

  // Cheap derived flags, computed once here rather than by every caller.
  const meetingHours = agenda.events
    .filter((e) => e.cal === 'work' && e.end)
    .reduce((t, e) => t + (new Date(e.end) - new Date(e.start)) / 3600000, 0);

  return {
    date: day,
    readiness,
    load,
    ytd,
    weeklyTrend,
    recentActivities,
    hrZoneBoundaries: hrZones,
    latestActivityHrZones: latestZones,
    weather: weatherData,
    calendar: { meetingHours: +meetingHours.toFixed(1), eventCount: agenda.events.length },
    tasks: triage,
    bikeMaintenanceDue: (bikeStatus || []).filter((i) => i.status !== 'Bereit zum Fahren'),
  };
}

app.get('/coach-briefing', async (req, res) => {
  try {
    res.json(await buildCoachBriefing(req.query.date));
  } catch (err) {
    console.error('coach-briefing failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Full-detail training data for an arbitrary date range -- "look at
// everything from 17 July to now" style requests, not just the last 5
// activities coach_briefing carries. Per-activity detail and the weekly
// trend are DB-only (cheap, any range length); real zone-time is fetched
// live for only the hardest/longest/most-recent activity in the range
// (bounded to 3 calls regardless of range length) so a multi-week range
// can't repeat the rate-limit hit that came from doing this per-activity
// for all 5 in coach_briefing. Every other activity gets a cheap
// average-HR-based zone label instead (hrZoneAvg) -- which zone the
// activity's *average* HR falls in, not true time-in-zone.
function hrZoneForValue(hr, boundaries) {
  if (hr == null || !boundaries) return null;
  for (const z of boundaries) {
    const top = z.range.endsWith('+');
    const [lo, hi] = z.range.replace('+', '').split('-').map(Number);
    if (hr >= lo && (top || hr <= hi)) return z.zone;
  }
  return null;
}

async function buildCoachRange(fromStr, toStr) {
  const fromIso = fromStr.length === 10 ? `${fromStr}T00:00:00Z` : fromStr;
  const toIso = toStr.length === 10 ? `${toStr}T23:59:59Z` : toStr;

  const boundaries = await hrZoneBoundaries().catch(() => null);
  const rows = stravaDb().prepare(`
    SELECT id, name, sport, start_local, distance_m, moving_s, elev_m, avg_hr, max_hr, avg_watts, avg_cadence, rel_effort
    FROM activities WHERE start_utc >= ? AND start_utc <= ? ORDER BY start_utc ASC
  `).all(fromIso, toIso);

  const activities = rows.map((r) => {
    const km = r.distance_m != null ? r.distance_m / 1000 : null;
    const hasPace = km && r.moving_s && /run|walk/i.test(r.sport || '');
    return {
      id: r.id,
      name: r.name,
      sport: r.sport,
      when: r.start_local,
      distance_km: km != null ? +km.toFixed(2) : null,
      moving_time_s: r.moving_s,
      elevation_gain_m: r.elev_m,
      avg_hr: r.avg_hr,
      max_hr: r.max_hr,
      avg_watts: r.avg_watts,
      avg_cadence: r.avg_cadence,
      avg_speed_kmh: km && r.moving_s ? +(km / (r.moving_s / 3600)).toFixed(1) : null,
      pace_min_per_km: hasPace ? +((r.moving_s / 60) / km).toFixed(2) : null,
      relative_effort: r.rel_effort,
      hrZoneAvg: hrZoneForValue(r.avg_hr, boundaries),
    };
  });

  // Notable sessions get real zone-time; everyone else keeps hrZoneAvg only.
  const withHr = activities.filter((a) => a.avg_hr != null);
  const notable = [];
  if (withHr.length) {
    const hardest = [...withHr].sort((a, b) => (b.relative_effort || 0) - (a.relative_effort || 0))[0];
    const longest = [...withHr].sort((a, b) => (b.moving_time_s || 0) - (a.moving_time_s || 0))[0];
    const latest = withHr[withHr.length - 1];
    for (const a of [hardest, longest, latest]) if (a && !notable.includes(a)) notable.push(a);
  }
  await Promise.all(notable.map(async (a) => {
    const dist = await zoneDistributionForActivity(a.id, {});
    a.hrZones = dist ? dist.zones : null;
  }));

  let weeklyTrend = null;
  try {
    weeklyTrend = {
      distanceKm: stravaSeries({ metric: 'distance', granularity: 'week', from: fromIso, to: toIso }),
      effort: stravaSeries({ metric: 'effort', granularity: 'week', from: fromIso, to: toIso }),
      cadence: stravaSeries({ metric: 'cadence', granularity: 'week', from: fromIso, to: toIso }),
      hr: stravaSeries({ metric: 'hr', granularity: 'week', from: fromIso, to: toIso }),
    };
  } catch { /* DB unavailable */ }

  const totals = activities.reduce((t, a) => {
    t.count += 1;
    t.km += a.distance_km || 0;
    t.hours += (a.moving_time_s || 0) / 3600;
    t.elevation_m += a.elevation_gain_m || 0;
    t.effort += a.relative_effort || 0;
    return t;
  }, { count: 0, km: 0, hours: 0, elevation_m: 0, effort: 0 });
  totals.km = +totals.km.toFixed(1);
  totals.hours = +totals.hours.toFixed(1);
  totals.elevation_m = Math.round(totals.elevation_m);

  return { from: fromStr, to: toStr, totals, hrZoneBoundaries: boundaries, weeklyTrend, activities };
}

app.get('/coach-range', async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'provide from and to (YYYY-MM-DD)' });
    res.json(await buildCoachRange(from, to));
  } catch (err) {
    console.error('coach-range failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Status -----------------------------------------------------------------
function cacheInfo(c) {
  return { populated: !!c.data, ageSeconds: c.data ? Math.round((Date.now() - c.ts) / 1000) : null };
}
// ISO timestamp -> "29.06.2026, 20:00" in the digest timezone (or null).
const fmtStamp = new Intl.DateTimeFormat('de-DE', {
  timeZone: DIGEST_TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
});
function stampLabel(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : fmtStamp.format(d).replace(',', ' ·');
}
async function buildStatus() {
  const status = { ok: true, now: new Date().toISOString(), uptimeSeconds: Math.round(process.uptime()) };
  status.caches = {
    ews: cacheInfo(ewsCache), ics: cacheInfo(icsCache),
    homeTasks: cacheInfo(homeTasksCache), workTasks: cacheInfo(workTasksCache),
    strava: { keys: [...stravaCache.keys()] }, weather: { days: weather.cacheKeys() },
  };
  status.strava = { configured: !!(STRAVA_CLIENT_ID && STRAVA_REFRESH_TOKEN), lastSync: { ...lastStravaSync, atLabel: stampLabel(lastStravaSync.at) }, dbActivities: null };
  if (Database) { try { status.strava.dbActivities = stravaDb().prepare('SELECT COUNT(*) c FROM activities').get().c; } catch { /* ignore */ } }
  status.digests = {
    daily: { enabled: DIGEST_ENABLED, cron: DIGEST_CRON, tz: DIGEST_TZ, configured: !!(SMTP_HOST && DIGEST_TO) },
    weekly: { enabled: WEEKLY_ENABLED, cron: WEEKLY_CRON, tz: DIGEST_TZ, configured: !!(SMTP_HOST && WEEKLY_TO) },
  };
  status.ntfy = { configured: ntfy.configured(), cron: DIGEST_CRON, tz: DIGEST_TZ };
  status.embeddings = {
    configured: !!Database && siyuan.isConfigured(),
    lastSync: { ...embeddings.getSyncStatus(), atLabel: stampLabel(embeddings.getSyncStatus().at) },
    indexedNotes: null,
  };
  if (Database) { try { status.embeddings.indexedNotes = embeddings.embeddingsDb().prepare('SELECT COUNT(DISTINCT docId) c FROM note_chunks').get().c; } catch { /* ignore */ } }
  status.health = { configured: !!Database, lastIngest: null };
  if (Database) {
    try {
      const row = healthDb().prepare('SELECT received_at, bytes FROM health_raw ORDER BY id DESC LIMIT 1').get();
      if (row) status.health.lastIngest = { at: row.received_at, atLabel: stampLabel(row.received_at), bytes: row.bytes };
    } catch { /* ignore */ }
  }
  status.backends = { exchange: !!EWS_URL, nextcloud: !!ICS_URL, tasksHome: !!TASKS_HOME_URL, tasksWork: !!TASKS_WORK_URL, weather: true };
  return status;
}

app.get('/status', async (_req, res) => {
  try { res.json(await buildStatus()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/health', (_, res) => res.json({ ok: true }));

// Shift a 5-field cron expression one hour earlier, for pre-warming caches
// ahead of a scheduled job. Only handles a plain numeric hour field; returns
// null (caller skips) for hour 0 or anything fancier, since shifting those
// would land on the wrong day.
function cronHourEarlier(expr) {
  const f = String(expr).trim().split(/\s+/);
  if (f.length !== 5 || !/^\d+$/.test(f[1])) return null;
  const h = parseInt(f[1], 10);
  if (h < 1 || h > 23) return null;
  f[1] = String(h - 1);
  return f.join(' ');
}

app.listen(PORT, () => {
  console.log(`ics-proxy listening on ${PORT}`);
  if (EWS_URL) prewarm(fetchEwsEvents, ewsCache, 'ews-events');
  if (ICS_URL) prewarm(fetchIcsEvents, icsCache, 'ics-events');
  if (TASKS_HOME_URL) prewarm(() => fetchTasks(TASKS_HOME_URL), homeTasksCache, 'home-tasks');
  if (TASKS_WORK_URL) prewarm(() => fetchTasks(TASKS_WORK_URL), workTasksCache, 'work-tasks');

  if (DIGEST_ENABLED) {
    if (!cron.validate(DIGEST_CRON)) {
      console.error(`digest disabled: invalid DIGEST_CRON "${DIGEST_CRON}"`);
    } else if (!SMTP_HOST || !DIGEST_TO) {
      console.error('digest disabled: SMTP_HOST and DIGEST_TO must be set');
    } else {
      cron.schedule(DIGEST_CRON, () => {
        sendDigest()
          .then((r) => console.log(`digest sent to ${DIGEST_TO}:`, r.messageId))
          .catch((err) => console.error('digest send failed:', err.message));
      }, { timezone: DIGEST_TZ });
      console.log(`digest scheduled: "${DIGEST_CRON}" ${DIGEST_TZ} -> ${DIGEST_TO}`);
      // Warm the weather cache an hour ahead of the digest, so a transient
      // Open-Meteo outage at send time falls back to this stale entry instead
      // of dropping the weather block from the mail.
      const warmCron = cronHourEarlier(DIGEST_CRON);
      if (warmCron && cron.validate(warmCron)) {
        cron.schedule(warmCron, () => {
          weatherForRequest(berlinDay(new Date()))
            .then(() => console.log('digest weather prewarmed'))
            .catch((e) => console.error('digest weather prewarm failed:', e.message));
        }, { timezone: DIGEST_TZ });
        console.log(`digest weather prewarm scheduled: "${warmCron}" ${DIGEST_TZ}`);
      }
    }
  }

  if (ntfy.configured()) {
    if (!cron.validate(DIGEST_CRON)) {
      console.error(`ntfy alerts disabled: invalid DIGEST_CRON "${DIGEST_CRON}"`);
    } else {
      cron.schedule(DIGEST_CRON, () => {
        sendAlerts()
          .then((r) => console.log('ntfy alerts:', r.sent ? `sent (${r.sections} sections)` : r.reason))
          .catch((err) => console.error('ntfy alerts failed:', err.message));
      }, { timezone: DIGEST_TZ });
      console.log(`ntfy alerts scheduled: "${DIGEST_CRON}" ${DIGEST_TZ}`);
    }
  }

  if (WEEKLY_ENABLED) {
    if (!cron.validate(WEEKLY_CRON)) {
      console.error(`weekly digest disabled: invalid WEEKLY_DIGEST_CRON "${WEEKLY_CRON}"`);
    } else if (!SMTP_HOST || !WEEKLY_TO) {
      console.error('weekly digest disabled: SMTP_HOST and WEEKLY_DIGEST_TO must be set');
    } else {
      cron.schedule(WEEKLY_CRON, () => {
        // Events/tasks preview the week containing today (a Monday send ->
        // this Mon-Sun). Strava's own recap block is coded as start-7/end-7,
        // which lands on last week as intended, matching its "Letzte Woche
        // Training" heading.
        sendWeeklyDigest()
          .then((r) => console.log(`weekly digest sent to ${WEEKLY_TO}:`, r.messageId))
          .catch((err) => console.error('weekly digest send failed:', err.message));
      }, { timezone: DIGEST_TZ });
      console.log(`weekly digest scheduled: "${WEEKLY_CRON}" ${DIGEST_TZ} -> ${WEEKLY_TO}`);
    }
  }

  // Strava history: backfill on first boot, then incremental sync every 30 min.
  if (Database && STRAVA_CLIENT_ID && STRAVA_REFRESH_TOKEN) {
    try {
      const count = stravaDb().prepare('SELECT COUNT(*) c FROM activities').get().c;
      stravaSync(count === 0)
        .then(r => console.log(`strava sync (${count === 0 ? 'backfill' : 'incremental'}):`, JSON.stringify(r)))
        .catch(e => console.error('strava sync failed:', e.message));
      // Prewarm the aggregate caches so the first widget call never hits a cold
      // (slow, multi-request) Strava fetch and time out in Glance. Re-warmed by
      // the half-hourly cron below, so a rarely visited page never serves data
      // that is hours old (the serve-stale cache only refreshes on request).
      const warm = (key, fn) => fn()
        .then(data => { stravaCache.set(key, { ts: Date.now(), data }); console.log(`strava prewarm ok: ${key}`); })
        .catch(e => console.error(`strava prewarm failed: ${key}:`, e.message));
      const warmAll = () => {
        warm('stats', buildStravaStats);
        warm('ytd', buildStravaYtd);
        warm('load', buildStravaLoad);
        warm('readiness', buildReadiness);
        warm('gear', () => stravaGet('/athlete').then((a) => ({ bikes: a.bikes || [], shoes: a.shoes || [] })));
      };
      warmAll();
      cron.schedule('*/30 * * * *', () => {
        stravaSync(false)
          .then(r => console.log('strava sync:', JSON.stringify(r)))
          .catch(e => console.error('strava sync failed:', e.message))
          .finally(warmAll);
      }, { timezone: DIGEST_TZ });
      console.log('strava db sync scheduled: every 30 min');
    } catch (e) {
      console.error('strava db init failed:', e.message);
    }
  }

  // Semantic search index: backfill on first boot, then reconcile hourly for
  // notes changed directly in the SiYuan UI (writes made via our own
  // create/update/delete-note routes are already re-embedded synchronously,
  // see the siyuan routes above — this cron is just the catch-all).
  if (Database && siyuan.isConfigured()) {
    try {
      const count = embeddings.embeddingsDb().prepare('SELECT COUNT(*) c FROM note_chunks').get().c;
      embeddings.syncEmbeddings(count === 0)
        .then(r => console.log(`embeddings sync (${count === 0 ? 'backfill' : 'incremental'}):`, JSON.stringify(r)))
        .catch(e => console.error('embeddings sync failed:', e.message));
      cron.schedule('0 * * * *', () => {
        embeddings.syncEmbeddings(false)
          .then(r => console.log('embeddings sync:', JSON.stringify(r)))
          .catch(e => console.error('embeddings sync failed:', e.message));
      }, { timezone: DIGEST_TZ });
      console.log('embeddings sync scheduled: hourly');
    } catch (e) {
      console.error('embeddings db init failed:', e.message);
    }
  }
});

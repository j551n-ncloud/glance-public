import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { createRemoteJWKSet, jwtVerify } from 'jose';

// The MCP server is a thin wrapper over ics-proxy. It runs inside the Docker
// network and reaches the proxy directly. GET endpoints need no token over the
// internal network; POST endpoints require the shared API_TOKEN.
const PROXY = process.env.PROXY_URL || 'http://ics-proxy:3000';
const API_TOKEN = process.env.API_TOKEN || '';
const PORT = process.env.PORT || 3001;

// OAuth 2.1 resource-server config (for claude.ai web custom connectors).
// Pocket ID is the authorization server; we just validate the bearer JWTs.
const OIDC_ISSUER = (process.env.OIDC_ISSUER || '').replace(/\/$/, '');     // https://auth.example.com
const OIDC_CLIENT_ID = process.env.OIDC_CLIENT_ID || '';                    // the registered client id
const PUBLIC_BASE = (process.env.PUBLIC_BASE || '').replace(/\/$/, '');     // https://dash.example.com
const MCP_RESOURCE = process.env.MCP_RESOURCE || (PUBLIC_BASE ? `${PUBLIC_BASE}/mcp` : '');

async function proxyGet(path) {
  const r = await fetch(`${PROXY}${path}`, { headers: { 'X-Api-Token': API_TOKEN } });
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status}`);
  return r.json();
}

async function proxyPost(path, body) {
  const r = await fetch(`${PROXY}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Token': API_TOKEN },
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`POST ${path} -> ${r.status}: ${txt}`);
  return txt ? JSON.parse(txt) : {};
}

function text(obj) {
  return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] };
}

// --- openGym bridge (optional) -----------------------------------------
// openGym (self-hosted gym/body-weight tracker, ../openGym) ships its own read-only MCP
// tools as plain Node ESM (openGym/mcp/src/tools.js) that read the same ./data JSON files
// its api container writes, computed by the same pure functions its React UI uses
// (openGym/frontend/src/lib/*.js) — see openGym/mcp/README.md. Rather than reimplement that
// training math (1RM, muscle balance, progression) a second time, we import it directly and
// re-expose it under this server, prefixed gym_*. docker-compose.yml bind-mounts the two
// source dirs plus ./openGym/data at /app/opengym so the relative imports inside tools.js
// (../../frontend/src/lib/...) resolve, and zod (a bare specifier tools.js imports) resolves
// by walking up to this container's own node_modules — see docker-compose.yml comment.
// Not in the Docker build upstream, so this stays best-effort: if ./openGym isn't mounted
// (a stack running without it), this quietly registers zero gym_* tools instead of crashing
// the whole mcp service that calendar/tasks/Strava/etc. all depend on.
const OPENGYM_ROOT = process.env.OPENGYM_ROOT || '/app/opengym';
let gymTools = [];
try {
  ({ TOOLS: gymTools } = await import(`${OPENGYM_ROOT}/mcp/src/tools.js`));
  console.log(`[glance-mcp] openGym bridge: ${gymTools.length} tools loaded from ${OPENGYM_ROOT}`);
} catch (e) {
  console.warn(`[glance-mcp] openGym bridge disabled (${e.message})`);
}

function registerGymTools(server) {
  for (const t of gymTools) {
    server.tool(
      `gym_${t.name}`,
      `[openGym] ${t.description}`,
      t.schema,
      async (params) => {
        try {
          return text(t.handler(params || {}));
        } catch (err) {
          return { isError: true, content: [{ type: 'text', text: `${err.code || 'ERROR'}: ${err.message}` }] };
        }
      },
    );
  }
}

function buildServer() {
  const server = new McpServer({ name: 'glance', version: '1.0.0' });

  server.tool(
    'list_events',
    'Upcoming Exchange (work) calendar events. Returns { events, todayCount }. Event start is UTC ISO; user is Europe/Berlin.',
    {},
    async () => text(await proxyGet('/events')),
  );

  server.tool(
    'list_ics_events',
    'Upcoming Nextcloud (home) ICS calendar events.',
    {},
    async () => text(await proxyGet('/ics-events')),
  );

  server.tool(
    'list_tasks',
    'Open tasks from a list (home or work). Each task has title, start, due, uid.',
    { list: z.enum(['home', 'work']) },
    async ({ list }) => text(await proxyGet(`/${list}-tasks`)),
  );

  server.tool(
    'create_task',
    'Create a task in a list. startDate/endDate are YYYY-MM-DD (all-day) or a full ISO datetime with offset for a specific time. For a timed block, pass a timed startDate plus duration (minutes) instead of endDate. Confirm with the user before creating.',
    {
      list: z.enum(['home', 'work']),
      title: z.string(),
      startDate: z.string().optional().describe('YYYY-MM-DD (all-day) or ISO datetime, e.g. 2026-07-02T14:00:00+02:00'),
      endDate: z.string().optional().describe('YYYY-MM-DD (all-day) or ISO datetime; the due date/time'),
      duration: z.number().optional().describe('block length in minutes; requires a timed startDate, sets due = start + duration (use instead of endDate)'),
    },
    async ({ list, title, startDate, endDate, duration }) =>
      text(await proxyPost(`/${list}-tasks`, { title, startDate, endDate, duration })),
  );

  server.tool(
    'complete_task',
    'Mark a task complete by uid. Confirm the exact task with the user first, like any other write.',
    { list: z.enum(['home', 'work']), uid: z.string() },
    async ({ list, uid }) => text(await proxyPost(`/complete-${list}-task`, { uid })),
  );

  server.tool(
    'rename_task',
    'Rename a task (change its title) by uid. Confirm the new title with the user first, like any other write.',
    { list: z.enum(['home', 'work']), uid: z.string(), newTitle: z.string() },
    async ({ list, uid, newTitle }) => text(await proxyPost(`/rename-${list}-task`, { uid, newTitle })),
  );

  server.tool(
    'create_event',
    'Create an event in the Nextcloud (home) calendar. start/end: YYYY-MM-DD for an all-day event, or ISO 8601 datetime with offset for a timed one. description is a free-text note that shows in the calendar app (not in the Glance widget). Confirm with the user first.',
    {
      summary: z.string(),
      start: z.string().describe('YYYY-MM-DD (all-day) or ISO datetime, e.g. 2026-06-30T14:00:00+02:00'),
      end: z.string().optional().describe('same format; defaults to +1h for timed events'),
      location: z.string().optional(),
      description: z.string().optional().describe('free-text note/body for the event; supports newlines'),
    },
    async ({ summary, start, end, location, description }) =>
      text(await proxyPost('/ics-events', { summary, start, end, location, description })),
  );

  server.tool(
    'create_meeting',
    'Create an Exchange meeting. With attendees it SENDS invites to them; without attendees it is a private self-block. Always confirm with the user before calling.',
    {
      subject: z.string(),
      start: z.string().describe('ISO 8601 with offset, e.g. 2026-06-30T14:00:00+02:00'),
      end: z.string().describe('ISO 8601 with offset'),
      location: z.string().optional(),
      attendees: z.array(z.string()).optional(),
      body: z.string().optional(),
    },
    async (args) => text(await proxyPost('/meetings', args)),
  );

  server.tool(
    'search_attendees',
    'Search the Exchange directory (global address list) and contacts for people to invite to a meeting. Returns matches with their email first, plus name, department, office, phone and mobile. Use this to resolve a partial name into an exact email before calling create_meeting. Read-only.',
    { query: z.string().describe('partial name or email, at least 2 characters, e.g. "smith" or "anna"') },
    async ({ query }) => text(await proxyGet(`/resolve-attendees?q=${encodeURIComponent(query)}`)),
  );

  server.tool(
    'delete_meeting',
    'Delete/cancel an Exchange (work) calendar event by its EWS itemId (the "id" field from list_events). Sends cancellations to attendees if any. For a recurring event, list_events returns individual occurrences, so deleting one id removes ONLY that single instance. It REFUSES to delete a recurring series master unless allowSeries:true is passed. Always confirm the exact event (title + date/time) with the user before calling.',
    {
      id: z.string().describe('EWS itemId from list_events (field "id")'),
      allowSeries: z.boolean().optional().describe('set true only to delete an entire recurring series on purpose'),
    },
    async ({ id, allowSeries }) => text(await proxyPost('/delete-exchange-event', { id, allowSeries })),
  );

  server.tool(
    'reschedule_meeting',
    'Move an Exchange (work) calendar event to a new start/end by its EWS itemId (the "id" field from list_events). Notifies attendees of the change. For a recurring event, list_events returns occurrences, so moving one id shifts ONLY that instance; it REFUSES a recurring series master unless allowSeries:true. Always confirm the exact event and new time with the user first.',
    {
      id: z.string().describe('EWS itemId from list_events (field "id")'),
      start: z.string().describe('new start, ISO 8601 with offset, e.g. 2026-06-30T10:30:00+02:00'),
      end: z.string().describe('new end, ISO 8601 with offset'),
      allowSeries: z.boolean().optional().describe('set true only to move an entire recurring series on purpose'),
    },
    async ({ id, start, end, allowSeries }) => text(await proxyPost('/reschedule-exchange-event', { id, start, end, allowSeries })),
  );

  server.tool(
    'search_directory',
    'Look up a colleague / employee in the Exchange directory (global address list) and contacts. Returns matches with email, full name, department, office location, business phone and mobile. Use to find someone\'s contact details (email, phone, office), not just for meetings. Read-only.',
    { query: z.string().describe('partial name or email, at least 2 characters, e.g. "thommen" or "frank"') },
    async ({ query }) => text(await proxyGet(`/resolve-attendees?q=${encodeURIComponent(query)}`)),
  );

  server.tool(
    'get_agenda',
    'Merged agenda (work + home events, sorted) plus open tasks. Pass date for a single day, or from & to for a window. Events include past ones within the window. Event cal is "work" or "home".',
    {
      date: z.string().optional().describe('YYYY-MM-DD for a single day'),
      from: z.string().optional().describe('ISO datetime, window start (use with to)'),
      to: z.string().optional().describe('ISO datetime, window end (use with from)'),
    },
    async ({ date, from, to }) => {
      const qs = new URLSearchParams();
      if (date) qs.set('date', date);
      if (from) qs.set('from', from);
      if (to) qs.set('to', to);
      return text(await proxyGet(`/agenda?${qs.toString()}`));
    },
  );

  server.tool(
    'find_free_slots',
    'Find open time slots on a day across both calendars, given a minimum duration in minutes. Defaults: duration 30, working hours 09:00-17:00 (Europe/Berlin).',
    {
      date: z.string().describe('YYYY-MM-DD'),
      duration: z.number().optional().describe('minimum slot length in minutes (default 30)'),
      dayStart: z.string().optional().describe('HH:MM (default 09:00)'),
      dayEnd: z.string().optional().describe('HH:MM (default 17:00)'),
    },
    async ({ date, duration, dayStart, dayEnd }) => {
      const qs = new URLSearchParams({ date });
      if (duration) qs.set('duration', String(duration));
      if (dayStart) qs.set('dayStart', dayStart);
      if (dayEnd) qs.set('dayEnd', dayEnd);
      return text(await proxyGet(`/free-slots?${qs.toString()}`));
    },
  );

  server.tool(
    'search',
    'Keyword search over events and open tasks. Matches event title/location and task title. Default window is today..+90 days; pass from/to (ISO) to widen, e.g. to search the past.',
    {
      query: z.string(),
      from: z.string().optional().describe('ISO datetime, window start'),
      to: z.string().optional().describe('ISO datetime, window end'),
    },
    async ({ query, from, to }) => {
      const qs = new URLSearchParams({ q: query });
      if (from) qs.set('from', from);
      if (to) qs.set('to', to);
      return text(await proxyGet(`/search?${qs.toString()}`));
    },
  );

  server.tool(
    'delete_event',
    'Delete a Nextcloud (home) calendar event by uid. Exchange (work) events are not supported. Confirm with the user first.',
    { uid: z.string() },
    async ({ uid }) => text(await proxyPost('/delete-ics-event', { uid })),
  );

  server.tool(
    'reschedule_event',
    'Move a Nextcloud (home) event to a new time by uid. start/end: YYYY-MM-DD (all-day) or ISO datetime with offset. Exchange (work) events are not supported. Confirm with the user first.',
    {
      uid: z.string(),
      start: z.string().describe('YYYY-MM-DD or ISO datetime, e.g. 2026-06-30T14:00:00+02:00'),
      end: z.string().optional().describe('same format; defaults to +1h for timed events'),
    },
    async ({ uid, start, end }) => text(await proxyPost('/reschedule-ics-event', { uid, start, end })),
  );

  server.tool(
    'update_event',
    'Update a Nextcloud (home) event by uid: set/change its location, note (description), rename it (summary), and/or move it (start/end). Provide only the fields to change. Exchange (work) events are not supported. Confirm with the user first.',
    {
      uid: z.string(),
      start: z.string().optional().describe('YYYY-MM-DD or ISO datetime with offset'),
      end: z.string().optional().describe('same format as start'),
      location: z.string().optional(),
      summary: z.string().optional().describe('new title'),
      description: z.string().optional().describe('free-text note/body shown in the calendar app; supports newlines'),
    },
    async ({ uid, start, end, location, summary, description }) =>
      text(await proxyPost('/update-ics-event', { uid, start, end, location, summary, description })),
  );

  server.tool(
    'delete_task',
    'Delete a task from a list (home or work) by uid. Confirm with the user first.',
    { list: z.enum(['home', 'work']), uid: z.string() },
    async ({ list, uid }) => text(await proxyPost(`/delete-${list}-task`, { uid })),
  );

  server.tool(
    'set_task_dates',
    'Set or change a task\'s start and/or due date by uid. Each is YYYY-MM-DD (all-day) or a full ISO datetime with offset for a specific time. For a timed block, pass a timed startDate plus duration (minutes) instead of endDate. Confirm with the user first.',
    {
      list: z.enum(['home', 'work']),
      uid: z.string(),
      startDate: z.string().optional().describe('YYYY-MM-DD (all-day) or ISO datetime, e.g. 2026-07-02T14:00:00+02:00'),
      endDate: z.string().optional().describe('YYYY-MM-DD (all-day) or ISO datetime; the due date/time'),
      duration: z.number().optional().describe('block length in minutes; requires a timed startDate, sets due = start + duration (use instead of endDate)'),
    },
    async ({ list, uid, startDate, endDate, duration }) =>
      text(await proxyPost(`/set-${list}-task-dates`, { uid, startDate, endDate, duration })),
  );

  server.tool(
    'plan_day',
    'Get everything needed to propose a time-blocked schedule for a day: the merged agenda (work + home events), the open free slots in working hours, all open tasks, and the weather. Use this to draft a plan, show it to the user, and after they confirm write it with commit_day_plan. Read-only.',
    {
      date: z.string().optional().describe('YYYY-MM-DD (default today, Europe/Berlin)'),
      duration: z.number().optional().describe('minimum free-slot length in minutes (default 30)'),
      dayStart: z.string().optional().describe('working-hours start HH:MM (default 09:00)'),
      dayEnd: z.string().optional().describe('working-hours end HH:MM (default 17:00)'),
    },
    async ({ date, duration, dayStart, dayEnd }) => {
      const qs = new URLSearchParams();
      if (date) qs.set('date', date);
      if (duration) qs.set('duration', String(duration));
      if (dayStart) qs.set('dayStart', dayStart);
      if (dayEnd) qs.set('dayEnd', dayEnd);
      const q = qs.toString();
      return text(await proxyGet(`/plan-day${q ? `?${q}` : ''}`));
    },
  );

  server.tool(
    'commit_day_plan',
    'Write a set of confirmed plan blocks as timed tasks (time blocks). Each block becomes a task with a start and a due (start + duration, or an explicit end). ONLY call after the user has approved the exact blocks. blocks: [{ title, start (ISO with offset), duration (minutes) OR end (ISO), list ("home" default | "work") }].',
    {
      blocks: z.array(z.object({
        title: z.string(),
        start: z.string().describe('ISO datetime with offset, e.g. 2026-07-02T09:00:00+02:00'),
        duration: z.number().optional().describe('block length in minutes (sets due = start + duration)'),
        end: z.string().optional().describe('explicit end ISO datetime (use instead of duration)'),
        list: z.enum(['home', 'work']).optional().describe('which task list (default home)'),
      })).describe('the approved time blocks to create'),
    },
    async ({ blocks }) => text(await proxyPost('/plan-day', { blocks })),
  );

  server.tool(
    'coach_briefing',
    'Data bundle for a training/day coaching read: readiness (score, ACWR, resting HR/HRV/sleep vs baseline), training load status, an 8-week distance+effort+cadence trend, this year\'s sport totals, the athlete\'s configured HR zone boundaries (Z1..Z5 bpm ranges), today\'s calendar load (meeting hours, event count), open task triage, weather, and any bike maintenance due. '
      + 'recentActivities (last 5) has real per-session execution detail -- avg/max HR, watts, cadence, pace/speed, elevation gain, relative effort, AND its own HR zone time-in-zone breakdown (hrZones: minutes+percent per zone) for every one of the 5 that has HR data, not just the latest. Read it per-activity, not only as an aggregate trend: a proper coaching read calls out something concrete a specific session shows (cadence drifting, HR climbing into a zone earlier than a comparable past session, a zone-time split that does not match the session\'s intent) and says what to do about it -- not a generic recap of totals. '
      + '(latestActivityHrZones duplicates recentActivities[0]\'s own hrZones in the common case; it only differs if the most recent HR-bearing session is older than the last 5 shown, e.g. after a run of non-HR activities.) '
      + 'For laps/splits/PRs/route/second-by-second data on one specific session beyond what recentActivities carries, follow up with get_strava_activity / get_strava_activity_zones / get_strava_streams for that one activity id -- not for all 5 by default (that is expensive and can hit Strava\'s rate limit). '
      + 'recentActivities and latestActivityHrZones are sourced live (not the DB-backed history table), so a just-finished activity shows up immediately -- no separate list_strava_activities cross-check needed for that. Only weeklyTrend (the 8-week aggregate) is DB-backed and can lag behind a sync that is currently rate-limited by Strava (check /status\'s strava.lastSync if a trend looks stale). '
      + 'Returns facts and cheap derived numbers only, no narrative -- use this to write the actual coaching read/recommendation yourself (same pattern as plan_day). Read-only.',
    {
      date: z.string().optional().describe('YYYY-MM-DD (default today, Europe/Berlin) -- affects the calendar/task slice, not the training trend'),
    },
    async ({ date }) => {
      const qs = date ? `?date=${encodeURIComponent(date)}` : '';
      return text(await proxyGet(`/coach-briefing${qs}`));
    },
  );

  server.tool(
    'coach_range',
    'Full-detail training data for an arbitrary date range (e.g. "everything from 17 July to now") -- not just the last 5 activities coach_briefing carries. Returns every activity in the range with the same per-session detail (HR, watts, cadence, pace/speed, elevation, effort), a cheap average-HR-based zone label per activity (hrZoneAvg -- which zone the activity\'s AVERAGE HR falls in), real time-in-zone (hrZones) for only the hardest/longest/most-recent activity in the range (bounded to 3 live calls regardless of range length, to avoid Strava rate limits over a long window), a week-by-week distance/effort/cadence/HR trend across the range, and totals. '
      + 'This is meant to be charted, not just read as a table: a capable client (one that can render/publish a visual page, e.g. Claude Code via its Artifact tool) should build exactly these 4 charts from this data -- '
      + '(1) HR zone distribution: the real per-zone minutes from hrZones for the hardest/longest/most-recent activity, plus an aggregate tally of every other activity\'s hrZoneAvg (label that half as an average-based approximation, not true time-in-zone); '
      + '(2) cadence per activity across the range, one point per activity, date on the x-axis; '
      + '(3) avg_speed_kmh (or pace_min_per_km for runs/walks) per activity across the range, same shape; '
      + '(4) weekly volume and effort as bars, straight from weeklyTrend. '
      + 'A client that cannot render a visual page should say so rather than only returning a text table silently substituting for the chart. '
      + 'This is DB-backed (synced every 30 minutes, not live) -- a range that includes the last ~30 minutes may be missing an activity that just finished, or the sync itself may currently be rate-limited by Strava (check /status\'s strava.lastSync). If a "to" bound near now is missing something the user expects, cross-check with list_strava_activities (live) rather than assuming it does not exist. '
      + 'Facts only, no narrative here -- that is the caller\'s job.',
    {
      from: z.string().describe('YYYY-MM-DD, start of range'),
      to: z.string().describe('YYYY-MM-DD, end of range'),
    },
    async ({ from, to }) => text(await proxyGet(`/coach-range?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)),
  );

  server.tool(
    'triage_tasks',
    'Surface tasks that need attention across both lists: those with no due date, overdue ones, and ones due soon. Returns { today, home:{no_due,overdue,due_soon}, work:{...} } with each task\'s uid, title and due (ISO). Use to propose due dates in bulk, then apply with set_task_dates. Read-only.',
    { soonDays: z.number().optional().describe('how many days ahead counts as "due soon" (default 3)') },
    async ({ soonDays }) => {
      const qs = soonDays ? `?soonDays=${soonDays}` : '';
      return text(await proxyGet(`/task-triage${qs}`));
    },
  );

  server.tool(
    'check_conflicts',
    'Check whether a proposed time slot overlaps any existing event across both calendars. Returns { hasConflict, conflicts:[...] }. Call this before create_meeting / create_event to warn the user about overlaps. Read-only.',
    {
      start: z.string().describe('proposed start, ISO 8601 with offset'),
      end: z.string().describe('proposed end, ISO 8601 with offset'),
    },
    async ({ start, end }) => {
      const qs = new URLSearchParams({ start, end });
      return text(await proxyGet(`/check-conflicts?${qs.toString()}`));
    },
  );

  server.tool(
    'check_duplicates',
    'Scan a day (or date range) across both calendars for likely mistakes: two events with the same title whose times overlap or sit within 15 minutes of each other. Returns { hasDuplicates, duplicates:[[{cal,title,start,end,location,id,uid}, ...], ...] } grouped by match. ALWAYS call this for the relevant date right after create_event, create_meeting, reschedule_event, or reschedule_meeting, before telling the user the write succeeded — it catches accidental double-creates and old events left behind when a "move" was done by hand (create new + forgot to delete old). If it reports a duplicate, confirm with the user which one to delete before deleting anything. Read-only.',
    {
      date: z.string().optional().describe('YYYY-MM-DD, checks that whole day'),
      from: z.string().optional().describe('ISO 8601 range start, use with `to` instead of `date`'),
      to: z.string().optional().describe('ISO 8601 range end, use with `from` instead of `date`'),
    },
    async ({ date, from, to }) => {
      const qs = new URLSearchParams(date ? { date } : { from, to });
      return text(await proxyGet(`/check-duplicates?${qs.toString()}`));
    },
  );

  server.tool(
    'get_weather',
    'Weather forecast for a day: condition, high/low temperature, precipitation and probability, wind, sunrise/sunset, and a compact hourly breakdown. Defaults to the saved home location (Heidelberg unless changed via set_weather_location). Pass `place` to look up any city on the fly without changing the default. Read-only.',
    {
      date: z.string().optional().describe('YYYY-MM-DD within the next 7 days (default today)'),
      place: z.string().optional().describe('city/place name to geocode for a one-off lookup, e.g. "Munich" or "Paris, France". Omit to use the saved default location.'),
    },
    async ({ date, place }) => {
      const qs = new URLSearchParams();
      if (date) qs.set('date', date);
      if (place) qs.set('place', place);
      const q = qs.toString();
      return text(await proxyGet(`/weather${q ? `?${q}` : ''}`));
    },
  );

  server.tool(
    'set_weather_location',
    'Set the persisted default weather location (used by get_weather, plan_day, and the daily digest when no place is given). Provide a place name to geocode, or exact coordinates. Pass clear:true to revert to the environment default. Persists across restarts. Confirm with the user first, like any other write.',
    {
      place: z.string().optional().describe('city/place name to geocode and save as the default, e.g. "Berlin"'),
      lat: z.string().optional().describe('exact latitude (use with lon instead of place)'),
      lon: z.string().optional().describe('exact longitude (use with lat)'),
      clear: z.boolean().optional().describe('true to clear the saved default and fall back to the env/hard default'),
    },
    async ({ place, lat, lon, clear }) => text(await proxyPost('/weather/location', { place, lat, lon, clear })),
  );

  server.tool(
    'list_deck_boards',
    'List Nextcloud Deck boards (kanban project boards, non-archived). Read-only.',
    {},
    async () => text(await proxyGet('/deck/boards')),
  );

  server.tool(
    'get_deck_cards',
    'Open Nextcloud Deck cards across all boards (excludes archived and done). Each card has title, board/boardId, stack/stackId, due (ISO or null), and labels — boardId/stackId/id are what update_deck_card and move_deck_card need. Pass dueDays to get only overdue cards plus cards due within that many days, useful for weekly triage/planning alongside calendar and tasks. Read-only.',
    { dueDays: z.number().optional().describe('if set, return only overdue cards plus cards due within this many days (e.g. 7 for the week)') },
    async ({ dueDays }) => text(await proxyGet(dueDays ? `/deck/cards-due?days=${encodeURIComponent(dueDays)}` : '/deck/cards')),
  );

  server.tool(
    'list_deck_stacks',
    'List the stacks (columns) of a Nextcloud Deck board, id + title, so a card can be placed into one. Read-only.',
    { boardId: z.number().describe('board id from list_deck_boards') },
    async ({ boardId }) => text(await proxyGet(`/deck/stacks?board=${encodeURIComponent(boardId)}`)),
  );

  server.tool(
    'get_deck_card',
    'Full detail for one Nextcloud Deck card, including its description (get_deck_cards omits this to keep the list light) — read this before editing a card\'s content so you know what\'s already there. Get boardId/stackId/cardId from get_deck_cards. Read-only.',
    {
      boardId: z.number().describe('board id, from get_deck_cards'),
      stackId: z.number().describe('stack id, from get_deck_cards'),
      cardId: z.number().describe('card id, from get_deck_cards'),
    },
    async ({ boardId, stackId, cardId }) => text(await proxyGet(`/deck/card?boardId=${encodeURIComponent(boardId)}&stackId=${encodeURIComponent(stackId)}&cardId=${encodeURIComponent(cardId)}`)),
  );

  server.tool(
    'create_deck_board',
    'Create a new Nextcloud Deck board. Creates a real board, confirm the title with the user first. A fresh board has no stacks; add one with create_deck_stack before adding cards.',
    {
      title: z.string().describe('board title'),
      color: z.string().optional().describe('hex color without #, e.g. 0082c9 (default)'),
    },
    async ({ title, color }) => text(await proxyPost('/deck/boards', { title, color })),
  );

  server.tool(
    'create_deck_stack',
    'Create a new stack (column) on a Nextcloud Deck board. Creates a real stack, confirm with the user first.',
    {
      boardId: z.number().describe('board id from list_deck_boards'),
      title: z.string().describe('stack/column title, e.g. "To do"'),
    },
    async ({ boardId, title }) => text(await proxyPost('/deck/stacks', { boardId, title })),
  );

  server.tool(
    'create_deck_card',
    'Create a card on a Nextcloud Deck board/stack. Creates a real card, confirm the exact payload with the user first. A due date makes it show up in the weekly digest.',
    {
      boardId: z.number().describe('board id from list_deck_boards'),
      stackId: z.number().describe('stack id from list_deck_stacks'),
      title: z.string().describe('card title'),
      due: z.string().optional().describe('due date: ISO datetime, or YYYY-MM-DD (treated as that day)'),
      description: z.string().optional().describe('optional card body/notes (Markdown)'),
    },
    async ({ boardId, stackId, title, due, description }) =>
      text(await proxyPost('/deck/cards', { boardId, stackId, title, due, description })),
  );

  server.tool(
    'delete_deck_card',
    'Delete a Nextcloud Deck card. Destructive, confirm the exact card (board, stack, title, id) with the user first. Get the ids from get_deck_cards / list_deck_stacks.',
    {
      boardId: z.number().describe('board id the card is on'),
      stackId: z.number().describe('stack id the card is in'),
      cardId: z.number().describe('card id to delete'),
    },
    async ({ boardId, stackId, cardId }) => text(await proxyPost('/deck/delete-card', { boardId, stackId, cardId })),
  );

  server.tool(
    'update_deck_card',
    'Update a Nextcloud Deck card\'s title, description, and/or due date in place (only the fields you pass are changed). Confirm the exact change with the user first. Get the ids from get_deck_cards. To move a card to a different stack (e.g. "Done"), use move_deck_card instead.',
    {
      boardId: z.number().describe('board id the card is on'),
      stackId: z.number().describe('current stack id the card is in'),
      cardId: z.number().describe('card id to update'),
      title: z.string().optional().describe('new title'),
      description: z.string().optional().describe('new description/body (Markdown)'),
      due: z.string().optional().describe('new due date: ISO datetime, or YYYY-MM-DD'),
    },
    async ({ boardId, stackId, cardId, title, description, due }) =>
      text(await proxyPost('/deck/update-card', { boardId, stackId, cardId, title, description, due })),
  );

  server.tool(
    'move_deck_card',
    'Move a Nextcloud Deck card to a different stack/column on the same board — e.g. "move to Done". Moving into a stack flagged as the board\'s done column marks the card done automatically (and clears done if moved back out); that\'s Deck\'s own behavior, not something this tool controls separately. Confirm the exact card and destination with the user first. Get ids from get_deck_cards / list_deck_stacks.',
    {
      boardId: z.number().describe('board id the card is on'),
      cardId: z.number().describe('card id to move'),
      toStackId: z.number().describe('destination stack id, from list_deck_stacks'),
      order: z.number().optional().describe('position within the destination stack (default 0, i.e. top)'),
    },
    async ({ boardId, cardId, toStackId, order }) =>
      text(await proxyPost('/deck/move-card', { boardId, cardId, toStackId, order })),
  );

  server.tool(
    'get_bike_maintenance',
    'Bike maintenance status (tires, drivetrain, brakes, bolt torque, annual service), tracked by km ridden since each item was last done (from Strava) or days elapsed for time-based items. Each has a status: "Bereit zum Fahren" (fine), "Bald prüfen" (check soon), or "Überfällig" (overdue). Read-only.',
    {},
    async () => text(await proxyGet('/bike/maintenance')),
  );

  server.tool(
    'reset_bike_maintenance_item',
    'Mark a bike maintenance item as just done, resetting its counter to 0 (km items reset against the bike\'s current Strava odometer; day items reset to today). Confirm with the user which item before resetting — get the item id from get_bike_maintenance.',
    { itemId: z.string().describe('maintenance item id, e.g. "tires", "drivetrain", "brakes", "bolts", "annual"') },
    async ({ itemId }) => text(await proxyPost('/bike/reset-maintenance-item', { itemId })),
  );

  server.tool(
    'get_status',
    'System status of the dashboard backend: cache ages, last Strava sync, synced activity count, digest cron schedules, last Apple Health ingest, and which backends are configured. Read-only.',
    {},
    async () => text(await proxyGet('/status')),
  );

  // --- Garmin Connect (structured workout push) ----------------------------
  // Pushes a structured training session to Garmin Connect so it syncs to
  // the watch/head unit; see ics-proxy's lib/garmin.js for the workout JSON
  // builder and target-type reference. Writes need confirmation like any
  // other write. Unofficial login (no public Garmin API) — returns a clear
  // error if GARMIN_EMAIL/PASSWORD aren't configured.

  const garminStepTarget = z.object({
    type: z.enum(['none', 'heart_rate', 'power', 'pace']).describe('power only valid for sport "cycling"; pace only for "running"/"walking"'),
    zone: z.number().optional().describe('named zone number (heart_rate/power: 1-5ish per the account\'s own configured zones); mutually exclusive with low/high'),
    low: z.union([z.number(), z.string()]).optional().describe('lower bound: bpm or watts (number), or "mm:ss" pace per km (string, pace target only)'),
    high: z.union([z.number(), z.string()]).optional().describe('upper bound, same unit as low'),
  }).optional().describe('omit or {type:"none"} for an untargeted step');

  const garminStep = z.object({
    repeat: z.number().optional().describe('set this to make the step a repeat block instead of a single leg — repeats the given steps N times (one level of nesting only)'),
    steps: z.array(z.object({
      type: z.enum(['warmup', 'cooldown', 'interval', 'recovery', 'rest', 'other']).optional().describe('default "interval"'),
      description: z.string().optional(),
      duration: z.object({
        type: z.enum(['time', 'distance']),
        seconds: z.number().optional().describe('required if duration.type is "time"'),
        meters: z.number().optional().describe('required if duration.type is "distance"'),
      }),
      target: garminStepTarget,
    })).optional().describe('required when repeat is set: the steps to repeat, e.g. [work, recovery]'),
    // Leaf-step fields (used when repeat is not set).
    type: z.enum(['warmup', 'cooldown', 'interval', 'recovery', 'rest', 'other']).optional().describe('default "interval"'),
    description: z.string().optional(),
    duration: z.object({
      type: z.enum(['time', 'distance']),
      seconds: z.number().optional().describe('required if duration.type is "time"'),
      meters: z.number().optional().describe('required if duration.type is "distance"'),
    }).optional().describe('required unless repeat is set'),
    target: garminStepTarget,
  });

  server.tool(
    'create_garmin_workout',
    'Create a structured training-session workout in Garmin Connect (e.g. warmup + N x (interval + recovery) + cooldown, with heart-rate/power/pace targets). Creates a real workout in the user\'s Garmin library — confirm the exact structure with the user first. Pass `date` to also schedule it onto that calendar day so it syncs to the watch/head unit as that day\'s workout; omit to just save it to the library for later.',
    {
      name: z.string().describe('workout name, shown on the watch'),
      description: z.string().optional(),
      sport: z.enum(['running', 'cycling', 'walking']).optional().describe('default "cycling"'),
      steps: z.array(garminStep).describe('ordered list of steps/repeat blocks making up the workout'),
      date: z.string().optional().describe('YYYY-MM-DD — also schedules the workout onto this day'),
    },
    async ({ name, description, sport, steps, date }) =>
      text(await proxyPost('/garmin/workout', { name, description, sport, steps, date })),
  );

  server.tool(
    'list_garmin_workouts',
    'List workouts saved in the user\'s Garmin Connect library (id, name, sport, last updated). Read-only.',
    { limit: z.number().optional().describe('max results, default 20') },
    async ({ limit }) => text(await proxyGet(`/garmin/workouts${limit ? `?limit=${encodeURIComponent(limit)}` : ''}`)),
  );

  server.tool(
    'schedule_garmin_workout',
    'Schedule an existing Garmin Connect workout onto a calendar date, so it syncs to the watch/head unit as that day\'s workout. Confirm with the user first. Get workoutId from list_garmin_workouts or create_garmin_workout\'s result.',
    {
      workoutId: z.number().describe('workout id, from list_garmin_workouts'),
      date: z.string().describe('YYYY-MM-DD'),
    },
    async ({ workoutId, date }) => text(await proxyPost('/garmin/schedule-workout', { workoutId, date })),
  );

  server.tool(
    'delete_garmin_workout',
    'Delete a workout from the user\'s Garmin Connect library. Destructive, confirm the exact workout (name, id) with the user first. Get the id from list_garmin_workouts.',
    { workoutId: z.number().describe('workout id to delete') },
    async ({ workoutId }) => text(await proxyPost('/garmin/delete-workout', { workoutId })),
  );

  // --- Strava (read-only) -------------------------------------------------
  // Mirror the Strava read tools, served via ics-proxy's /strava/* endpoints.
  // Units are metric. Training plans and eligibility are not exposed by the
  // public Strava API, so they are intentionally absent.

  server.tool(
    'list_strava_activities',
    'List the athlete\'s recent Strava activities (newest first). Each item has id, name, sport_type, start (UTC ISO), when (Berlin), distance_km, moving_time, elevation_gain_m, avg/max speed and HR, avg_watts, kudos, PR/achievement counts, gear_id. Units are metric.',
    {
      perPage: z.number().optional().describe('how many to return, max 100 (default 30)'),
      page: z.number().optional().describe('page number for pagination (default 1)'),
      before: z.number().optional().describe('only activities before this Unix timestamp (seconds)'),
      after: z.number().optional().describe('only activities after this Unix timestamp (seconds)'),
    },
    async ({ perPage, page, before, after }) => {
      const qs = new URLSearchParams();
      if (perPage) qs.set('per_page', String(perPage));
      if (page) qs.set('page', String(page));
      if (before) qs.set('before', String(before));
      if (after) qs.set('after', String(after));
      const q = qs.toString();
      return text(await proxyGet(`/strava/activities${q ? `?${q}` : ''}`));
    },
  );

  server.tool(
    'get_strava_athlete',
    'The athlete\'s Strava profile: name, location, gender, weight, measurement preference, and their bikes and shoes.',
    {},
    async () => text(await proxyGet('/strava/athlete')),
  );

  server.tool(
    'get_strava_zones',
    'The athlete\'s heart rate and power zones (and FTP, if set).',
    {},
    async () => text(await proxyGet('/strava/zones')),
  );

  server.tool(
    'get_strava_gear',
    'The athlete\'s gear: bikes and shoes with total distance and retired status. Pass id for full detail on one item (brand, model, weight).',
    { id: z.string().optional().describe('gear id (e.g. b1234567 / g1234567) for full detail') },
    async ({ id }) => text(await proxyGet(id ? `/strava/gear/${encodeURIComponent(id)}` : '/strava/gear')),
  );

  server.tool(
    'get_strava_activity',
    'Detailed performance data for one activity by id: avg/max HR, watts, cadence, calories, perceived/relative effort, elevation range, temperature, location, full gear detail, route (encoded polyline plus a decoded route_latlng from the summary polyline), laps, segment efforts, and PR achievements. Units are metric. Social counters (kudos/comments/photos) and account/visibility flags are omitted.',
    { id: z.string().describe('numeric Strava activity id') },
    async ({ id }) => text(await proxyGet(`/strava/activity/${encodeURIComponent(id)}`)),
  );

  server.tool(
    'get_strava_streams',
    'Time-series streams for one activity by id (e.g. heartrate, watts, cadence, distance, altitude, velocity_smooth, latlng, grade_smooth, temp, moving, time). Returns one array per requested stream.',
    {
      id: z.string().describe('numeric Strava activity id'),
      keys: z.string().optional().describe('comma-separated stream keys; defaults to a broad set'),
      resolution: z.enum(['low', 'medium', 'high']).optional().describe('downsample level; omit for full resolution'),
    },
    async ({ id, keys, resolution }) => {
      const qs = new URLSearchParams();
      if (keys) qs.set('keys', keys);
      if (resolution) qs.set('resolution', resolution);
      const q = qs.toString();
      return text(await proxyGet(`/strava/activity/${encodeURIComponent(id)}/streams${q ? `?${q}` : ''}`));
    },
  );

  server.tool(
    'get_strava_activity_zones',
    'Time-in-zone distribution for one activity by id (heart-rate zones, and power zones if the activity has watts): how many minutes were spent in each zone, not just the average. Use this for a real coaching read on how a session was actually executed, not just its average HR/power.',
    { id: z.string().describe('numeric Strava activity id') },
    async ({ id }) => text(await proxyGet(`/strava/activity/${encodeURIComponent(id)}/zones`)),
  );

  server.tool(
    'get_strava_clubs',
    'The clubs the athlete belongs to. Pass clubId to list a club\'s upcoming group events instead.',
    { clubId: z.string().optional().describe('club id; when set, returns that club\'s upcoming events') },
    async ({ clubId }) => text(await proxyGet(clubId ? `/strava/club/${encodeURIComponent(clubId)}/events` : '/strava/clubs')),
  );

  server.tool(
    'get_strava_ytd',
    'Year-to-date totals per sport (Run/Ride/Swim): distance, time, elevation, activity count, and goal progress if annual goals are configured.',
    {},
    async () => text(await proxyGet('/strava/ytd')),
  );

  server.tool(
    'get_strava_load',
    'Training load: the acute:chronic workload ratio (ACWR) from Relative Effort over the last 28 days, with acute (7-day) and chronic (weekly average) totals and a status (Untertraining / Optimal / Erhöht / Hohes Risiko).',
    {},
    async () => text(await proxyGet('/strava/load')),
  );

  server.tool(
    'get_readiness',
    'Training readiness signal: a "hard / easy / rest" recommendation combining training load (ACWR) with morning recovery signals (resting heart rate, HRV, sleep) and days since last activity. Returns a score (0-100), a recommendation (Bereit für hart / Locker / Ruhetag empfohlen), and the reasons behind it. Read-only.',
    {},
    async () => text(await proxyGet('/strava/readiness')),
  );

  server.tool(
    'get_load_vs_training',
    'Weekly correlation of work-meeting load (Exchange meeting hours + count) against training volume (km) and Relative Effort, for the last N Monday-anchored weeks. Use to see how busy work weeks affect training. Read-only.',
    { weeks: z.number().optional().describe('how many weeks back (default 8, max 26)') },
    async ({ weeks }) => text(await proxyGet(`/strava/load-vs-training${weeks ? `?weeks=${weeks}` : ''}`)),
  );

  server.tool(
    'plan_cycling_training',
    'Build a weather-aware plan for a cycling ride from a start to a destination: forecast at both ends, a packing list covering the worse of the two (cold/wet/wind gear as needed), and a carb/gel target (60g carbs/hour, 25g/gel, none needed under 60min). Provide durationMinutes, or distanceKm (with avgSpeedKmh, or it\'s derived from your recent Strava ride average); if neither is given, distance is estimated from the straight-line start→destination distance (not a real route). Returns descriptionDraft — pass that straight through as the `description` when you create_event for the ride (still needs user confirmation like any other write). Read-only.',
    {
      destination: z.string().describe('place name for the ride destination, geocoded for weather'),
      start: z.string().optional().describe('place name for where the ride starts, geocoded for weather; omit to use your saved/default home location'),
      date: z.string().optional().describe('YYYY-MM-DD, defaults to today'),
      durationMinutes: z.number().optional().describe('planned ride duration in minutes'),
      distanceKm: z.number().optional().describe('planned ride distance in km, used with avgSpeedKmh (or your Strava average) to derive duration'),
      avgSpeedKmh: z.number().optional().describe('override average speed used to derive duration from distanceKm; omit to use your recent Strava ride average'),
    },
    async ({ destination, start, date, durationMinutes, distanceKm, avgSpeedKmh }) => {
      const qs = new URLSearchParams({ destination });
      if (start) qs.set('start', start);
      if (date) qs.set('date', date);
      if (durationMinutes != null) qs.set('durationMinutes', String(durationMinutes));
      if (distanceKm != null) qs.set('distanceKm', String(distanceKm));
      if (avgSpeedKmh != null) qs.set('avgSpeedKmh', String(avgSpeedKmh));
      return text(await proxyGet(`/plan-cycling-training?${qs.toString()}`));
    },
  );

  server.tool(
    'get_health_summary',
    'Latest Apple Health values (from Health Auto Export): sleep (h), resting heart rate (bpm), HRV (ms), steps, active energy (kcal), weight (kg), body fat (%), BMI, VO2max, respiratory rate, walking HR, exercise minutes, flights climbed, daylight (min), water (mL), and nutrition (energy_intake kcal, carbs g, protein g, fat g). Each has the value, unit, and the day it is from. Nutrition values are typically from the previous day. These are the 24/7 non-workout signals Strava lacks.',
    {},
    async () => text(await proxyGet('/health-api/summary')),
  );

  server.tool(
    'get_health_series',
    'Daily Apple Health time series for one metric over the last N days. metric: sleep, resting_hr, hrv, steps, active_energy, weight, body_fat, bmi, energy_intake (kcal eaten), carbs (g), protein (g), fat (g). Use energy_intake/carbs/protein/fat to analyse nutrition trends over multiple days.',
    {
      metric: z.enum(['sleep', 'resting_hr', 'hrv', 'steps', 'active_energy', 'weight', 'body_fat', 'bmi', 'energy_intake', 'carbs', 'protein', 'fat']),
      days: z.number().optional().describe('how many days back (default 30, max 366)'),
    },
    async ({ metric, days }) => {
      const qs = new URLSearchParams({ metric });
      if (days) qs.set('days', String(days));
      return text(await proxyGet(`/health-api/series?${qs.toString()}`));
    },
  );

  server.tool(
    'list_notes',
    'List every note in the user\'s SiYuan "RAG" notebook (a dedicated knowledge-base notebook, not their full note vault), including nested ones: [{docId, title, path}]. Use when you need a full inventory rather than a keyword match — e.g. to check if a title already exists, or to browse. Read-only.',
    {},
    async () => text(await proxyGet('/siyuan/notes')),
  );

  server.tool(
    'hybrid_search_notes',
    'Default search over the user\'s SiYuan "RAG" notebook (a dedicated knowledge-base notebook, not their full note vault): fuses full-text and semantic (embedding) results via reciprocal rank fusion, so an exact term/ID/name and a paraphrased or conceptual match both surface without having to guess which mode fits the query. Prefer this over search_notes/semantic_search_notes unless you specifically need pure keyword or pure semantic ranking. Returns notes ranked by fused score: [{docId, title, path?, heading?, snippet?, score}]. Use get_note with a result\'s docId to read the full note. Read-only.',
    {
      query: z.string().describe('search text'),
      limit: z.number().optional().describe('max notes to return (default 10, max 50)'),
    },
    async ({ query, limit }) => {
      const qs = new URLSearchParams({ q: query });
      if (limit) qs.set('limit', String(limit));
      return text(await proxyGet(`/siyuan/hybrid-search?${qs.toString()}`));
    },
  );

  server.tool(
    'search_notes',
    'Pure full-text search over the user\'s SiYuan "RAG" notebook (a dedicated knowledge-base notebook, not their full note vault). Prefer hybrid_search_notes for general queries; use this when you specifically need exact-keyword matching with no semantic fuzz. Returns one result per matching note (deduped even if several blocks in the same note match): {id, docId, title, path, snippet}. Use get_note with a result\'s docId to read the full note. Read-only.',
    {
      query: z.string().describe('search text'),
      limit: z.number().optional().describe('max distinct notes to return (default 10, max 50)'),
    },
    async ({ query, limit }) => {
      const qs = new URLSearchParams({ q: query });
      if (limit) qs.set('limit', String(limit));
      return text(await proxyGet(`/siyuan/search?${qs.toString()}`));
    },
  );

  server.tool(
    'semantic_search_notes',
    'Pure meaning-based (embedding) search over the same SiYuan "RAG" notebook as search_notes, using a local embedding model — finds conceptually related notes even when they share no keywords with the query, and matches across German/English. Prefer hybrid_search_notes for general queries; use this when you specifically want semantic-only ranking (e.g. comparing against the full-text side yourself). Weak matches (cosine similarity below a floor) are dropped rather than padding out the result count. Returns notes ranked by similarity: [{docId, title, score}]. Use get_note with a result\'s docId to read the full note. Read-only.',
    {
      query: z.string().describe('search text'),
      limit: z.number().optional().describe('max notes to return (default 10, max 50)'),
    },
    async ({ query, limit }) => {
      const qs = new URLSearchParams({ q: query });
      if (limit) qs.set('limit', String(limit));
      return text(await proxyGet(`/siyuan/semantic-search?${qs.toString()}`));
    },
  );

  server.tool(
    'get_note',
    'Fetch the full content (markdown) of one SiYuan note, given a docId from hybrid_search_notes/search_notes. Read-only.',
    { docId: z.string().describe('docId from a search_notes result') },
    async ({ docId }) => text(await proxyGet(`/siyuan/note?id=${encodeURIComponent(docId)}`)),
  );

  server.tool(
    'create_note',
    'Create a new note (document) in the user\'s SiYuan "RAG" notebook. Rejects if a note with the exact same title already exists (use list_notes/search_notes to check first if unsure). Optional parentDocId nests it under an existing note (use list_notes/search_notes to find the parent\'s docId); omit to create at the notebook root. Creates a real note, confirm the exact title/content (and parent, if any) with the user first.',
    {
      title: z.string().describe('note title'),
      markdown: z.string().optional().describe('note body in Markdown; defaults to just a heading with the title'),
      parentDocId: z.string().optional().describe('docId of an existing note to nest this one under; omit for the notebook root'),
    },
    async ({ title, markdown, parentDocId }) => text(await proxyPost('/siyuan/note', { title, markdown, parentDocId })),
  );

  server.tool(
    'update_note',
    'Edit a SiYuan note\'s content, given a docId from hybrid_search_notes/search_notes/create_note/list_notes. mode "replace" (default) overwrites the whole body; mode "append" adds new content at the end instead, leaving the existing body untouched. Confirm the exact change with the user first. Optional title also renames the note (the sidebar title doesn\'t follow the content\'s heading automatically). Rejects ids outside the RAG notebook.',
    {
      docId: z.string().describe('docId of the note to edit'),
      markdown: z.string().describe('markdown to write — replaces the whole body in "replace" mode, or is added at the end in "append" mode'),
      title: z.string().optional().describe('optional new title, also renames the note'),
      mode: z.enum(['replace', 'append']).optional().describe('"replace" (default) overwrites the whole body; "append" adds to the end'),
    },
    async ({ docId, markdown, title, mode }) => text(await proxyPost('/siyuan/update-note', { docId, markdown, title, mode })),
  );

  server.tool(
    'delete_note',
    'Delete a SiYuan note by docId. Destructive, confirm the exact note (title, docId) with the user first. Rejects ids outside the RAG notebook.',
    { docId: z.string().describe('docId of the note to delete') },
    async ({ docId }) => text(await proxyPost('/siyuan/delete-note', { docId })),
  );

  server.tool(
    'move_note',
    'Move/reparent a SiYuan note, given a docId from hybrid_search_notes/search_notes/list_notes/create_note. Optional parentDocId nests it under another existing note; omit parentDocId to move it back to the notebook root. Confirm the exact move (which note, which new parent or "root") with the user first. Rejects ids outside the RAG notebook.',
    {
      docId: z.string().describe('docId of the note to move'),
      parentDocId: z.string().optional().describe('docId of the note to nest under; omit to move to the notebook root'),
    },
    async ({ docId, parentDocId }) => text(await proxyPost('/siyuan/move-note', { docId, parentDocId })),
  );

  server.tool(
    'get_note_attrs',
    'Get a SiYuan note\'s custom attributes (key-value tags), given a docId from hybrid_search_notes/search_notes/list_notes. Returns SiYuan\'s built-in metadata (id, title, type, updated) alongside any "custom-"-prefixed attributes previously set. Read-only. Rejects ids outside the RAG notebook.',
    { docId: z.string().describe('docId of the note') },
    async ({ docId }) => text(await proxyGet(`/siyuan/note-attrs?id=${encodeURIComponent(docId)}`)),
  );

  server.tool(
    'get_note_backlinks',
    'Notes that link TO this one via SiYuan\'s own block-reference syntax ("((docId \'text\'))"), given a docId from hybrid_search_notes/search_notes/list_notes — real backlinks (an actual link the user or an import created), not a keyword/text match. Returns [{docId, title, path}] for each distinct referencing note. Useful for knowledge-graph-style navigation ("what else mentions/depends on this"), complementing search_notes and semantic_search_notes. Read-only. Rejects ids outside the RAG notebook.',
    { docId: z.string().describe('docId of the note to find backlinks for') },
    async ({ docId }) => text(await proxyGet(`/siyuan/backlinks?id=${encodeURIComponent(docId)}`)),
  );

  server.tool(
    'set_note_attrs',
    'Set custom key-value attributes (tags/metadata) on a SiYuan note, given a docId. Keys are auto-prefixed "custom-" if not already (SiYuan reserves un-prefixed names for its own metadata). Existing attributes not mentioned are left untouched; to change one, pass its key again. Confirm the exact keys/values with the user first. Rejects ids outside the RAG notebook.',
    {
      docId: z.string().describe('docId of the note to tag'),
      attrs: z.record(z.string(), z.string()).describe('key-value pairs to set, e.g. {"status":"done"} (becomes custom-status)'),
    },
    async ({ docId, attrs }) => text(await proxyPost('/siyuan/note-attrs', { docId, attrs })),
  );

  server.tool(
    'get_strava_series',
    'Time series of a training metric over the synced activity history, aggregated by day, week, or month. metric: hr (avg HR), effort (summed Relative Effort), or distance (km). Optional from/to (YYYY-MM-DD) for a custom range; otherwise returns a sensible recent window.',
    {
      metric: z.enum(['hr', 'effort', 'distance']).describe('hr = avg heart rate, effort = Relative Effort sum, distance = km'),
      granularity: z.enum(['day', 'week', 'month']).optional().describe('bucket size (default week)'),
      from: z.string().optional().describe('start date YYYY-MM-DD'),
      to: z.string().optional().describe('end date YYYY-MM-DD'),
    },
    async ({ metric, granularity, from, to }) => {
      const qs = new URLSearchParams({ metric });
      if (granularity) qs.set('granularity', granularity);
      if (from) qs.set('from', from);
      if (to) qs.set('to', to);
      return text(await proxyGet(`/strava/series?${qs.toString()}`));
    },
  );

  registerGymTools(server);

  return server;
}

const app = express();
app.use(express.json());

// --- OAuth 2.1 resource-server auth (claude.ai web; Pocket ID = AS) ----------
// Two accepted credentials on /mcp:
//   1. X-Api-Token: <API_TOKEN>      (Claude Code / Desktop, unchanged)
//   2. Authorization: Bearer <JWT>   (claude.ai web; JWT issued by Pocket ID)
const JWKS = OIDC_ISSUER ? createRemoteJWKSet(new URL(`${OIDC_ISSUER}/.well-known/jwks.json`)) : null;

async function verifyBearer(token) {
  if (!JWKS) throw new Error('OIDC not configured');
  const { payload } = await jwtVerify(token, JWKS, { issuer: OIDC_ISSUER });
  // Tie the token to our client when the AS exposes it (Pocket ID may not send
  // an RFC 8707 resource audience, so accept azp/client_id/aud when present).
  if (OIDC_CLIENT_ID) {
    const ids = [payload.azp, payload.client_id, payload.cid].concat(payload.aud || []).filter(Boolean);
    if (ids.length && !ids.includes(OIDC_CLIENT_ID)) throw new Error('token not for this client');
  }
  return payload;
}

async function isAuthorized(req) {
  if (API_TOKEN && req.headers['x-api-token'] === API_TOKEN) return true;
  const m = /^Bearer\s+(.+)$/i.exec(req.headers['authorization'] || '');
  if (m && JWKS) {
    try { await verifyBearer(m[1]); return true; }
    catch (e) { console.error('bearer verify failed:', e.message); }
  }
  return false;
}

function unauthorized(res) {
  const rm = `${PUBLIC_BASE || ''}/.well-known/oauth-protected-resource`;
  res.set('WWW-Authenticate', `Bearer resource_metadata="${rm}"`);
  return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
}

// RFC 9728 Protected Resource Metadata (public). Lets claude.ai discover the
// authorization server (Pocket ID) from the resource URL.
function resourceMetadata(_req, res) {
  res.json({
    resource: MCP_RESOURCE,
    authorization_servers: OIDC_ISSUER ? [OIDC_ISSUER] : [],
    bearer_methods_supported: ['header'],
    scopes_supported: ['openid'],
  });
}
app.get('/.well-known/oauth-protected-resource', resourceMetadata);
app.get('/.well-known/oauth-protected-resource/mcp', resourceMetadata);

// Stateless Streamable HTTP: a fresh server+transport per request.
app.post('/mcp', async (req, res) => {
  if (!(await isAuthorized(req))) return unauthorized(res);
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error('mcp error:', e.message);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: e.message }, id: null });
    }
  }
});

// No sessions / server-initiated streams, so GET and DELETE are unsupported.
const notAllowed = (_req, res) =>
  res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server).' }, id: null });
app.get('/mcp', notAllowed);
app.delete('/mcp', notAllowed);

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`glance-mcp listening on ${PORT}`));

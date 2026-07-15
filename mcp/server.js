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
    'Mark a task complete by uid.',
    { list: z.enum(['home', 'work']), uid: z.string() },
    async ({ list, uid }) => text(await proxyPost(`/complete-${list}-task`, { uid })),
  );

  server.tool(
    'rename_task',
    'Rename a task (change its title) by uid.',
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
    { query: z.string().describe('partial name or email, at least 2 characters, e.g. "smith" or "jane"') },
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
    'get_weather',
    'Weather forecast for a day: condition, high/low temperature, precipitation and probability, wind, sunrise/sunset, and a compact hourly breakdown. Defaults to the saved home location (Berlin unless changed via set_weather_location). Pass `place` to look up any city on the fly without changing the default. Read-only.',
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
    'Set the persisted default weather location (used by get_weather, plan_day, and the daily digest when no place is given). Provide a place name to geocode, or exact coordinates. Pass clear:true to revert to the environment default. Persists across restarts.',
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
    'Open Nextcloud Deck cards across all boards (excludes archived and done). Each card has title, board, stack, due (ISO or null), and labels. Pass dueDays to get only overdue cards plus cards due within that many days, useful for weekly triage/planning alongside calendar and tasks. Read-only.',
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
    'get_status',
    'System status of the dashboard backend: cache ages, last Strava sync, synced activity count, digest cron schedules, last Apple Health ingest, and which backends are configured. Read-only.',
    {},
    async () => text(await proxyGet('/status')),
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
    'Detailed performance data for one activity by id: avg/max HR, watts, cadence, calories, perceived effort, laps, segment efforts, best efforts, and PR achievements.',
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

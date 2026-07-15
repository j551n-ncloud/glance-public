# CLAUDE.md

Runbook for any Claude session working in this repo. This project is a personal
[Glance](https://github.com/glanceapp/glance) dashboard plus an `ics-proxy`
sidecar. The proxy doubles as an assistant backend: a single source of truth for
the user's calendar and tasks that Claude can read and write.

See `README.md` for full architecture and setup. This file is the operational
guide for acting as the user's assistant.

## TL;DR for acting as assistant

- Read calendar/tasks and create/complete tasks and meetings through the proxy.
- Local stack base URL: `http://localhost:8088` (nginx). Remote: `https://dash.example.com`.
- All API calls need the header `X-Api-Token: <API_TOKEN>` (value lives in `.env`).
- ALWAYS confirm writes with the user before POSTing. See "Write safety" below.

## Running the stack locally

```bash
docker compose up -d --build
```

Three containers: `nginx` (host port 8088), `glance`, `ics-proxy`. Backends
(Exchange EWS, Nextcloud) are reached from inside the containers, so writes/reads
to Nextcloud must run from within the network (see CalDAV note below).

## Access model

nginx (`nginx.conf.template`, rendered at startup via the image's envsubst
entrypoint, injecting only `API_TOKEN`):

- `GET /ews-api/*` and `GET /tasks-api/*`: require a valid `X-Api-Token`, else 403.
- `POST /ews-api/*` and `POST /tasks-api/*`: passed through; `ics-proxy` enforces
  the token itself (401 without it).
- Glance widgets read GET endpoints directly over the Docker network
  (`ics-proxy:3000`), bypassing nginx, so they never need the token.

Get the token without printing it:

```bash
TOKEN=$(grep '^API_TOKEN=' .env | cut -d= -f2- | tr -d '"'\''')
```

## Endpoints

Path prefix maps to the same proxy; `/ews-api/` and `/tasks-api/` both proxy to
`ics-proxy:3000`. Use either prefix that matches the resource.

Read (GET, need token):

| Endpoint | Returns |
|---|---|
| `/ews-api/events` | Exchange events: `{ events: [...], todayCount }` |
| `/ews-api/ics-events` | Nextcloud ICS events: `[...]` |
| `/tasks-api/home-tasks` | open home VTODOs: `[{title,start,due,uid}]` |
| `/tasks-api/work-tasks` | open work VTODOs |
| `/ews-api/agenda?date=YYYY-MM-DD` | merged work+home events (incl. past in window) + open tasks: `{from,to,events:[{...,cal}],tasks:{home,work}}`. Or `?from=ISO&to=ISO`. |
| `/ews-api/free-slots?date=YYYY-MM-DD` | open slots in working hours: `{free:[{start,end}]}`. Opt: `duration` (min, default 30), `dayStart`/`dayEnd` (`HH:MM`, default 09:00/17:00). |
| `/ews-api/search?q=TERM` | match events (title/location) + open tasks. Default window today..+90d; widen with `from`/`to` (ISO) to search the past. |
| `/ews-api/resolve-attendees?q=NAME` | search Exchange directory (GAL) + contacts; returns `{query,matches:[{email,name,department,office,phone,mobile}]}` (email first). |
| `/ews-api/plan-day?date=YYYY-MM-DD` | planning bundle for a day: `{date,weather,events,free,tasks:{home,work}}`. Opt: `duration` (min, default 30), `dayStart`/`dayEnd` (`HH:MM`). Draft a time-blocked plan, then write it with `POST /ews-api/plan-day`. |
| `/ews-api/check-conflicts?start=ISO&end=ISO` | events across both calendars overlapping a proposed slot: `{start,end,hasConflict,conflicts:[...]}`. Call before creating a meeting. |
| `/tasks-api/task-triage` | open tasks needing attention: `{today,home:{no_due,overdue,due_soon},work:{...}}` (each task has `uid,title,due`). Opt: `soonDays` (default 3). |
| `/deck-api/boards` | Nextcloud Deck boards (non-archived): `[{id,title,color}]`. |
| `/deck-api/cards` | open Deck cards across all boards (excl. archived/done): `[{id,title,board,stack,due,labels}]`. |
| `/deck-api/cards-due?days=N` | overdue + cards due within N days (default 7), sorted by due. |
| `/deck-api/stacks?board=ID` | stacks (columns) of a board: `[{id,title,order}]`. Needed to place a card. |
| `/ews-api/weather?date=YYYY-MM-DD` | Open-Meteo forecast: `{date,place,text,emoji,tempMax,tempMin,precip,precipProb,windMax,sunrise,sunset,hourly}`. No key. Location = saved default (see `POST /weather/location`) else `WEATHER_*` env else Berlin. Override per call with `?place=NAME` (geocoded) or `?lat=&lon=`. |
| `/strava-api/readiness` | training readiness: `{score,recommendation,color,acwr,restingHr,hrv,sleepHours,daysSinceLast,reasons,note}`, combining ACWR + resting HR/HRV/sleep. |
| `/strava-api/load-vs-training?weeks=8` | per-week work-meeting hours vs training km/effort: `{weeks,series:[{label,meetingHours,meetingCount,trainingKm,effort,meetingPct,effortPct}]}`. |
| `/status` (internal; not via nginx) | backend health: cache ages, last Strava sync, DB activity count, digest crons, last Health ingest, configured backends. |
| `/strava-api/activities?per_page=&page=&before=&after=` | recent Strava activities (metric, newest first), simplified with a Berlin `when`. |
| `/strava-api/athlete` | Strava profile incl. bikes/shoes. |
| `/strava-api/zones` | HR + power zones. |
| `/strava-api/gear` (`/gear/:id`) | gear list (or one item's detail). |
| `/strava-api/activity/:id` | detailed activity performance (HR/watts, laps, efforts, PRs). |
| `/strava-api/activity/:id/streams?keys=&resolution=` | activity time-series streams. |
| `/strava-api/clubs` (`/club/:id/events`) | clubs (or a club's upcoming events). |
| `/strava-api/ytd` | year-to-date totals per sport (Run/Ride/Swim) + goal progress. |
| `/strava-api/load` | training load: acute:chronic workload ratio (ACWR) with status. |
| `/strava-api/series?metric=hr\|effort\|distance&granularity=day\|week\|month&from=&to=` | DB-backed time series for the customizable charts. |

Write (POST, need token):

| Endpoint | Body | Effect |
|---|---|---|
| `/ews-api/plan-day` | `{blocks:[{title,start,duration?\|end?,list?}]}` | Write confirmed plan blocks as timed tasks (default list `home`). Pair with `GET /ews-api/plan-day`. |
| `/ews-api/weather/location` | `{place}` \| `{lat,lon,place?,tz?}` \| `{clear:true}` | Set the persisted default weather location (geocodes `place` via Open-Meteo). Survives restarts (stored in `SETTINGS_FILE`, default `/data/settings.json`). `clear` reverts to the env/hard default. |
| `/ews-api/meetings` | `{subject,start,end,location?,attendees?,body?}` | Creates Exchange meeting. SENDS INVITES if attendees set. No attendees = private self-block. |
| `/ews-api/ics-events` | `{summary,start,end?,location?,description?}` | Create Nextcloud (home) calendar event. `start`/`end`: `YYYY-MM-DD` (all-day) or ISO datetime. `description` is a free-text note (shows in the calendar app, not the widget). Writes to `CAL_URL`. |
| `/tasks-api/home-tasks` | `{title,startDate?,endDate?,duration?}` | Create home task. Dates are `YYYY-MM-DD` (all-day) or ISO datetime. `duration` (minutes) with a timed start makes a block (due = start + duration). |
| `/tasks-api/work-tasks` | `{title,startDate?,endDate?}` | Create work task. |
| `/tasks-api/complete-home-task` | `{uid}` | Mark home task complete. |
| `/tasks-api/complete-work-task` | `{uid}` | Mark work task complete. |
| `/tasks-api/rename-home-task` | `{uid,newTitle}` | Rename a home task. |
| `/tasks-api/rename-work-task` | `{uid,newTitle}` | Rename a work task. |
| `/tasks-api/delete-home-task` | `{uid}` | Delete a home task. |
| `/tasks-api/delete-work-task` | `{uid}` | Delete a work task. |
| `/tasks-api/set-home-task-dates` | `{uid,startDate?,endDate?,duration?}` | Set/change a home task's start and/or due date. `YYYY-MM-DD` (all-day) or ISO datetime. `duration` (minutes) with a timed start sets due = start + duration. |
| `/tasks-api/set-work-task-dates` | `{uid,startDate?,endDate?}` | Set/change a work task's dates. |
| `/deck-api/boards` | `{title,color?}` | Create a Deck board. New boards have no stacks; add one before adding cards. |
| `/deck-api/stacks` | `{boardId,title}` | Create a stack (column) on a board. |
| `/deck-api/cards` | `{boardId,stackId,title,due?,description?}` | Create a Deck card. `due`: ISO or `YYYY-MM-DD`. A due date puts it in the weekly digest's Deck block. |
| `/deck-api/delete-card` | `{boardId,stackId,cardId}` | Delete a Deck card. |
| `/ews-api/delete-ics-event` | `{uid}` | Delete a Nextcloud (home) event. |
| `/ews-api/delete-exchange-event` | `{id,allowSeries?}` | Delete/cancel an Exchange (work) event by EWS `id` (from `/events`). Refuses a recurring SERIES master unless `allowSeries:true`; a single occurrence id removes only that instance. Sends cancellations to attendees. |
| `/ews-api/reschedule-exchange-event` | `{id,start,end,allowSeries?}` | Move an Exchange (work) event to a new start/end by EWS `id`. ISO 8601 with offset. Same series guard. Notifies attendees. |
| `/ews-api/reschedule-ics-event` | `{uid,start,end?}` | Move a Nextcloud (home) event. `start`/`end`: `YYYY-MM-DD` or ISO datetime. Exchange events not supported. |
| `/ews-api/update-ics-event` | `{uid,start?,end?,location?,summary?,description?}` | Update a Nextcloud (home) event in place: set location, note (`description`), rename, and/or move. Only provided fields change. |

Note: task create endpoints now return the new task's `uid` in the response
(`{ok:true,uid}`), so you can edit/delete it without a follow-up lookup.

Example read:

```bash
curl -s -H "X-Api-Token: $TOKEN" http://localhost:8088/tasks-api/work-tasks
```

Example write (confirm with user first):

```bash
curl -s -X POST -H "Content-Type: application/json" -H "X-Api-Token: $TOKEN" \
  -d '{"title":"My task","startDate":"2026-06-30","endDate":"2026-06-30"}' \
  http://localhost:8088/tasks-api/work-tasks
```

## Write safety (the user's standing rule)

ALWAYS show the exact payload and wait for an OK before any POST. No
fire-and-forget. Meetings with attendees email real people. After confirming,
POST, then verify (see cache note).

## Gotchas

1. **Timezone.** Event `start` is UTC ISO. The user is in Europe/Berlin
   (UTC+2 in summer). The `when` field is already formatted to Berlin; if you
   compute from `start`, convert. Today's date is provided in the session
   context; do not guess it.

2. **Serve-stale cache.** Reads are cached (default TTL 5 min). After a write
   the matching cache TTL is reset, but the FIRST GET still returns stale data
   and only triggers a background refresh. To verify a write: GET once (triggers
   refresh), wait ~6s, GET again.

3. **CalDAV from the host is blocked (403).** Nextcloud only accepts CalDAV from
   inside the network. There is no rename/edit endpoint on the proxy. To edit a
   task in place (e.g. change SUMMARY), run it from inside the container:

   ```bash
   docker exec ics-proxy node -e '
     const cal=process.env.TASKS_WORK_URL,u=process.env.TASKS_USER||process.env.ICS_USER,p=process.env.TASKS_PASS||process.env.ICS_PASS;
     const url=cal.replace("/?export","")+"/<uid>.ics";
     const a="Basic "+Buffer.from(u+":"+p).toString("base64");
     (async()=>{const g=await fetch(url,{headers:{Authorization:a}});let t=await g.text();
       t=t.replace(/SUMMARY:[^\r\n]*/,"SUMMARY:NEW TITLE");
       const r=await fetch(url,{method:"PUT",headers:{Authorization:a,"Content-Type":"text/calendar; charset=utf-8"},body:t});
       console.log("PUT",r.status);})();'
   ```

   A direct CalDAV edit does NOT bust the proxy cache, so the widget shows the
   old value until TTL expires.

4. **Creating events on the private (Nextcloud) calendar.** Use
   `POST /ews-api/ics-events` (or the `create_event` MCP tool). `/ews-api/meetings`
   writes to the Exchange (work) calendar only. The private calendar shown in the
   `ics-events` widget is READ via a public read-only share (`ICS_URL` =
   `.../public-calendars/<token>?export`), which rejects writes; creation goes to
   the writable CalDAV collection `CAL_URL`
   (`.../calendars/admin/default-1/`). If that path ever changes, confirm with a
   read-only PROPFIND (Depth: 0) on `CAL_URL`. ALWAYS confirm the event with the
   user before creating (same write-safety rule). The endpoint busts the
   `ics-events` cache on success; a manual direct CalDAV PUT (outside the proxy)
   does not, so the widget would lag by the TTL (~5 min).

## Email digests

`ics-proxy` sends HTML emails via SMTP, both share the same styled layout:

- **Daily** (today's events work + home, plus open tasks): `DIGEST_ENABLED`
  (default `false`), `DIGEST_TO`, `DIGEST_CRON` (default `0 8 * * *`),
  `DIGEST_TZ` (default `Europe/Berlin`), `DIGEST_PRIORITY` (default `high`).
- **Weekly** (the whole Mon-Sun week grouped by day, plus open tasks):
  `WEEKLY_DIGEST_ENABLED` (default `false`), `WEEKLY_DIGEST_TO` (defaults to
  `DIGEST_TO`), `WEEKLY_DIGEST_CRON` (default `0 8 * * 1`, Mondays 08:00).
- SMTP: `SMTP_HOST`, `SMTP_PORT` (465), `SMTP_SECURE` (true), `SMTP_USER`,
  `SMTP_PASS`, `SMTP_FROM`.

Crons are scheduled at startup (look for `digest scheduled:` and
`weekly digest scheduled:` in `ics-proxy` logs). Send a test on demand via the
token-gated `POST /send-digest` (not exposed through nginx; call it from inside
the network). Body is optional: `{}` for today's daily; `{"weekly":true}` for
this week; add `"date":"YYYY-MM-DD"` to target another day/week, or
`"preview":true` to get the HTML back without sending.

```bash
TOKEN=$(grep '^API_TOKEN=' .env | cut -d= -f2- | tr -d '"'\''')
docker exec -e TOK="$TOKEN" ics-proxy node -e '
  fetch("http://localhost:3000/send-digest",{method:"POST",headers:{"Content-Type":"application/json","X-Api-Token":process.env.TOK},body:JSON.stringify({weekly:true})})
    .then(async r=>console.log(r.status, await r.text()));'
```

## Remote deployment

`dash.example.com` runs on the PVE server. It needs the same files; redeploy there
after changing nginx/proxy config. nginx needs `API_TOKEN` in its environment for
the template render (compose already wires it).

## MCP server

See `mcp.md` for full details (architecture, tools, registration, smoke tests).

A remote MCP server (`mcp/` service, stateless Streamable HTTP) wraps the proxy
as named tools, reachable at `/mcp` behind nginx, token-gated by `X-Api-Token`.
It calls `ics-proxy` over the Docker network. Auth is header-token only: works in
Claude Code and Claude Desktop (via the mcp-remote bridge). claude.ai web
connectors would need OAuth (out of scope; Phase 2).

Registered in `.mcp.json` (project scope, `type: http`, url
`http://localhost:8088/mcp`, header `X-Api-Token`). A new Claude Code session
picks it up after approving the project MCP server.

Tools: `list_events`, `list_ics_events`, `list_tasks`, `create_task`,
`complete_task`, `rename_task`, `create_event`, `create_meeting`, `get_agenda`,
`find_free_slots`, `search`, `search_attendees`, `search_directory`, `delete_meeting`, `reschedule_meeting`,
`delete_event`, `reschedule_event`,
`update_event`, `delete_task`, `set_task_dates`, `plan_day`, `commit_day_plan`,
`triage_tasks`, `check_conflicts`, `get_weather`, `set_weather_location`, `get_status`.
Deck (Nextcloud kanban; writes need user confirmation): `list_deck_boards`,
`get_deck_cards` (opt `dueDays`), `list_deck_stacks`, `create_deck_board`,
`create_deck_stack`, `create_deck_card`, `delete_deck_card`. Cards with due
dates appear in the weekly digest ("Deck · Karten fällig diese Woche"); the
weekly task blocks list only tasks due/overdue that week. Strava (read-only): `list_strava_activities`,
`get_strava_athlete`, `get_strava_zones`, `get_strava_gear`,
`get_strava_activity`, `get_strava_streams`, `get_strava_clubs`,
`get_strava_ytd`, `get_strava_load`, `get_readiness`, `get_load_vs_training`, `get_strava_series`.

Strava is read-only (no write tools, no confirmation needed). Credentials live on
`ics-proxy` (`STRAVA_*` in `.env`); the proxy refreshes access tokens itself. If
logs show `Strava rotated the refresh token`, update `STRAVA_REFRESH_TOKEN`.

Activity history is synced into SQLite (`STRAVA_DB`, default `/data/strava.db`,
on the `./data` volume): a full backfill on first boot, then an incremental
cron every 30 minutes, which also re-warms the widget-facing aggregate caches
(stats, ytd, load, readiness). The `/strava-api/series` charts read this DB, so they support
any day/week/month/custom range. Force a sync with token-gated
`POST /strava/sync` (`{"full":true}` to re-backfill). Optional annual goals:
`STRAVA_GOAL_RUN_KM` / `_RIDE_KM` / `_SWIM_KM` (0 = no goal bar). The Strava page
(`config/strava.yml`) renders the charts client-side via `/strava-api/series`.

Smoke-test a tool over HTTP:

```bash
TOKEN=$(grep '^API_TOKEN=' .env | cut -d= -f2- | tr -d '"'\''')
curl -s -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -H "X-Api-Token: $TOKEN" -X POST \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_tasks","arguments":{"list":"work"}}}' \
  http://localhost:8088/mcp
```

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
| `/ews-api/coach-briefing?date=YYYY-MM-DD` | data bundle for a training/day coaching read: `{date,readiness,load,ytd,weeklyTrend:{distanceKm,effort,cadence} (8wk),recentActivities:[{name,sport,when,distance_km,moving_time_s,elevation_gain_m,avg_hr,max_hr,avg_watts,avg_cadence,avg_speed_kmh,pace_min_per_km,relative_effort}] (last 5),hrZoneBoundaries,latestActivityHrZones,weather,calendar:{meetingHours,eventCount},tasks,bikeMaintenanceDue}`. Opt `date` (default today) affects only the calendar/task slice, not the training trend. `hrZoneBoundaries` is the athlete's configured Z1..Z5 bpm ranges; `latestActivityHrZones` is time-in-zone for the most recent HR-bearing activity. Facts + cheap derived numbers only, no narrative — write the actual coaching read/recommendation yourself, same pattern as `plan-day`. For zone-time detail on a different specific session, follow up with `/strava-api/activity/:id/zones`. Read-only. |
| `/ews-api/check-conflicts?start=ISO&end=ISO` | events across both calendars overlapping a proposed slot: `{start,end,hasConflict,conflicts:[...]}`. Call before creating a meeting. |
| `/ews-api/check-duplicates?date=YYYY-MM-DD` | events across both calendars with the same title whose times overlap or sit within 15min of each other: `{hasDuplicates,duplicates:[[{cal,title,start,end,location,id,uid},...],...]}`. Or `?from=ISO&to=ISO`. Call for the affected date right after creating or rescheduling an event, before confirming success — catches accidental double-creates and old events left behind by a manual "move" (create new + forgot to delete old). |
| `/tasks-api/task-triage` | open tasks needing attention: `{today,home:{no_due,overdue,due_soon},work:{...}}` (each task has `uid,title,due`). Opt: `soonDays` (default 3). |
| `/deck-api/boards` | Nextcloud Deck boards (non-archived): `[{id,title,color}]`. |
| `/deck-api/cards` | open Deck cards across all boards (excl. archived/done): `[{id,title,board,boardId,stack,stackId,due,labels}]`. `boardId`/`stackId` are what update/move need. |
| `/deck-api/cards-due?days=N` | overdue + cards due within N days (default 7), sorted by due. |
| `/deck-api/stacks?board=ID` | stacks (columns) of a board: `[{id,title,order}]`. Needed to place or move a card. |
| `/deck-api/card?boardId=&stackId=&cardId=` | full detail for one card, including its description (the list endpoint above omits it to stay light): `{id,title,description,due,boardId,stackId}`. |
| `/siyuan-api/notes` | every note in the RAG notebook, including nested ones: `{notes:[{docId,title,path}]}`. Use to browse or check for an existing title. |
| `/siyuan-api/hybrid-search?q=TERM` | default search over the SiYuan "RAG" notebook: fuses full-text (`/siyuan-api/search`) and semantic (`/siyuan-api/semantic-search`) results via reciprocal rank fusion, so an exact term and a paraphrased/conceptual match both surface without picking a mode up front. Returns `{query,results:[{docId,title,path?,heading?,snippet?,score}]}`. Opt `limit` (default 10, max 50), `minScore` (semantic-side floor, default `EMBEDDINGS_MIN_SCORE`). |
| `/siyuan-api/search?q=TERM` | pure full-text search over the SiYuan "RAG" notebook only (`SIYUAN_NOTEBOOK_NAME`, default `RAG`) — never the user's other notebooks: `{query,results:[{id,docId,title,path,snippet}]}`, deduped to one result per note. Opt `limit` (default 10, max 50). |
| `/siyuan-api/note?id=DOCID` | full markdown content of one note by `docId` (from a search result): `{id,markdown}`. Rejects ids outside the RAG notebook. |
| `/siyuan-api/note-attrs?id=DOCID` | a note's attributes: built-in metadata (`id,title,type,updated`) plus any `custom-*` key/value tags previously set. Rejects ids outside the RAG notebook. |
| `/siyuan-api/backlinks?id=DOCID` | notes that link TO this one via SiYuan's own block-reference syntax (`((docId 'text'))`) — real backlinks, not a keyword match: `{docId,backlinks:[{docId,title,path}]}`. Queried directly against SiYuan's SQLite `refs` table, scoped to the RAG notebook. Rejects ids outside the RAG notebook. |
| `/siyuan-api/semantic-search?q=TERM` | pure meaning-based search over the same RAG notebook using a local embedding model (`Xenova/multilingual-e5-small`, on-device, no external API) — finds conceptually related notes even without shared keywords, and matches across German/English. Weak matches (cosine similarity below `minScore`, default `EMBEDDINGS_MIN_SCORE`) are dropped rather than padding out the result count. Prefer `/siyuan-api/hybrid-search` for general queries; use this or `/siyuan-api/search` directly only when you want one mode's ranking in isolation. Returns `{query,results:[{docId,title,score}]}`, ranked by similarity. Opt `limit` (default 10, max 50), `minScore`. |
| `/ews-api/weather?date=YYYY-MM-DD` | Open-Meteo forecast: `{date,place,text,emoji,tempMax,tempMin,precip,precipProb,windMax,sunrise,sunset,hourly}`. No key. Location = saved default (see `POST /weather/location`) else `WEATHER_*` env else Heidelberg. Override per call with `?place=NAME` (geocoded) or `?lat=&lon=`. |
| `/strava-api/readiness` | training readiness: `{score,recommendation,color,acwr,restingHr,hrv,sleepHours,daysSinceLast,reasons,note}`, combining ACWR + resting HR/HRV/sleep. |
| `/strava-api/load-vs-training?weeks=8` | per-week work-meeting hours vs training km/effort: `{weeks,series:[{label,meetingHours,meetingCount,trainingKm,effort,meetingPct,effortPct}]}`. |
| `/ews-api/plan-cycling-training?destination=NAME` | weather-aware ride planner: forecast at both `start` (opt, defaults to your saved/default weather location) and `destination`, a packing list covering the worse of the two, and a carb/gel target (60g carbs/h, 25g/gel, none under 60min). Duration: `durationMinutes`, or `distanceKm` (+ optional `avgSpeedKmh`, else derived from your recent Strava ride average), or if neither given, distance is estimated from the straight-line start→destination distance ×1.3 (not a real route). Opt: `date` (default today, must be within the ~7-day Open-Meteo window). Returns `descriptionDraft` — pass straight through as `description` to `create_event` for the ride (still needs confirmation like any write). Read-only. |
| `/status` (internal; not via nginx) | backend health: cache ages, last Strava sync, DB activity count, digest crons, last Health ingest, configured backends. |
| `/health-api/summary` | latest value per Apple Health metric (from Health Auto Export, via the iOS app's ingest POST below): sleep, resting HR, HRV, steps, active energy, weight, body fat, BMI, VO2max, respiratory rate, walking HR, exercise minutes, flights climbed, daylight, water, and nutrition (energy intake, carbs, protein, fat). Each entry has `{day,value,unit}`. The 24/7 non-workout signals Strava lacks. |
| `/health-api/series?metric=&days=` | daily time series for one Apple Health metric over the last N days (default 30, max 366): sleep, resting_hr, hrv, steps, active_energy, weight, body_fat, bmi, energy_intake, carbs, protein, fat. |
| `/health-api/raw?meta=1` (internal debugging) | most recently ingested raw Health Auto Export payload (or, with `meta=1`, just its size/keys) — used to inspect the payload shape when extending the parser, not for normal assistant use. |
| `/strava-api/activities?per_page=&page=&before=&after=` | recent Strava activities (metric, newest first), simplified with a Berlin `when`. |
| `/strava-api/athlete` | Strava profile incl. bikes/shoes. |
| `/strava-api/zones` | HR + power zones. |
| `/strava-api/gear` (`/gear/:id`) | gear list (or one item's detail). |
| `/strava-api/activity/:id` | detailed activity performance (HR/watts/cadence, calories, effort, elevation range, location, gear, route incl. decoded `route_latlng`, laps, efforts, PRs); social counters and account/visibility flags omitted. |
| `/strava-api/activity/:id/streams?keys=&resolution=` | activity time-series streams. |
| `/strava-api/clubs` (`/club/:id/events`) | clubs (or a club's upcoming events). |
| `/strava-api/ytd` | year-to-date totals per sport (Run/Ride/Swim) + goal progress. |
| `/strava-api/load` | training load: acute:chronic workload ratio (ACWR) with status. |
| `/strava-api/series?metric=hr\|effort\|distance\|cadence&granularity=day\|week\|month&from=&to=` | DB-backed time series for the customizable charts. |
| `/strava-api/activity/:id/zones` | time-in-zone distribution for one activity (HR zones, and power zones if it has watts): minutes per zone, not just the average. |
| `/bike-api/maintenance` | bike maintenance status (tires, drivetrain, brakes, bolt torque, annual service) for the primary bike: `{items:[{id,label,category,progress,interval,unit,status,color,pct}]}`. `status` is `Bereit zum Fahren`/`Bald prüfen`/`Überfällig`. Progress for km-based items comes from the bike's live Strava odometer minus the item's last reset point; day-based items count elapsed days since reset. No service-history API exists to derive this automatically — items only advance because you actually reset them. |
| `/garmin-api/workouts?limit=N` | workouts saved in the user's Garmin Connect library: `[{workoutId,name,sport,updated}]`. Default limit 20. |

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
| `/health-api/ingest` | raw Health Auto Export payload | Called by the iOS Health Auto Export app's automation, not by the assistant. Stores the raw payload (last 20 kept) and parses it into daily per-metric points. |
| `/deck-api/boards` | `{title,color?}` | Create a Deck board. New boards have no stacks; add one before adding cards. |
| `/deck-api/stacks` | `{boardId,title}` | Create a stack (column) on a board. |
| `/deck-api/cards` | `{boardId,stackId,title,due?,description?}` | Create a Deck card. `due`: ISO or `YYYY-MM-DD`. A due date puts it in the weekly digest's Deck block. |
| `/deck-api/delete-card` | `{boardId,stackId,cardId}` | Delete a Deck card. |
| `/deck-api/update-card` | `{boardId,stackId,cardId,title?,description?,due?}` | Update a Deck card's title/description/due in place; only given fields change. |
| `/deck-api/move-card` | `{boardId,cardId,toStackId,order?}` | Move a card to a different stack (e.g. "move to Done"). Moving into a done-flagged stack auto-marks the card done (Deck's own behavior). |
| `/ews-api/delete-ics-event` | `{uid}` | Delete a Nextcloud (home) event. |
| `/ews-api/delete-exchange-event` | `{id,allowSeries?}` | Delete/cancel an Exchange (work) event by EWS `id` (from `/events`). Refuses a recurring SERIES master unless `allowSeries:true`; a single occurrence id removes only that instance. Sends cancellations to attendees. |
| `/ews-api/reschedule-exchange-event` | `{id,start,end,allowSeries?}` | Move an Exchange (work) event to a new start/end by EWS `id`. ISO 8601 with offset. Same series guard. Notifies attendees. |
| `/ews-api/reschedule-ics-event` | `{uid,start,end?}` | Move a Nextcloud (home) event. `start`/`end`: `YYYY-MM-DD` or ISO datetime. Exchange events not supported. |
| `/ews-api/update-ics-event` | `{uid,start?,end?,location?,summary?,description?}` | Update a Nextcloud (home) event in place: set location, note (`description`), rename, and/or move. Only provided fields change. |
| `/siyuan-api/note` | `{title,markdown?,parentDocId?}` | Create a note in the RAG notebook. Rejects if a note with the exact title already exists. `parentDocId` nests it under an existing note; omit for the notebook root. Returns `{ok,docId}`. |
| `/siyuan-api/update-note` | `{docId,markdown,title?,mode?}` | `mode:"replace"` (default) overwrites the whole body; `mode:"append"` adds to the end instead. Optional `title` also renames it. Rejects ids outside the RAG notebook. |
| `/siyuan-api/move-note` | `{docId,parentDocId?}` | Move/reparent a note. `parentDocId` nests it under another existing note; omit to move it to the notebook root. Rejects ids outside the RAG notebook. |
| `/siyuan-api/note-attrs` | `{docId,attrs}` | Set custom key/value tags on a note. Keys are auto-prefixed `custom-` if not already. Existing attrs not mentioned are left untouched. Rejects ids outside the RAG notebook. |
| `/siyuan-api/embeddings-sync` | `{full?}` | Manually reconcile the semantic-search index against the RAG notebook's current state (new/changed notes re-embedded, deleted notes pruned). `full:true` re-embeds every note; omit for incremental (skips notes whose `updated` attr hasn't changed). Runs automatically on boot and hourly; this is a manual trigger, e.g. after a bulk import. Not needed for normal use — notes created/edited/deleted via this API's own endpoints are already re-embedded synchronously. |
| `/siyuan-api/delete-note` | `{docId}` | Delete a note. Rejects ids outside the RAG notebook. |
| `/bike-api/reset-maintenance-item` | `{itemId}` | Mark a bike maintenance item done: km-based items reset against the bike's current Strava odometer, day-based items reset to today. `itemId` one of `tires`, `drivetrain`, `brakes`, `bolts`, `annual`. Confirm with the user before resetting, like any other write. |
| `/garmin-api/workout` | `{name,description?,sport?,steps,date?}` | Create a structured training-session workout in the user's Garmin Connect library (warmup/interval/recovery/cooldown steps, one level of repeat blocks, heart-rate/power/pace targets — see `ics-proxy/lib/garmin.js` for the exact step/target schema). `sport` one of `running`/`cycling`/`walking` (default `cycling`). Pass `date` (`YYYY-MM-DD`) to also schedule it onto that day so it syncs to the watch/head unit; omit to just save it to the library. Returns `{ok,workoutId,name,scheduledDate?}`. Confirm the exact structure with the user before creating, like any other write. |
| `/garmin-api/schedule-workout` | `{workoutId,date}` | Schedule an existing Garmin workout onto a calendar date (syncs to the watch as that day's workout). Confirm with the user first. |
| `/garmin-api/delete-workout` | `{workoutId}` | Delete a workout from the user's Garmin Connect library. Confirm the exact workout with the user first. |

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

## Calendar-feed export (external ICS subscription)

`GET /calendar-feed.ics?token=CALENDAR_FEED_TOKEN` renders the Exchange
calendar (past `CALENDAR_FEED_PAST_DAYS`, default 30 days, to future
`CALENDAR_FEED_FUTURE_DAYS`, default 180 days) as an ICS feed, for
subscribing to the work calendar read-only from Nextcloud (Kalender →
"Neues Abonnement") or any other ICS-subscription client. Lives in
`ics-proxy` (not `mail-proxy` — mail-proxy is only used interactively/
occasionally, not a good fit for a feed a client polls on its own schedule)
and is part of the normal deploy, local and remote alike.

Deliberately **not** gated by the shared `X-Api-Token` header like every
other endpoint here — subscription clients don't send custom headers, so
the `?token=` query param is the entire access control (its own nginx
`location /calendar-feed.ics` skips the header check; `ics-proxy` checks the
token itself). Same "URL-as-secret" trust model as `ics-proxy`'s own
`ICS_URL` (Nextcloud's public read share for the home calendar). Unset
`CALENDAR_FEED_TOKEN` (default) disables the route entirely (404, not 403,
so an unconfigured deployment doesn't even reveal it exists). Whoever holds
that URL can read the full work calendar indefinitely — no expiry, no
revocation short of rotating the token — so treat the URL itself as a
credential (don't paste it into chat logs, tickets, etc.).

## Write safety (the user's standing rule)

ALWAYS show the exact payload and wait for an OK before any POST. No
fire-and-forget. Meetings with attendees email real people. After confirming,
POST, then verify (see cache note).

After creating or rescheduling an event (`create_event`, `create_meeting`,
`reschedule_event`, `reschedule_meeting`), ALWAYS call `check_duplicates`
(`GET /ews-api/check-duplicates?date=...`) for the affected date before telling
the user it succeeded. This catches accidental double-creates and the case
where a "move" was done by hand (create new + forgot to delete the old one).
If it reports a match, confirm with the user which one to delete before
deleting anything — don't guess.

## Gotchas

1. **Timezone.** Event `start` is UTC ISO. The user is in Europe/Berlin
   (UTC+2 in summer). The `when` field is already formatted to Berlin; if you
   compute from `start`, convert. Today's date is provided in the session
   context; do not guess it.

2. **Cache.** Reads are cached (default TTL 5 min). A write invalidates the
   matching cache, so the next GET does a synchronous fresh fetch (slightly
   slower, but correct) rather than serving stale data — one GET right after a
   write is enough to verify it.

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

5. **Semantic search index (first boot).** `ics-proxy` embeds the RAG
   notebook locally (`@huggingface/transformers`, `Xenova/multilingual-e5-small`,
   `lib/embeddings.js`) — no external API, nothing leaves the server. On
   first boot with `SIYUAN_URL`/`SIYUAN_TOKEN` set, it downloads the ~130MB
   model once (cached under `EMBEDDINGS_MODEL_CACHE`, default
   `/data/models`, on the persistent volume — survives restarts/rebuilds)
   and backfills every note into `EMBEDDINGS_DB` (default
   `/data/embeddings.db`). Requires the Debian-based `ics-proxy` image (see
   Dockerfile comment) — the ONNX runtime's native bindings don't support
   Alpine/musl. Notes created/edited/deleted via this API's own endpoints
   are re-embedded synchronously; an hourly cron reconciles anything changed
   directly in the SiYuan UI. `POST /siyuan-api/embeddings-sync` triggers a
   manual pass (`{full:true}` to force re-embedding everything). A note is
   chunked per heading section, and any section over ~3000 chars is split
   further on paragraph boundaries so a long section never gets silently
   truncated by the embedder's own input cap. `semantic-search` and
   `hybrid-search` drop matches below a cosine-similarity floor
   (`EMBEDDINGS_MIN_SCORE`, default 0.86) so an unrelated query returns empty
   rather than padding out `limit` with noise. That default was measured
   against this notebook: a gibberish query still scores 0.83-0.85 against
   unrelated notes with `Xenova/multilingual-e5-small` (this model's
   embedding space is anisotropic — nothing scores near 0), while a genuine
   match scores 0.90+. Model-specific, so re-measure if the embedding
   backend/model ever changes (same probe: one gibberish query, one query
   you know matches a specific note, compare scores).

## Email digests

`ics-proxy` sends HTML emails via SMTP, both share the same styled layout:

- **Daily** (today's events work + home, plus open tasks): `DIGEST_ENABLED`
  (default `false`), `DIGEST_TO`, `DIGEST_CRON` (default `0 8 * * *`),
  `DIGEST_TZ` (default `Europe/Berlin`), `DIGEST_PRIORITY` (default `high`).
- **Weekly** (events/tasks preview the Mon-Sun week containing today — a
  Monday send covers *this* week; Strava recaps *last* week, one week
  earlier): `WEEKLY_DIGEST_ENABLED` (default `false`), `WEEKLY_DIGEST_TO`
  (defaults to `DIGEST_TO`), `WEEKLY_DIGEST_CRON` (default `0 8 * * 1`,
  Mondays 08:00).
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

## Push notifications (ntfy)

`ics-proxy` pushes a proactive alert via [ntfy](https://ntfy.sh) — bike
maintenance gone overdue/due-soon, tasks overdue/due within 3 days, Deck cards
due within 3 days — on the same schedule as the daily digest (`DIGEST_CRON`/
`DIGEST_TZ`), independent of whether the email digest itself is enabled.
Nothing is sent if none of those have anything to report, so it stays
occasional rather than a guaranteed daily ping.

Config: `NTFY_URL` (default `https://ntfy.sh`), `NTFY_TOPIC` (required to
enable — empty disables the feature), `NTFY_TOKEN` (optional, for a
protected/reserved topic). Free ntfy.sh tier: 250 messages/day, resets daily.

Look for `ntfy alerts scheduled:` in `ics-proxy` logs at startup, and `/status`
-> `ntfy.configured`. Test on demand via token-gated `POST /send-alerts`
(not exposed through nginx; call it from inside the network, same pattern as
`/send-digest`). Body optional: `{}` sends now if there's anything to report;
`{"preview":true}` returns the composed sections without pushing.

## Remote deployment

`dash.example.com` runs on the PVE server. It needs the same files; redeploy there
after changing nginx/proxy config. nginx needs `API_TOKEN` in its environment for
the template render (compose already wires it).

## openGym (self-hosted gym tracker)

`./openGym` is a separate upstream project ([gitea.com/DuarteSantos/openGym](https://gitea.com/DuarteSantos/openGym),
its own `.git`, gitignored here — never commit it into this repo) folded into
this stack: `docker compose up -d --build` starts its `opengym-media`,
`opengym-api`, `opengym-web` services alongside everything else. See
`openGym/README.md` and `openGym/docs/SELF_HOSTING.md` for what the app does.

**Deliberately not routed through the shared nginx.** openGym signs in with
passkeys (WebAuthn), bound to one exact hostname (`RP_ID`) served over one
origin, and its own `web` container already terminates that origin (SPA +
`/api` on the same origin — passkeys require this). It gets its own port
instead: `GYM_WEB_PORT` in `.env` (default `8090`), `http://localhost:8090`
locally.

**For phone use you need a real HTTPS hostname** (passkeys don't work over a
plain LAN IP; `http://localhost` is the only HTTP exception, and that only
helps the machine running Docker). Chosen: **`gym.example.com`**. This is a
manual, one-time step outside this repo: route that hostname to the PVE
host's `GYM_WEB_PORT`, however `dash.example.com` itself is fronted
(nginx.conf.template's keepalive comment implies Cloudflare — a second
Tunnel route is the likely match). Then on the PVE box's `.env` (not this
one — local stays `localhost`/`8090` for testing):

```bash
GYM_RP_ID=gym.example.com
GYM_ORIGIN=https://gym.example.com
```

and `docker compose up -d`. Changing `RP_ID` later invalidates existing
passkeys, so this is worth getting right before anyone registers.

**Deploying to `dash.example.com`:** the PVE box needs its own `./openGym`
checkout at the same relative path (`git clone` it there, same as this repo)
before `docker compose up -d --build` picks up the `opengym-*` services —
it isn't carried by this repo's own deploy since `openGym/` is gitignored.

**Gotcha: `opengym-web`'s bundled nginx goes stale too, same as the shared
one (see Gotcha #2 above).** Recreating `opengym-api` alone (e.g. an
env-only `docker compose up -d opengym-api` after editing `.env`) can leave
`opengym-web`'s nginx holding the OLD container's Docker-network IP, which
Docker may since have handed to a *different* container (e.g. `mcp`) — so
`/api/*` calls silently land on the wrong service instead of erroring
clearly. Symptom actually seen: `POST /api/register/options` returning a
generic `{"error":"Unauthorized"}` with `x-powered-by: Express` and an
`X-Api-Token` CORS header — that's `mcp`'s OAuth-gated response, not
openGym's (openGym's own API has no framework and never emits that
message). Fix: `docker compose restart opengym-web` (or recreate both
`opengym-api` and `opengym-web` together) whenever `opengym-api` changes.

**Assistant access:** the `mcp` service bridges 8 of openGym's own read-only
MCP tools (`gym_*`) directly into the same remote MCP surface everything else
here uses — see `mcp.md` and `CLAUDE.md`'s MCP tools list. Needs the same
`./openGym` checkout present next to `docker-compose.yml` (mounted read-only
into the `mcp` container); without it those tools just don't appear.

## MCP server

See `mcp.md` for full details (architecture, tools, registration, smoke tests).

A remote MCP server (`mcp/` service, stateless Streamable HTTP) wraps the proxy
as named tools, reachable at `/mcp` behind nginx. It calls `ics-proxy` over the
Docker network. Two auth paths: `X-Api-Token` header (Claude Code, Claude
Desktop via the mcp-remote bridge) or `Authorization: Bearer <JWT>` (claude.ai
web custom connector, OAuth 2.1 via Pocket ID as the authorization server —
already configured, see `mcp.md` for the full setup).

Registered in `.mcp.json` (project scope, `type: http`, url
`http://localhost:8088/mcp`, header `X-Api-Token`). A new Claude Code session
picks it up after approving the project MCP server.

Tools: `list_events`, `list_ics_events`, `list_tasks`, `create_task`,
`complete_task`, `rename_task`, `create_event`, `create_meeting`, `get_agenda`,
`find_free_slots`, `search`, `search_attendees`, `search_directory`, `delete_meeting`, `reschedule_meeting`,
`delete_event`, `reschedule_event`,
`update_event`, `delete_task`, `set_task_dates`, `plan_day`, `commit_day_plan`,
`triage_tasks`, `check_conflicts`, `check_duplicates`, `get_weather`, `set_weather_location`, `get_status`,
`coach_briefing` (data bundle combining readiness/load/training trend with the day's calendar/task load — write the coaching narrative yourself, see `plan_day`'s pattern),
`get_health_summary`, `get_health_series` (Apple Health via Health Auto Export — read-only,
the 24/7 non-workout signals Strava lacks: sleep, resting HR, HRV, steps, weight, nutrition, etc.).
Deck (Nextcloud kanban; writes need user confirmation): `list_deck_boards`,
`get_deck_cards` (opt `dueDays`), `list_deck_stacks`, `get_deck_card` (full detail incl.
description — get_deck_cards omits it; read before editing a card's content), `create_deck_board`,
`create_deck_stack`, `create_deck_card`, `delete_deck_card`, `update_deck_card`,
`move_deck_card` (moves a card to a different stack, e.g. "move to Done").
Cards with due dates appear in the weekly digest ("Deck · Karten fällig diese Woche"); the
weekly task blocks list only tasks due/overdue that week. Bike maintenance (tires, drivetrain,
brakes, bolt torque, annual service — tracked against the primary bike's Strava odometer for
km-based items, elapsed days for time-based ones; writes need confirmation): `get_bike_maintenance`,
`reset_bike_maintenance_item`. Items due-soon/overdue appear in the weekly digest
("Fahrrad · Wartung fällig") and on the Strava dashboard page. Strava (read-only): `list_strava_activities`,
`get_strava_athlete`, `get_strava_zones`, `get_strava_gear`,
`get_strava_activity`, `get_strava_streams`, `get_strava_activity_zones`, `get_strava_clubs`,
`get_strava_ytd`, `get_strava_load`, `get_readiness`, `get_load_vs_training`, `get_strava_series`,
`plan_cycling_training`. Garmin Connect (push-only structured workouts; no
public Garmin API, unofficial login, writes need confirmation): `create_garmin_workout`
(steps: warmup/interval/recovery/cooldown, one level of repeat blocks,
heart-rate/power/pace targets; optional `date` also schedules it),
`list_garmin_workouts`, `schedule_garmin_workout`, `delete_garmin_workout`.
openGym (self-hosted gym/body-weight tracker, `../openGym` — a separate upstream repo folded
into this stack, not built by this project; read-only, no confirmation needed, same as
Strava): `gym_list_routines`, `gym_get_routine`, `gym_get_week_plan`, `gym_list_workouts`,
`gym_get_workout`, `gym_get_bodyweight`, `gym_estimate_1rm`, `gym_muscle_balance` — these
ARE openGym's own MCP tools (`openGym/mcp/src/tools.js`), imported directly by the `mcp`
service rather than reimplemented, so numbers match its Stats screen exactly. If `openGym/`
isn't checked out these tools just don't appear; see `mcp.md` for the bridge details and
`openGym/mcp/README.md` for the tools themselves. Complements Strava/Garmin (cardio) with
strength training — useful together for a fuller `coach_briefing`-style read, though nothing
wires them into that bundle automatically yet.
SiYuan Note (RAG-style knowledge base, scoped to one
dedicated "RAG" notebook — never the user's other notebooks; writes need
confirmation like any other write): `list_notes`, `hybrid_search_notes`
(default search — fuses full-text and semantic results via reciprocal rank
fusion so an exact term and a paraphrased/conceptual match both surface),
`search_notes` (pure full-text), `semantic_search_notes` (pure
meaning-based, via a local embedding model — prefer `hybrid_search_notes`
for general queries; use one of these directly only when you want a single
mode's ranking in isolation, e.g. exact terms with no semantic fuzz, or
comparing the semantic side by itself), `get_note`, `create_note` (optional `parentDocId` to nest
under an existing note), `update_note` (replace or append), `move_note`
(reparent or move to root), `get_note_attrs`/`set_note_attrs` (custom
key/value tags on a note), `get_note_backlinks` (notes linking TO this one via
SiYuan's own block-reference syntax — real backlinks, not a keyword match),
`delete_note`.

Strava is read-only (no write tools, no confirmation needed). Credentials live on
`ics-proxy` (`STRAVA_*` in `.env`); the proxy refreshes access tokens itself. If
logs show `Strava rotated the refresh token`, update `STRAVA_REFRESH_TOKEN`.

Garmin Connect is write-only (no read tools; Strava already covers completed
activities). Credentials live on `ics-proxy` (`GARMIN_EMAIL`/`GARMIN_PASSWORD`
in `.env`, no MFA support — see README "Garmin setup"). Session tokens are
cached to `GARMIN_TOKENS_FILE` (default `/data/garmin-tokens.json`) so it
doesn't need to log in on every restart.

Activity history is synced into SQLite (`STRAVA_DB`, default `/data/strava.db`,
on the `./data` volume): a full backfill on first boot, then an incremental
cron every 30 minutes, which also re-warms the widget-facing aggregate caches
(stats, ytd, load, readiness). The `/strava-api/series` charts read this DB, so they support
any day/week/month/custom range. Force a sync with token-gated
`POST /strava/sync` (`{"full":true}` to re-backfill). Optional annual goals:
(`STRAVA_GOAL_RUN_KM` / `_RIDE_KM` / `_SWIM_KM` (0 = no goal bar). The Strava page
(`config/strava.yml`) renders the charts client-side via `/strava-api/series`.

Smoke-test a tool over HTTP:

```bash
TOKEN=$(grep '^API_TOKEN=' .env | cut -d= -f2- | tr -d '"'\''')
curl -s -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -H "X-Api-Token: $TOKEN" -X POST \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_tasks","arguments":{"list":"work"}}}' \
  http://localhost:8088/mcp
```

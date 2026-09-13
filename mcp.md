# Glance MCP server

A remote [MCP](https://modelcontextprotocol.io) server that wraps the `ics-proxy`
API as named tools, so any MCP client (Claude Code, Claude Desktop) can read and
write the user's calendar and tasks. It is a thin layer: every tool just calls an
`ics-proxy` endpoint over the Docker network.

Source: `mcp/server.js`. Runs as the `mcp` container in `docker-compose.yml`.

## Architecture

```
Claude client ──HTTP+token──> nginx:8088 /mcp ──> mcp:3001 ──> ics-proxy:3000 ──> Exchange / Nextcloud
```

- Transport: **stateless Streamable HTTP**. A fresh server + transport is created
  per request (no sessions), served at `POST /mcp`. `GET`/`DELETE` return 405.
- The container reaches `ics-proxy` directly at `PROXY_URL`
  (`http://ics-proxy:3000`). GET endpoints need no token internally; POSTs are
  sent with the `X-Api-Token` the container holds (`API_TOKEN` env).
- nginx token-gates `/mcp`: every request must carry a valid `X-Api-Token`, else
  403. See `nginx.conf.template`.

## Auth

`/mcp` accepts EITHER of two credentials (checked by the mcp service, not nginx):

1. **`X-Api-Token: <API_TOKEN>`** — Claude Code (native remote HTTP MCP, custom
   headers) and Claude Desktop via [`mcp-remote`](https://www.npmjs.com/package/mcp-remote).
2. **`Authorization: Bearer <JWT>`** — **claude.ai web custom connector**, OAuth
   2.1 with a JWT issued by an external authorization server (Pocket ID).

### claude.ai web (OAuth 2.1 via Pocket ID)

The mcp service is an OAuth **resource server**; Pocket ID is the authorization
server. No DCR is implemented (Pocket ID has none); a static client is used.

Flow: claude.ai POSTs `/mcp` with no token → 401 + `WWW-Authenticate: Bearer
resource_metadata=".../.well-known/oauth-protected-resource"` → claude.ai fetches
that RFC 9728 metadata → finds `authorization_servers: [https://auth.example.com]`
→ reads Pocket ID's `openid-configuration` → runs auth-code + PKCE against Pocket
ID using the static client → gets a JWT → calls `/mcp` with `Bearer <JWT>`. The
mcp service verifies the JWT signature against Pocket ID's JWKS, the `iss`, and
(when present) that the token belongs to `OIDC_CLIENT_ID`.

Env (mcp service): `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `PUBLIC_BASE`, `MCP_RESOURCE`.
nginx serves `/.well-known/oauth-protected-resource` publicly and passes `/mcp`
through (auth is enforced by the service).

**One-time setup:**

1. In Pocket ID, create a client (public, PKCE on) with callback URLs
   `https://claude.ai/api/mcp/auth_callback` and
   `https://claude.com/api/mcp/auth_callback`. Note its client id.
2. Put `OIDC_*`, `PUBLIC_BASE`, `MCP_RESOURCE` in `.env`, rebuild `mcp`,
   re-render `nginx`.
3. In claude.ai → Settings → Connectors → Add custom connector: URL
   `https://dash.example.com/mcp`, and under the OAuth/advanced fields paste the
   Pocket ID **client id** (no secret, it's a public client).

## Tools

| Tool | Args | Effect |
|---|---|---|
| `list_events` | – | Upcoming Exchange (work) events `{ events, todayCount }`. Start is UTC ISO. |
| `list_ics_events` | – | Upcoming Nextcloud (home) ICS events. |
| `list_tasks` | `list: home\|work` | Open tasks `[{title,start,due,uid}]`. |
| `create_task` | `list, title, startDate?, endDate?, duration?` | Create a task. Dates are `YYYY-MM-DD` (all-day) or ISO datetime. `duration` (min) with a timed start makes a block. |
| `complete_task` | `list, uid` | Mark a task complete. |
| `rename_task` | `list, uid, newTitle` | Rename a task. |
| `create_event` | `summary, start, end?, location?, description?` | Create a Nextcloud (home) calendar event. `start`/`end`: `YYYY-MM-DD` (all-day) or ISO datetime with offset. `description` is a free-text note shown in the calendar app. |
| `create_meeting` | `subject, start, end, location?, attendees?, body?` | Create an Exchange meeting. With attendees it SENDS invites. |
| `search_attendees` | `query` | Resolve a partial name/email against the Exchange directory (GAL) + contacts. Returns matches with email first, plus name, department, office, phone, mobile. Read-only; use before `create_meeting`. |
| `search_directory` | `query` | Same lookup framed as a colleague/employee search: find someone's email, phone, office, department. Read-only. |
| `delete_meeting` | `id, allowSeries?` | Delete/cancel an Exchange (work) event by EWS `id` (from `list_events`). One occurrence id deletes only that instance; refuses a recurring series master unless `allowSeries:true`. Sends cancellations. |
| `reschedule_meeting` | `id, start, end, allowSeries?` | Move an Exchange (work) event to a new start/end by EWS `id`. Same series guard. Notifies attendees. |
| `get_agenda` | `date?` or `from?, to?` | Merged work + home events (incl. past in window) plus open tasks. `cal` is `work`/`home`. |
| `find_free_slots` | `date, duration?, dayStart?, dayEnd?` | Open slots on a day (defaults: 30 min, 09:00-17:00 Berlin). |
| `search` | `query, from?, to?` | Match events (title/location) + open tasks. Default window today..+90d; widen to search the past. |
| `delete_event` | `uid` | Delete a Nextcloud (home) event. Exchange not supported. |
| `reschedule_event` | `uid, start, end?` | Move a Nextcloud (home) event. Exchange not supported. |
| `update_event` | `uid, start?, end?, location?, summary?, description?` | Update a Nextcloud (home) event: set location, note (`description`), rename, and/or move. Exchange not supported. |
| `delete_task` | `list, uid` | Delete a task. |
| `set_task_dates` | `list, uid, startDate?, endDate?, duration?` | Set/change a task's start and/or due date. `YYYY-MM-DD` (all-day) or ISO datetime. `duration` (min) with a timed start sets due = start + duration. |
| `plan_day` | `date?, duration?, dayStart?, dayEnd?` | Planning bundle for a day: agenda, open free slots, open tasks, weather. Draft a time-blocked plan from this. Read-only. |
| `commit_day_plan` | `blocks:[{title,start,duration?\|end?,list?}]` | Write approved plan blocks as timed tasks (default list `home`). Confirm first. |
| `triage_tasks` | `soonDays?` | Tasks with no due date, overdue, or due soon, across both lists. Read-only. |
| `check_conflicts` | `start, end` | Events across both calendars overlapping a proposed slot. Call before creating a meeting. Read-only. |
| `check_duplicates` | `date?` or `from?, to?` | Events with the same title whose times overlap or sit within 15min of each other, across both calendars. Call for the affected date right after create/reschedule, before confirming success. Read-only. |
| `get_weather` | `date?` | Open-Meteo forecast for the user's location (Heidelberg default). Read-only. |
| `get_status` | – | Backend status: cache ages, last Strava sync, digest crons, last Health ingest, configured backends. Read-only. |
| `coach_briefing` | `date?` | Data bundle for a training/day coaching read: readiness, load status, 8-week distance+effort+cadence trend, YTD sport totals, last 5 activities with real per-session detail (HR, watts, cadence, pace/speed, elevation, effort), the athlete's HR zone boundaries (Z1..Z5) + time-in-zone for the most recent HR-bearing activity, today's calendar load, task triage, weather, bike maintenance due. Facts + cheap derived numbers only, no narrative — write the actual coaching read yourself. Read-only. |

Deck (Nextcloud kanban; writes need user confirmation):

| Tool | Args | Effect |
|---|---|---|
| `list_deck_boards` | – | Non-archived boards `[{id,title,color}]`. Read-only. |
| `get_deck_cards` | `dueDays?` | Open cards across all boards (excl. archived/done): `[{id,title,board,boardId,stack,stackId,due,labels}]`. `boardId`/`stackId` are what update/move need. `dueDays` limits to overdue + due within N days. Read-only. |
| `list_deck_stacks` | `boardId` | Stacks (columns) of a board: `[{id,title,order}]`. Needed to place or move a card. Read-only. |
| `create_deck_board` | `title, color?` | Create a board. New boards have no stacks. |
| `create_deck_stack` | `boardId, title` | Create a stack (column) on a board. |
| `create_deck_card` | `boardId, stackId, title, due?, description?` | Create a card. A due date puts it in the weekly digest. |
| `update_deck_card` | `boardId, stackId, cardId, title?, description?, due?` | Update a card's title/description/due in place; only given fields change. |
| `move_deck_card` | `boardId, cardId, toStackId, order?` | Move a card to a different stack, e.g. "move to Done". Moving into a done-flagged stack auto-marks it done (Deck's own behavior). |
| `delete_deck_card` | `boardId, stackId, cardId` | Delete a card. Destructive. |

Strava (read-only; require `STRAVA_*` configured, see README "Strava setup"):

| Tool | Args | Effect |
|---|---|---|
| `list_strava_activities` | `perPage?, page?, before?, after?` | Recent activities (newest first), metric units, with a Berlin-formatted `when`. |
| `get_strava_athlete` | – | Athlete profile incl. bikes and shoes. |
| `get_strava_zones` | – | Heart rate and power zones (and FTP). |
| `get_strava_gear` | `id?` | Bikes and shoes; with `id`, full detail for one item. |
| `get_strava_activity` | `id` | Detailed performance for one activity: HR/watts/cadence, calories, effort, elevation range, location, gear, route (incl. decoded `route_latlng`), laps, segment efforts, PRs. Social counters and account/visibility flags omitted. |
| `get_strava_streams` | `id, keys?, resolution?` | Time-series streams for one activity. |
| `get_strava_activity_zones` | `id` | Time-in-zone distribution for one activity (HR zones, and power zones if it has watts) — minutes per zone, not just the average. |
| `get_strava_clubs` | `clubId?` | Clubs the athlete belongs to; with `clubId`, that club's upcoming events. |
| `get_strava_ytd` | – | Year-to-date totals per sport (Run/Ride/Swim) + goal progress. |
| `get_strava_load` | – | Training load (acute:chronic workload ratio) with status. |
| `get_readiness` | – | Readiness signal: hard/easy/rest recommendation from ACWR + resting HR/HRV/sleep + days since last activity. |
| `get_load_vs_training` | `weeks?` | Per-week work-meeting hours vs training km/effort (last N weeks). |
| `get_strava_series` | `metric, granularity?, from?, to?` | DB-backed time series (hr/effort/distance) by day/week/month or custom range. |
| `plan_cycling_training` | `destination, start?, date?, durationMinutes?, distanceKm?, avgSpeedKmh?` | Weather-aware ride plan: forecast at both `start` (defaults to your saved home location) and `destination`, a packing list covering the worse of the two, and a carb/gel target. Duration/distance can be given, or estimated from the straight-line start→destination distance and your recent Strava pace. Returns `descriptionDraft` to pass to `create_event`. |

Training plans and eligibility (present in Strava's own MCP) are not exposed:
the public Strava API does not provide them.

Garmin Connect (push-only structured workouts — no public Garmin API, so this
drives the same unofficial login the mobile app uses; requires
`GARMIN_EMAIL`/`GARMIN_PASSWORD` configured, see README "Garmin setup";
writes need user confirmation):

| Tool | Args | Effect |
|---|---|---|
| `create_garmin_workout` | `name, description?, sport?, steps, date?` | Create a structured training-session workout (warmup/interval/recovery/cooldown steps, one level of repeat blocks, heart-rate/power/pace targets — see `ics-proxy/lib/garmin.js` for the exact schema) in the user's Garmin Connect library. `sport` one of `running`/`cycling`/`walking` (default `cycling`). Pass `date` (`YYYY-MM-DD`) to also schedule it onto that day so it syncs to the watch/head unit. |
| `list_garmin_workouts` | `limit?` | Workouts saved in the library: `[{workoutId,name,sport,updated}]`. Read-only. |
| `schedule_garmin_workout` | `workoutId, date` | Schedule an existing workout onto a calendar date. |
| `delete_garmin_workout` | `workoutId` | Delete a workout from the library. Destructive. |

openGym (self-hosted gym/body-weight tracker, `../openGym` — a separate upstream repo, not
part of this one; read-only, no confirmation needed, same as Strava). Bridged rather than
reimplemented: these 8 tools ARE openGym's own MCP tools (`openGym/mcp/src/tools.js`),
imported directly so the numbers match its Stats screen exactly (same pure functions as its
React UI — 1RM estimation, muscle balance, progression). `docker-compose.yml` bind-mounts
`openGym/mcp/src`, `openGym/frontend/src/lib` and `openGym/data` read-only into the `mcp`
container for this; if `openGym/` isn't checked out (or those mounts are absent), the bridge
logs a warning at startup and these tools simply don't appear — the rest of the server is
unaffected. `GYM_MCP_UID` (`.env`) picks which openGym profile to answer for; empty
auto-detects when there's exactly one. See `openGym/mcp/README.md` for the tools' own docs.

| Tool | Args | Effect |
|---|---|---|
| `gym_list_routines` | – | Routines saved in the profile's plan (names + exercise counts). |
| `gym_get_routine` | `routine_id` | Full sets/reps/weight prescription for one routine (id from `gym_list_routines`). |
| `gym_get_week_plan` | – | The week's plan by weekday, including any date-specific override for today. |
| `gym_list_workouts` | `from?, to?` (`YYYY-MM-DD`), `limit?` (default 25, max 200) | Recent sessions, newest first: date, sets done/planned, volume, duration, PRs. |
| `gym_get_workout` | `date?` or `workout_id?` | Full set-by-set breakdown of one session. A date with two sessions returns both ids to pick from rather than guessing. |
| `gym_get_bodyweight` | `from?, to?` (`YYYY-MM-DD`) | Weigh-ins with the latest weight, the goal line, and deltas vs goal. |
| `gym_estimate_1rm` | `exercise_id?, formula?` (`epley`\|`brzycki`\|`lombardi`) | All-time best 1RM + trend for one exercise, or a PR table across all exercises if `exercise_id` is omitted. |
| `gym_muscle_balance` | `period` (`week`\|`month`\|`all`, required) | Muscles trained in the period, ranked, naming the ones neglected. |

SiYuan Note (RAG-style knowledge base, scoped to one dedicated notebook named
`SIYUAN_NOTEBOOK_NAME`, default "RAG" — never the user's other notebooks):

| Tool | Args | Effect |
|---|---|---|
| `list_notes` | – | Every note in the RAG notebook, including nested ones: `{docId,title,path}[]`. Read-only. |
| `hybrid_search_notes` | `query, limit?` | Default search: fuses `search_notes` (full-text) and `semantic_search_notes` (embedding) results via reciprocal rank fusion, so an exact term and a paraphrased/conceptual match both surface. Returns `{docId,title,path?,heading?,snippet?,score}[]`. |
| `search_notes` | `query, limit?` | Pure full-text search over the RAG notebook only, deduped to one result per note. Returns `{id,docId,title,path,snippet}[]`. |
| `semantic_search_notes` | `query, limit?` | Pure meaning-based (embedding) search via a local model — finds conceptually related notes with no shared keywords, and matches across German/English. Weak matches (cosine similarity below a floor, `EMBEDDINGS_MIN_SCORE`) are dropped. Returns `{docId,title,score}[]`. |
| `get_note` | `docId` | Full markdown content of one note. Rejects ids outside the RAG notebook. |
| `create_note` | `title, markdown?, parentDocId?` | Create a note in the RAG notebook. Rejects if the exact title already exists. `parentDocId` nests it under an existing note; omit for the notebook root. Returns `{docId}`. |
| `update_note` | `docId, markdown, title?, mode?` | `mode:"replace"` (default) overwrites the whole body; `mode:"append"` adds to the end instead. Optional `title` also renames it. Rejects ids outside the RAG notebook. |
| `move_note` | `docId, parentDocId?` | Move/reparent a note under another existing note; omit `parentDocId` to move it to the notebook root. Rejects ids outside the RAG notebook. |
| `get_note_attrs` | `docId` | Get a note's built-in metadata plus any `custom-*` key/value tags. Read-only. Rejects ids outside the RAG notebook. |
| `set_note_attrs` | `docId, attrs` | Set custom key/value tags on a note; keys auto-prefixed `custom-`. Rejects ids outside the RAG notebook. |
| `delete_note` | `docId` | Delete a note. Rejects ids outside the RAG notebook. |

**Write safety:** always confirm the exact arguments with the user before calling
any write tool (`create_*`, `complete_*`, `rename_*`, `update_*`, `move_*`, `delete_*`).
`create_meeting` with attendees emails real people.

## Running

The `mcp` service comes up with the rest of the stack:

```bash
docker compose up -d --build
```

Rebuild just this service after editing `mcp/server.js`:

```bash
docker compose up -d --build mcp
```

Env (set in `docker-compose.yml`): `PROXY_URL`, `API_TOKEN`, `PORT` (3001),
`TZ`. The Strava and Garmin tools just call ics-proxy's `/strava/*` and
`/garmin/*` routes, so those credentials live on `ics-proxy`, not here.

## Registering in Claude Code

Already registered at project scope in `.mcp.json`:

```json
{
  "mcpServers": {
    "glance": {
      "type": "http",
      "url": "http://localhost:8088/mcp",
      "headers": { "X-Api-Token": "<API_TOKEN>" }
    }
  }
}
```

A new Claude Code session picks it up after you approve the project MCP server.
Re-add with:

```bash
claude mcp add --transport http --scope project glance http://localhost:8088/mcp \
  --header "X-Api-Token: $(grep '^API_TOKEN=' .env | cut -d= -f2- | tr -d '"'\'')"
```

## Remote (dash.example.com)

The MCP server is also deployed on the PVE box and reachable at
`https://dash.example.com/mcp` (live, token-gated, SSE passes through the fronting
proxy without extra config). Use this to drive the assistant from any directory
or network, no local stack needed.

Registered user-scoped (stored in `~/.claude.json`, not the repo) as
`glance-remote`:

```bash
claude mcp add --transport http --scope user glance-remote https://dash.example.com/mcp \
  --header "X-Api-Token: $(grep '^API_TOKEN=' .env | cut -d= -f2- | tr -d '"'\'')"
```

So there are two entries:

| Name | URL | Scope | When to use |
|---|---|---|---|
| `glance` | `http://localhost:8088/mcp` | project (`.mcp.json`) | local stack is running |
| `glance-remote` | `https://dash.example.com/mcp` | user (`~/.claude.json`) | anywhere, anytime |

To redeploy the remote after changing the server: on the PVE box,
`git pull origin main && docker compose up -d --build`, then
`docker compose up -d --force-recreate nginx` so nginx re-renders the `/mcp`
route.

## Claude Desktop (via mcp-remote)

```json
{
  "mcpServers": {
    "glance": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://localhost:8088/mcp",
               "--header", "X-Api-Token:${API_TOKEN}"],
      "env": { "API_TOKEN": "<API_TOKEN>" }
    }
  }
}
```

## Smoke test

```bash
TOKEN=$(grep '^API_TOKEN=' .env | cut -d= -f2- | tr -d '"'\'')
B=http://localhost:8088/mcp
H=(-s -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -H "X-Api-Token: $TOKEN")

# list tools
curl "${H[@]}" -X POST -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' "$B"

# call a read tool
curl "${H[@]}" -X POST \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_tasks","arguments":{"list":"work"}}}' "$B"
```

Responses come back as SSE (`event: message` / `data: {...}`).

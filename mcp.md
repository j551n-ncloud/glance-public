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
| `get_weather` | `date?` | Open-Meteo forecast for the user's location (Berlin default). Read-only. |
| `get_status` | – | Backend status: cache ages, last Strava sync, digest crons, last Health ingest, configured backends. Read-only. |

Strava (read-only; require `STRAVA_*` configured, see README "Strava setup"):

| Tool | Args | Effect |
|---|---|---|
| `list_strava_activities` | `perPage?, page?, before?, after?` | Recent activities (newest first), metric units, with a Berlin-formatted `when`. |
| `get_strava_athlete` | – | Athlete profile incl. bikes and shoes. |
| `get_strava_zones` | – | Heart rate and power zones (and FTP). |
| `get_strava_gear` | `id?` | Bikes and shoes; with `id`, full detail for one item. |
| `get_strava_activity` | `id` | Detailed performance for one activity: HR/watts, calories, laps, segment/best efforts, PRs. |
| `get_strava_streams` | `id, keys?, resolution?` | Time-series streams for one activity. |
| `get_strava_clubs` | `clubId?` | Clubs the athlete belongs to; with `clubId`, that club's upcoming events. |
| `get_strava_ytd` | – | Year-to-date totals per sport (Run/Ride/Swim) + goal progress. |
| `get_strava_load` | – | Training load (acute:chronic workload ratio) with status. |
| `get_readiness` | – | Readiness signal: hard/easy/rest recommendation from ACWR + resting HR/HRV/sleep + days since last activity. |
| `get_load_vs_training` | `weeks?` | Per-week work-meeting hours vs training km/effort (last N weeks). |
| `get_strava_series` | `metric, granularity?, from?, to?` | DB-backed time series (hr/effort/distance) by day/week/month or custom range. |

Training plans and eligibility (present in Strava's own MCP) are not exposed:
the public Strava API does not provide them.

**Write safety:** always confirm the exact arguments with the user before calling
any write tool (`create_*`, `complete_*`, `rename_*`). `create_meeting` with
attendees emails real people.

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
`TZ`. The Strava tools just call ics-proxy's `/strava/*` routes, so the Strava
credentials live on `ics-proxy`, not here.

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

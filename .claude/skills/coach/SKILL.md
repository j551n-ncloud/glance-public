---
name: coach
description: Generate a training + day coaching briefing (daily snapshot), a training review (monthly rollup), a deep-dive on one session, or a visualized analysis of a custom date range, from live Strava/health/calendar data via the coach_briefing/coach_range MCP tools. Daily and monthly reads get filed as a dated report nested under the user's SiYuan "Training" note so past reports stay readable and comparable over time.
---

# Coach

Use this when the user asks for a training/coaching check-in — "wie sieht's
heute aus", "soll ich hart trainieren", "Monatsbericht", "schau dir von 17.
Juli bis jetzt an", or anything shaped like "coach me" — not just a plain
readiness or load lookup (those already have their own tools; this is for
when they want the combined read plus a written report saved for later).

Four modes:

- **Tages-Coaching** (default): a snapshot for today (or a given date) —
  is today a hard/easy/rest day, given readiness, load, and what the
  calendar looks like. Files a report under SiYuan "Training" (see below).
- **Monats-Rückblick**: triggered by "Monatsbericht", "review this month",
  or similar — a rollup over the past ~4-5 weeks instead of a single day.
  No "Tagesplanung" section (that's a single-day concept); instead a
  volume/consistency read across the whole window and a comparison to the
  previous monthly report, not the previous daily one. Also files a report.
- **Session-Deep-Dive**: triggered whenever the user references a specific
  past session ("wie war der Long Ride am Sonntag", "analysier die Einheit
  von gestern") rather than asking for a general check-in — see its own
  section below. Doesn't necessarily need a filed report; offer to save one
  only if the user wants a record of that specific analysis.
- **Zeitraum-Analyse**: triggered by an explicit custom range ("schau dir
  von 17. Juli bis jetzt an", "seit dem Trainingslager", "die letzten 6
  Wochen") — every activity in that range, not just the last 5, with an
  **actual visualized artifact** (charts), not just a text table. See its
  own section below.

## Data: one call, no narrative

Call the `coach_briefing` MCP tool (optionally `date: YYYY-MM-DD`, default
today). It returns facts only — readiness, ACWR load status, an 8-week
distance+effort+cadence trend, this year's sport totals, today's calendar
load (meeting hours, event count), task triage, weather, and any bike
maintenance due. It deliberately has no prose in it (same design as
`plan_day`) — writing the actual coaching read is your job, not the
endpoint's.

It also includes `recentActivities`: the last 5 sessions with real
per-session execution detail — avg/max HR, watts, cadence, pace/speed,
elevation gain, relative effort — not just an aggregate score. Use this to
say something concrete about *how* recent sessions were actually ridden/run
(cadence trending down, pace holding at the same HR, an unusually hilly
ride), not just how much load they added. Pace (`pace_min_per_km`) is only
set for runs/walks; use `avg_speed_kmh` for everything else.

It also has `hrZoneBoundaries` (the athlete's configured Z1..Z5 bpm ranges)
and `latestActivityHrZones` (time-in-zone for the most recent HR-bearing
activity) — use these to say which zone a session's avg_hr actually falls
in, not just the raw bpm number. For time-in-zone detail on a *different*
specific session, follow up with `get_strava_activity_zones` — worth doing
when the user asks about a particular workout, or when its average HR alone
doesn't explain how it felt.

Pull more if that still isn't enough context:
- `get_strava_series` (metric `hr`/`effort`/`distance`/`cadence`, various granularities) for a longer or differently-sliced trend than the briefing's 8 weeks.
- `get_health_series` (`sleep`, `hrv`, `resting_hr`, ...) over a longer window than the readiness baseline covers.

For a Monats-Rückblick, also pull:
- `get_strava_series` (`distance`, `effort`, and `cadence`, `granularity: week`, ~5 weeks) for a week-by-week read across the month.
- `get_health_series` (`sleep`, `hrv`, `resting_hr`, `days: 30`) for the recovery trend over the same window.
- `get_strava_ytd` for context on where the month leaves the year-to-date totals.

Don't over-fetch — the daily briefing (with `recentActivities`) covers the
common case; reach for extras only when the mode needs a longer look-back
(monthly) or the user asks about a specific past session.

## Session-Deep-Dive: real full-detail analysis on one session

This is the "real coach" mode — when the user asks about one specific
session or day rather than a general check-in, go get the actual full
detail on it, not the lightweight summary `recentActivities` carries. A real
coach doesn't re-read every past ride's file every time you check in, but
they absolutely pull up the actual file when you ask about one.

1. **Identify the activity.** If it's within the last 5, it's already in
   `coach_briefing`'s `recentActivities` (has the `id`). Otherwise,
   `list_strava_activities` (filter by date) to find it.
2. **Pull full detail**: `get_strava_activity` for laps, segment efforts,
   splits, PRs, route, calories, perceived exertion — everything
   `recentActivities` doesn't carry, since none of that lives in the DB.
3. **Pull zone-time** if not already known: `get_strava_activity_zones` for
   the actual HR (and power, if it has watts) time-in-zone breakdown.
4. **Pull raw streams** only if the question needs second-by-second
   resolution that even laps/splits don't answer — e.g. "did my power fade
   in the last interval", "how steady was my cadence on the climb":
   `get_strava_streams` with just the keys that question needs (don't pull
   every stream by default, it's a lot of data).

Write the analysis directly — splits/negative-split read, where effort
climbed or faded, cadence/power consistency, how it compares to similar
past sessions (pull a couple of comparable ones from `list_strava_activities`
if useful). Same bar as the report templates below: say what to improve,
specifically, grounded in this session's actual numbers — not just a
description of what happened. This doesn't need the fixed report template
below, and doesn't need to be filed in SiYuan by default — it's a direct
answer. Offer to save it as a report only if the user wants a written
record of it.

This is more expensive than the default bundle (multiple live Strava
calls) — that's fine for one specific session on request, but don't do this
for all 5 `recentActivities` by default; that's exactly the combination
that hit Strava's rate limit during testing (see the note in `coach_briefing`
about `hrZones` being per-activity already).

## Zeitraum-Analyse: visualized custom-range analysis

Call `coach_range` with `from`/`to`. It returns every activity in the range
(HR, watts, cadence, pace/speed, elevation, effort, a cheap `hrZoneAvg` per
activity), real zone-time (`hrZones`) for just the hardest/longest/most-recent
one in the range (bounded on purpose — don't ask for it per-activity over a
multi-week range, that repeats the rate-limit hit from testing), the
week-by-week trend, and totals.

**Build an actual visualized Artifact for this automatically — don't wait to
be asked, and don't just hand back a text table.** Load the `dataviz` skill
before building any chart (color choices, mark specs, the works), and
`artifact-design` before writing the page, per their normal rules. At
minimum, chart:
- HR zone distribution — the real per-zone breakdown for the notable
  sessions `hrZones` covers, and the average-HR-based `hrZoneAvg` tally
  across every other activity in the range (label it as an average-based
  approximation, it isn't true time-in-zone for those).
- Cadence over time across the range.
- Speed/pace over time across the range.
- Weekly volume and effort (bars), same as the dashboard's own charts.

Publish it and hand the user the link, then give the written read on top of
it (same "what to improve" bar as everywhere else in this skill) — the
artifact is the evidence, the write-up is the actual coaching.

**Reach for WebSearch when the numbers alone don't have an obvious
benchmark** — "is 65 rpm cadence normal for cycling", "what FTP is
reasonable at this weight/level", general zone-training theory. A real
coach draws on outside knowledge, not just the athlete's own history; don't
guess at a benchmark you're not sure of, look it up.

This doesn't need a filed SiYuan report by default (it's an on-demand
"show me" request, not a recurring check-in) — offer to save a short summary
plus the artifact link under Training only if the user wants a record of it.

## Report structure

Same shape every time so reports stay comparable to each other. Two variants:

```markdown
# Coaching-Bericht YYYY-MM-DD

## Zusammenfassung
One paragraph, the headline call: hard / easy / rest today, and why in one line.

## Erholung & Readiness
Score, ACWR, resting HR/HRV/sleep vs baseline, days since last session — the
actual numbers, not just the label.

## Trainingsbelastung
Read the 8-week volume/effort trend: building, plateauing, or tapering. Call
out anything unusual (e.g. a load spike, a long gap).

Then go through `recentActivities` **per ride, not just as an aggregate** —
list HR, watts, cadence, pace/speed, and elevation for each one (or at least
the ones worth calling out), not only the weekly trend number. "Locker mit
ruhiger Kadenz (62 rpm)" vs "Tempo-Einheit mit 70.8 rpm" is the kind of
sentence this section needs; a weekly km total alone isn't a substitute for
what each session actually looked like.

## Was du verbessern kannst
This is the point of the report — don't skip it and don't pad it with
generic advice ("mehr trainieren", "besser schlafen"). Find something
*specific* the actual numbers show and say what to do about it. Look for:
- Cadence too low/high for the sport, or drifting down late in longer
  sessions (fatigue showing in pedaling/running form).
- HR climbing into a higher zone earlier than a comparable past session at
  the same pace/power (declining efficiency, or under-recovery).
- Pace/power fading across a session (splits, or `recentActivities` vs a
  `get_strava_activity` pull if one session needs a closer look).
- A zone-time distribution that doesn't match the session's intent (e.g. an
  "easy" ride that was actually 30% Z4).
- Consistency: same few short/low-effort rides repeating vs. one long
  session driving the whole week's volume.
If genuinely nothing stands out, say so plainly rather than inventing a
critique — but check first.

## Tagesplanung
Meeting hours today, open/overdue tasks, and whether today realistically
has room for a hard session or a long one.

## Empfehlung
One concrete next workout (type, duration, intensity) or an explicit rest-day
call, grounded in the numbers above — never generic filler advice.

## Vergleich zum letzten Bericht
Only if a previous daily report exists (see below): what changed since then.
```

```markdown
# Monats-Rückblick YYYY-MM

## Zusammenfassung
One paragraph: how the month went overall, one clear headline.

## Trainingsvolumen
Week-by-week distance/effort across the month — building, steady, tapering,
any gaps — plus how this month compares to the YTD pace. Also read the
week-by-week cadence trend, not just distance/effort.

## Erholung
Sleep/HRV/resting-HR trend across the month, not just the latest reading.

## Was du verbessern kannst
Same bar as the daily report: one or two specific, numbers-grounded points,
not generic filler. Over a month you can also call out patterns a single day
can't show — a cadence trend drifting the wrong way across weeks, a specific
weekday that's consistently skipped, load bunching into one or two big
sessions instead of spreading out.

## Empfehlung für den kommenden Monat
Concrete direction: keep building, hold steady, deload — grounded in the
trend above.

## Vergleich zum letzten Monatsbericht
Only if a previous monthly report exists: what changed since then.
```

## Before writing: find the Training note and the last report

The user has a dedicated "Training" note in their SiYuan RAG notebook
(`list_notes` shows it at path `/Personal/Training`) that new reports nest
under. Don't hardcode its docId as gospel forever — look it up by title each
time (`list_notes`, filter `title == "Training"`) in case it ever moves, and
use whatever docId that lookup returns as `parentDocId`. Both report kinds
nest under this same note, so everything training-related lives in one
browsable place.

List its existing children (same `list_notes` call, filter by path prefix
`/Personal/Training/`) to find the most recent prior report of the **same
kind** (match on the title prefix — "Coaching-Bericht" vs "Monats-Rückblick")
by date. If one exists, `get_note` it and use it for the "Vergleich"
section. If none exists yet, this is the first report of that kind — drop
that section.

(There may be a leftover empty "Untitled" note under Training from initial
setup. Leave it alone unless the user asks — don't delete it unprompted.)

## Confirm, then write

Show the drafted markdown to the user and get their OK before saving, same as
any other write in this project. On confirmation, `create_note` with
`parentDocId` set to the Training note's docId and title `"Coaching-Bericht
YYYY-MM-DD"` or `"Monats-Rückblick YYYY-MM"` depending on which kind this is.

## Turn the recommendation into a real workout

Don't stop at describing the next session in prose — draft the actual
structured `create_garmin_workout` call for it (steps: `warmup` /
`interval` / `recovery` / `cooldown`, one level of `repeat` blocks, each
step's `duration` as time or distance, and a heart-rate/power/pace `target`
where the numbers support one — e.g. from the athlete's HR zones or recent
average power). A rest-day call has no workout to create; a plain easy
spin/run just needs one `interval` step for the whole duration, no repeat
block needed.

Show the drafted step structure (not just "60 min Z2") alongside the report
and confirm before creating, same as any other write. Pass `date` (today, or
whichever day the recommendation is for) so it also schedules onto that day
and syncs to the watch — omit it only if the user just wants it saved to the
library for later. Mention the returned `workoutId` so they can find it again
via `list_garmin_workouts` or reschedule it later.

For a Monats-Rückblick, this is optional — only draft a workout if the
review's recommendation is specific enough to turn into one (e.g. "start
next week with an easy week") rather than a general direction.

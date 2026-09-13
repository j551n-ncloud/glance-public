// Garmin Connect: push structured training-session workouts so they sync to
// the user's watch/head unit. Garmin has no public personal-use API, so this
// drives the same unofficial login flow the mobile app uses, via the
// `garmin-connect` npm package (MIT, github.com/Pythe1337N/garmin-connect) --
// reimplementing Garmin's undocumented SSO/OAuth1 handshake (HTML scraping
// for a CSRF token and a login ticket, then a hand-rolled OAuth1 exchange)
// ourselves would be fragile and hard to verify without a live account to
// iterate against. Everything past login -- the workout JSON shape, the
// endpoints, the MCP tool -- is ours; see buildWorkoutPayload below. This
// replaces the old separate garmin-mcp service + bridge (removed entirely,
// see git history): no second container, no bridge, just a lib module like
// deck.js/bikeMaintenance.js.
//
// This account has no MFA, so plain username/password login works; the
// library has no MFA support at all (a `// TODO: Handle MFA` in its source),
// so if MFA is ever turned on here, login breaks and needs a different
// bootstrap (e.g. minting tokens once via Python's `garth`, which does
// handle MFA, then loading them here via loadToken). Session tokens are
// cached to GARMIN_TOKENS_FILE on the persistent volume so a restart doesn't
// need a fresh login every time (Garmin's login endpoint is easy to trip
// rate limits on if hit repeatedly).
const fs = require('fs');
const { GarminConnect } = require('garmin-connect');
const cfg = require('./config');

function configured() {
  return !!(cfg.GARMIN_EMAIL && cfg.GARMIN_PASSWORD);
}

// --- Session management ------------------------------------------------------

let client = null;
let loginPromise = null;

function readTokens() {
  try { return JSON.parse(fs.readFileSync(cfg.GARMIN_TOKENS_FILE, 'utf8')); }
  catch { return null; }
}

function writeTokens(oauth1, oauth2) {
  try { fs.writeFileSync(cfg.GARMIN_TOKENS_FILE, JSON.stringify({ oauth1, oauth2 })); }
  catch (e) { console.error('garmin: failed to persist tokens:', e.message); }
}

async function freshLogin(gc) {
  await gc.login(cfg.GARMIN_EMAIL, cfg.GARMIN_PASSWORD);
  const { oauth1, oauth2 } = gc.exportToken();
  writeTokens(oauth1, oauth2);
}

async function getClient() {
  if (!configured()) throw new Error('Garmin not configured (set GARMIN_EMAIL/GARMIN_PASSWORD)');
  if (client) return client;
  if (!loginPromise) {
    loginPromise = (async () => {
      const gc = new GarminConnect({ username: cfg.GARMIN_EMAIL, password: cfg.GARMIN_PASSWORD });
      const saved = readTokens();
      if (saved?.oauth1 && saved?.oauth2) {
        gc.loadToken(saved.oauth1, saved.oauth2);
        // Cheap call to confirm the loaded session still works before trusting
        // it for the real request; a dead/expired session falls back to login.
        try { await gc.getUserSettings(); }
        catch { await freshLogin(gc); }
      } else {
        await freshLogin(gc);
      }
      client = gc;
      return gc;
    })().catch((e) => { loginPromise = null; throw e; });
  }
  return loginPromise;
}

// The library's HTTP layer swallows the original axios error and rethrows a
// plain Error with the status folded into the message (see its
// handleHttpError), so there's no `.response.status` to check -- match the
// message instead.
function looksLikeAuthError(e) {
  return /ERROR: \((401|403)\)/.test(e?.message || '');
}

// Runs one Garmin call against the current session; on an auth failure
// (session died server-side, e.g. revoked or outlasted its lifetime) forces
// one fresh login and retries once rather than surfacing a fixable error.
async function withSession(fn) {
  const gc = await getClient();
  try {
    return await fn(gc);
  } catch (e) {
    if (!looksLikeAuthError(e)) throw e;
    client = null;
    loginPromise = null;
    return fn(await getClient());
  }
}

// --- Workout JSON builder ----------------------------------------------------
// Garmin's workout schema and the numeric ids below (sportType, stepType,
// endCondition, targetType) are undocumented but stable API constants,
// cross-checked against a live-verified reference (taxuspt/garmin_mcp's
// workout_templates.py). Kept intentionally narrower than what Garmin
// supports: time/distance steps with heart-rate, power (cycling) or pace
// (running) targets covers the training-session case this exists for.

const SPORT_TYPES = {
  running: { sportTypeId: 1, sportTypeKey: 'running' },
  cycling: { sportTypeId: 2, sportTypeKey: 'cycling' },
  walking: { sportTypeId: 12, sportTypeKey: 'walking' },
};

const STEP_TYPES = {
  warmup: { stepTypeId: 1, stepTypeKey: 'warmup' },
  cooldown: { stepTypeId: 2, stepTypeKey: 'cooldown' },
  interval: { stepTypeId: 3, stepTypeKey: 'interval' }, // the "work" portion of a step
  recovery: { stepTypeId: 4, stepTypeKey: 'recovery' },
  rest: { stepTypeId: 5, stepTypeKey: 'rest' },
  other: { stepTypeId: 7, stepTypeKey: 'other' },
};

const NO_TARGET = { workoutTargetTypeId: 1, workoutTargetTypeKey: 'no.target' };

// "mm:ss" per km -> meters/second. Garmin stores pace targets as speed
// internally even though the key is "pace.zone".
function paceToSpeed(pace) {
  const m = /^(\d+):([0-5]\d)$/.exec(String(pace).trim());
  if (!m) throw new Error(`pace must be "mm:ss" per km, got: ${JSON.stringify(pace)}`);
  const seconds = Number(m[1]) * 60 + Number(m[2]);
  return 1000 / seconds;
}

function buildTarget(sport, target) {
  if (!target || target.type === 'none') return NO_TARGET;
  switch (target.type) {
    case 'heart_rate': {
      const base = { workoutTargetTypeId: 4, workoutTargetTypeKey: 'heart.rate.zone' };
      if (target.zone) return { ...base, zoneNumber: target.zone };
      if (target.low != null && target.high != null) {
        return { ...base, targetValueOne: target.low, targetValueTwo: target.high };
      }
      throw new Error('heart_rate target needs either zone, or low/high bpm');
    }
    case 'power': {
      if (sport !== 'cycling') throw new Error('power targets are only supported for sport: "cycling"');
      if (target.zone) return { workoutTargetTypeId: 2, workoutTargetTypeKey: 'power.zone', zoneNumber: target.zone };
      if (target.low != null && target.high != null) {
        // Deliberately NOT workoutTargetTypeId 2 for an absolute watt range:
        // Garmin silently reinterprets that combination as a power zone and
        // the intended watt range is lost. Id 6 + key "power.between" is the
        // verified way to set an absolute watt range.
        return { workoutTargetTypeId: 6, workoutTargetTypeKey: 'power.between', targetValueOne: target.low, targetValueTwo: target.high };
      }
      throw new Error('power target needs either zone, or low/high watts');
    }
    case 'pace': {
      if (sport === 'cycling') throw new Error('pace targets are not supported for sport: "cycling" (use power instead)');
      const base = { workoutTargetTypeId: 6, workoutTargetTypeKey: 'pace.zone' };
      if (target.zone) return { ...base, zoneNumber: target.zone };
      if (target.low && target.high) {
        const speeds = [paceToSpeed(target.low), paceToSpeed(target.high)].sort((a, b) => a - b);
        return { ...base, targetValueOne: speeds[0], targetValueTwo: speeds[1] };
      }
      throw new Error('pace target needs either zone, or low/high pace ("mm:ss" per km)');
    }
    default:
      throw new Error(`unsupported target type: ${target.type}`);
  }
}

function buildDuration(duration) {
  if (!duration) throw new Error('step duration required');
  if (duration.type === 'time') {
    if (!(duration.seconds > 0)) throw new Error('time duration needs seconds > 0');
    return { endCondition: { conditionTypeId: 2, conditionTypeKey: 'time' }, endConditionValue: duration.seconds };
  }
  if (duration.type === 'distance') {
    if (!(duration.meters > 0)) throw new Error('distance duration needs meters > 0');
    return { endCondition: { conditionTypeId: 3, conditionTypeKey: 'distance' }, endConditionValue: duration.meters };
  }
  throw new Error(`unsupported duration type: ${duration.type} (use "time" or "distance")`);
}

// A step is either a single leg (type/duration/target) or a repeat block
// ({repeat: N, steps: [...]}, one level deep -- matches what Garmin's
// RepeatGroupDTO itself supports, and covers the common warmup + N x (work +
// recovery) + cooldown shape).
function buildStep(sport, step, order) {
  if (step.repeat) {
    if (!(step.repeat > 0) || !Array.isArray(step.steps) || !step.steps.length) {
      throw new Error('repeat step needs repeat (>0) and a non-empty steps array');
    }
    return {
      type: 'RepeatGroupDTO',
      stepOrder: order,
      numberOfIterations: step.repeat,
      workoutSteps: step.steps.map((s, i) => buildStep(sport, s, i + 1)),
    };
  }
  const stepType = STEP_TYPES[step.type || 'interval'];
  if (!stepType) throw new Error(`unsupported step type: ${step.type} (use one of ${Object.keys(STEP_TYPES).join(', ')})`);
  return {
    type: 'ExecutableStepDTO',
    stepOrder: order,
    stepType,
    description: step.description || null,
    targetType: buildTarget(sport, step.target),
    ...buildDuration(step.duration),
  };
}

function buildWorkoutPayload({ name, description, sport = 'cycling', steps }) {
  if (!name) throw new Error('name required');
  if (!Array.isArray(steps) || !steps.length) throw new Error('steps (non-empty array) required');
  const sportType = SPORT_TYPES[sport];
  if (!sportType) throw new Error(`unsupported sport: ${sport} (use one of ${Object.keys(SPORT_TYPES).join(', ')})`);
  return {
    workoutName: name,
    description: description || undefined,
    sportType,
    workoutSegments: [{
      segmentOrder: 1,
      sportType,
      workoutSteps: steps.map((s, i) => buildStep(sport, s, i + 1)),
    }],
  };
}

// --- Garmin calls -------------------------------------------------------------

// Not exposed by the garmin-connect library as a named method, but its
// GarminConnect instance exposes a generic authenticated `.client.post`, so
// the raw endpoint (verified against taxuspt/garmin_mcp's schedule_workout)
// works the same way any of the library's own wrapper methods would.
const scheduleUrl = (workoutId) => `https://connectapi.garmin.com/workout-service/schedule/${workoutId}`;

async function scheduleWorkout(workoutId, date) {
  if (!workoutId) throw new Error('workoutId required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('date must be YYYY-MM-DD');
  await withSession((gc) => gc.client.post(scheduleUrl(workoutId), { date }));
  return { workoutId, date };
}

async function createWorkout({ name, description, sport, steps, date }) {
  const payload = buildWorkoutPayload({ name, description, sport, steps });
  const created = await withSession((gc) => gc.addWorkout(payload));
  const result = { workoutId: created.workoutId, name: created.workoutName };
  if (date) {
    await scheduleWorkout(created.workoutId, date);
    result.scheduledDate = date;
  }
  return result;
}

async function listWorkouts(limit = 20) {
  const workouts = await withSession((gc) => gc.getWorkouts(0, limit));
  return (workouts || []).map((w) => ({
    workoutId: w.workoutId,
    name: w.workoutName,
    sport: w.sportType?.sportTypeKey,
    updated: w.updatedDate,
  }));
}

async function deleteWorkout(workoutId) {
  if (!workoutId) throw new Error('workoutId required');
  await withSession((gc) => gc.deleteWorkout({ workoutId }));
  return { deleted: true, workoutId };
}

// --- Routes -------------------------------------------------------------------

function register(app) {
  app.get('/garmin/workouts', async (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
      res.json({ workouts: await listWorkouts(limit) });
    } catch (e) {
      console.error('garmin list workouts failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/garmin/workout', async (req, res) => {
    try {
      res.json({ ok: true, ...(await createWorkout(req.body || {})) });
    } catch (e) {
      console.error('garmin create workout failed:', e.message);
      res.status(400).json({ error: e.message });
    }
  });

  app.post('/garmin/schedule-workout', async (req, res) => {
    try {
      const { workoutId, date } = req.body || {};
      res.json({ ok: true, ...(await scheduleWorkout(workoutId, date)) });
    } catch (e) {
      console.error('garmin schedule workout failed:', e.message);
      res.status(400).json({ error: e.message });
    }
  });

  app.post('/garmin/delete-workout', async (req, res) => {
    try {
      const { workoutId } = req.body || {};
      res.json(await deleteWorkout(workoutId));
    } catch (e) {
      console.error('garmin delete workout failed:', e.message);
      res.status(400).json({ error: e.message });
    }
  });
}

module.exports = {
  configured, register,
  createWorkout, listWorkouts, deleteWorkout, scheduleWorkout,
  buildWorkoutPayload, // exported for the smoke test
};

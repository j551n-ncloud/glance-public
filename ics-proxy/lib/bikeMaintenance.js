// Bike maintenance tracking, modeled on Canyon's own app: a handful of
// recurring items (tires, drivetrain, brakes, bolt torque, annual service),
// each tracked either by cumulative km ridden or by elapsed days since it
// was last done. There's no "service history" API to pull this from — the
// user resets an item's counter when they've actually done it, and progress
// since that point is computed from the bike's live Strava odometer (km
// items) or the reset date (day items). Persisted via lib/settings.js under
// the 'bikeMaintenance' key, scoped to a single bike (DEFAULT_BIKE_ID).
const { readSettings, writeSettings } = require('./settings');

const DEFAULT_BIKE_ID = 'b18291555';

// Thresholds and starting progress mirror the Canyon app's actual state at
// the time this was built (89/100km tires, 210/300km drivetrain, 210/1000km
// brakes, 16/180 days bolts, 16/365 days annual service) so day one shows
// the same numbers already familiar from that app instead of resetting
// everything to 0/full.
function defaultItems(currentKm) {
  const now = new Date().toISOString();
  const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();
  return [
    { id: 'tires', label: 'Reifen prüfen und aufpumpen', category: 'Laufräder', intervalKm: 100, resetAtKm: currentKm - 89, resetAt: now },
    { id: 'drivetrain', label: 'Reinige und schmiere deinen Antrieb', category: 'Antrieb', intervalKm: 300, resetAtKm: currentKm - 210, resetAt: now },
    { id: 'brakes', label: 'Überprüfe deine Bremsbeläge', category: 'Bremsen', intervalKm: 1000, resetAtKm: currentKm - 210, resetAt: now },
    { id: 'bolts', label: 'Checke & ziehe deine Schrauben mit dem richtigen Drehmoment an', category: 'Rahmen', intervalDays: 180, resetAt: daysAgo(16) },
    { id: 'annual', label: 'Jährliche Inspektion & Service', category: 'Rahmen', intervalDays: 365, resetAt: daysAgo(16) },
  ];
}

// Color travels with the status so the dashboard widget template can just
// render a field rather than re-implement this threshold logic in Go
// templating (same convention as the HR-zone widget it replaces).
function statusFor(ratio) {
  if (ratio >= 1) return { status: 'Überfällig', color: '#dc2626' };
  if (ratio >= 0.8) return { status: 'Bald prüfen', color: '#f59e0b' };
  return { status: 'Bereit zum Fahren', color: '#10b981' };
}

// `getGearDistanceKm(bikeId)` is injected from server.js so this module
// reuses the existing Strava gear cache instead of issuing its own API
// calls — Strava's app-wide rate limit is easy to exhaust (see the digest
// prewarm cron), so a second independent fetch path here is worth avoiding.
function build({ getGearDistanceKm, bikeId = DEFAULT_BIKE_ID }) {
  async function ensureItems() {
    const stored = readSettings().bikeMaintenance;
    if (stored && stored.items) return stored.items;
    const currentKm = await getGearDistanceKm(bikeId);
    const items = defaultItems(currentKm);
    writeSettings({ bikeMaintenance: { bikeId, items } });
    return items;
  }

  async function getStatus() {
    const [items, currentKm] = await Promise.all([ensureItems(), getGearDistanceKm(bikeId)]);
    const now = Date.now();
    return items.map((it) => {
      let progress, interval, unit;
      if (it.intervalKm) {
        progress = Math.max(0, currentKm - it.resetAtKm);
        interval = it.intervalKm;
        unit = 'km';
      } else {
        progress = Math.max(0, Math.floor((now - new Date(it.resetAt).getTime()) / 86400000));
        interval = it.intervalDays;
        unit = 'days';
      }
      const ratio = progress / interval;
      const { status, color } = statusFor(ratio);
      return {
        id: it.id,
        label: it.label,
        category: it.category,
        progress: Math.round(progress),
        interval,
        unit,
        status,
        color,
        pct: Math.min(100, Math.round(ratio * 100)),
      };
    });
  }

  async function resetItem(itemId) {
    const items = await ensureItems();
    const idx = items.findIndex((it) => it.id === itemId);
    if (idx === -1) throw new Error(`unknown maintenance item: ${itemId}`);
    const currentKm = await getGearDistanceKm(bikeId);
    const it = { ...items[idx] };
    if (it.intervalKm) it.resetAtKm = currentKm;
    else it.resetAt = new Date().toISOString();
    const updated = [...items];
    updated[idx] = it;
    writeSettings({ bikeMaintenance: { bikeId, items: updated } });
    return it;
  }

  function register(app) {
    app.get('/bike/maintenance', async (req, res) => {
      try {
        res.json({ items: await getStatus() });
      } catch (e) {
        console.error('bike maintenance status failed:', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    app.post('/bike/reset-maintenance-item', async (req, res) => {
      try {
        const { itemId } = req.body || {};
        if (!itemId) return res.status(400).json({ error: 'itemId required' });
        res.json({ ok: true, item: await resetItem(itemId) });
      } catch (e) {
        console.error('bike maintenance reset failed:', e.message);
        res.status(400).json({ error: e.message });
      }
    });
  }

  return { register, getStatus, resetItem };
}

module.exports = build;

// Weather feature: Open-Meteo forecast + geocoding + settable default location.
// No API key. Exposes helpers used by the calendar core (plan-day, digest) and
// registers the /weather routes. Factory takes berlinDay (shared with the core).
const {
  WEATHER_LAT, WEATHER_LON, WEATHER_PLACE, WEATHER_TZ, WEATHER_CACHE_TTL_MS,
} = require('./config');
const { readSettings, writeSettings } = require('./settings');

// WMO weather codes -> German label + emoji.
const WMO = {
  0: ['Klar', '☀️'], 1: ['Überwiegend klar', '🌤️'], 2: ['Teils bewölkt', '⛅'], 3: ['Bewölkt', '☁️'],
  45: ['Nebel', '🌫️'], 48: ['Reifnebel', '🌫️'],
  51: ['Leichter Niesel', '🌦️'], 53: ['Niesel', '🌦️'], 55: ['Starker Niesel', '🌦️'],
  56: ['Gefrierender Niesel', '🌧️'], 57: ['Gefrierender Niesel', '🌧️'],
  61: ['Leichter Regen', '🌧️'], 63: ['Regen', '🌧️'], 65: ['Starker Regen', '🌧️'],
  66: ['Gefrierender Regen', '🌧️'], 67: ['Gefrierender Regen', '🌧️'],
  71: ['Leichter Schnee', '🌨️'], 73: ['Schnee', '🌨️'], 75: ['Starker Schnee', '❄️'], 77: ['Schneegriesel', '🌨️'],
  80: ['Regenschauer', '🌦️'], 81: ['Regenschauer', '🌦️'], 82: ['Starke Schauer', '⛈️'],
  85: ['Schneeschauer', '🌨️'], 86: ['Schneeschauer', '🌨️'],
  95: ['Gewitter', '⛈️'], 96: ['Gewitter mit Hagel', '⛈️'], 99: ['Gewitter mit Hagel', '⛈️'],
};

module.exports = function createWeather({ berlinDay }) {
  // --- Geocoding: free-text place name -> { lat, lon, place, tz }. Cached. ---
  const geoCache = new Map(); // lowercased name -> { ts, loc }
  const GEO_CACHE_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days; places don't move
  async function geocodePlace(name) {
    const q = String(name || '').trim();
    if (!q) throw new Error('empty place name');
    const key = q.toLowerCase();
    const hit = geoCache.get(key);
    if (hit && Date.now() - hit.ts < GEO_CACHE_TTL_MS) return hit.loc;
    const url = 'https://geocoding-api.open-meteo.com/v1/search'
      + `?name=${encodeURIComponent(q)}&count=1&language=de&format=json`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Open-Meteo geocoding -> ${r.status}`);
    const j = await r.json();
    const m = j.results && j.results[0];
    if (!m) throw new Error(`no location found for "${q}"`);
    const label = [m.name, m.admin1, m.country].filter(Boolean).join(', ');
    const loc = { lat: String(m.latitude), lon: String(m.longitude), place: label, tz: m.timezone || WEATHER_TZ };
    geoCache.set(key, { ts: Date.now(), loc });
    return loc;
  }

  // Normalize an explicit-coordinate location into the shape fetchWeather expects
  // (string coords, a label falling back to "lat,lon", and a timezone).
  function coordLoc({ lat, lon, place, tz } = {}) {
    return { lat: String(lat), lon: String(lon), place: place || `${lat},${lon}`, tz: tz || WEATHER_TZ };
  }

  // Resolve the location for a weather request: explicit query > saved default >
  // env default. `q` is the parsed req.query.
  async function resolveLocation(q = {}) {
    if (q.place) return geocodePlace(q.place);
    if (q.lat && q.lon) return coordLoc({ lat: q.lat, lon: q.lon, place: q.name, tz: q.tz });
    const saved = readSettings().weatherLocation;
    if (saved && saved.lat && saved.lon) return coordLoc(saved);
    // Env fallback: explicit coords win; otherwise geocode WEATHER_PLACE by name.
    if (WEATHER_LAT && WEATHER_LON) return coordLoc({ lat: WEATHER_LAT, lon: WEATHER_LON, place: WEATHER_PLACE });
    try {
      return await geocodePlace(WEATHER_PLACE);
    } catch (e) {
      console.error(`geocoding WEATHER_PLACE "${WEATHER_PLACE}" failed, using Heidelberg:`, e.message);
      return coordLoc({ lat: '49.4094', lon: '8.6946', place: 'Heidelberg' });
    }
  }

  async function fetchWeather(day, loc) {
    const target = day || berlinDay(new Date());
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}`
      + `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,sunrise,sunset`
      + `&hourly=temperature_2m,precipitation_probability,weather_code`
      + `&timezone=${encodeURIComponent(loc.tz || WEATHER_TZ)}&forecast_days=7`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Open-Meteo -> ${r.status}`);
    const j = await r.json();
    const d = j.daily || {};
    const i = (d.time || []).indexOf(target);
    if (i < 0) throw new Error('day not in forecast window');
    const code = d.weather_code[i];
    const wm = WMO[code] || ['—', '❓'];
    // Compact hourly for the target day: every 3h from 06:00 to 21:00.
    const hourly = [];
    const ht = (j.hourly && j.hourly.time) || [];
    for (let k = 0; k < ht.length; k++) {
      if (!ht[k].startsWith(target)) continue;
      const hh = parseInt(ht[k].slice(11, 13), 10);
      if (hh < 6 || hh > 21 || hh % 3 !== 0) continue;
      hourly.push({
        time: ht[k].slice(11, 16),
        temp: Math.round(j.hourly.temperature_2m[k]),
        precipProb: j.hourly.precipitation_probability ? j.hourly.precipitation_probability[k] : null,
      });
    }
    return {
      date: target, place: loc.place, code, text: wm[0], emoji: wm[1],
      tempMax: Math.round(d.temperature_2m_max[i]), tempMin: Math.round(d.temperature_2m_min[i]),
      precip: +((d.precipitation_sum && d.precipitation_sum[i]) || 0).toFixed(1),
      precipProb: d.precipitation_probability_max ? d.precipitation_probability_max[i] : null,
      windMax: Math.round((d.wind_speed_10m_max && d.wind_speed_10m_max[i]) || 0),
      sunrise: d.sunrise ? d.sunrise[i].slice(11, 16) : null,
      sunset: d.sunset ? d.sunset[i].slice(11, 16) : null,
      hourly,
    };
  }

  const weatherCache = new Map(); // `${lat},${lon}|${day}` -> { ts, data }
  async function weatherCached(day, loc) {
    const target = day || berlinDay(new Date());
    const key = `${loc.lat},${loc.lon}|${target}`;
    const hit = weatherCache.get(key);
    if (hit && Date.now() - hit.ts < WEATHER_CACHE_TTL_MS) return hit.data;
    try {
      const data = await fetchWeather(target, loc);
      weatherCache.set(key, { ts: Date.now(), data });
      return data;
    } catch (e) {
      // Serve stale on failure: an expired forecast beats none (Open-Meteo
      // occasionally 503s, e.g. right when the digest cron fires).
      if (hit) {
        console.error(`weather fetch for ${target} failed (${e.message}), serving stale from ${new Date(hit.ts).toISOString()}`);
        return hit.data;
      }
      throw e;
    }
  }

  // Resolve the location (query > saved > env) then fetch the cached forecast.
  // Single entry point for both the /weather route and internal callers.
  async function weatherForRequest(day, q = {}) {
    const loc = await resolveLocation(q);
    return weatherCached(day, loc);
  }

  function register(app) {
    app.get('/weather', async (req, res) => {
      try {
        res.json(await weatherForRequest(req.query.date, req.query));
      } catch (e) {
        console.error('weather failed:', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    // Set (or clear) the persisted default weather location. Token-gated (POST).
    // Body: { place } to geocode + save, or { lat, lon, place?, tz? } for exact
    // coords, or { clear: true } to revert to the env/hard default.
    app.post('/weather/location', async (req, res) => {
      try {
        const b = req.body || {};
        if (b.clear) {
          writeSettings({ weatherLocation: null });
          return res.json({ ok: true, cleared: true, location: await resolveLocation({}) });
        }
        let loc;
        if (b.place && !(b.lat && b.lon)) {
          loc = await geocodePlace(b.place);
        } else if (b.lat && b.lon) {
          loc = coordLoc(b);
        } else {
          return res.status(400).json({ error: 'provide { place } or { lat, lon }' });
        }
        writeSettings({ weatherLocation: loc });
        res.json({ ok: true, location: loc });
      } catch (e) {
        console.error('set weather location failed:', e.message);
        res.status(400).json({ error: e.message });
      }
    });
  }

  // weatherForRequest is used by the digest and plan-day; cacheKeys backs /status.
  // weatherCached is exposed for callers that already have a resolved loc
  // (e.g. plan-cycling-training's start/destination) and want to skip a
  // redundant geocode.
  return {
    register, weatherForRequest, resolveLocation, geocodePlace, weatherCached,
    cacheKeys: () => [...weatherCache.keys()],
  };
};

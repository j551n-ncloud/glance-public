// Central config: every environment-derived constant for the proxy lives here
// so feature modules can import exactly what they need instead of closing over
// a giant shared scope. Pure value module, no side effects.

module.exports = {
  API_TOKEN: process.env.API_TOKEN,
  PORT: process.env.PORT || 3000,

  // Nextcloud ICS (read-only public share) + writable CalDAV collection.
  ICS_URL: process.env.ICS_URL,
  ICS_USER: process.env.ICS_USER,
  ICS_PASS: process.env.ICS_PASS,
  CAL_URL: process.env.CAL_URL,

  // Exchange EWS.
  EWS_URL: process.env.EWS_URL,
  EWS_USER: process.env.EWS_USER,
  EWS_PASS: process.env.EWS_PASS,
  EWS_DOMAIN: process.env.EWS_DOMAIN || '',

  // CalDAV task collections (auth falls back to the ICS creds).
  TASKS_HOME_URL: process.env.TASKS_HOME_URL,
  TASKS_WORK_URL: process.env.TASKS_WORK_URL,
  TASKS_USER: process.env.TASKS_USER || process.env.ICS_USER,
  TASKS_PASS: process.env.TASKS_PASS || process.env.ICS_PASS,

  CACHE_TTL_MS: parseInt(process.env.CACHE_TTL_MS || '60000', 10),
  LIMIT: parseInt(process.env.LIMIT || '10', 10),

  // Daily email digest (disabled unless DIGEST_ENABLED=true).
  DIGEST_ENABLED: process.env.DIGEST_ENABLED === 'true',
  DIGEST_TO: process.env.DIGEST_TO || '',
  DIGEST_CRON: process.env.DIGEST_CRON || '0 8 * * *',
  DIGEST_TZ: process.env.DIGEST_TZ || 'Europe/Berlin',
  DIGEST_PRIORITY: process.env.DIGEST_PRIORITY || 'high',

  // Weekly digest (Mondays by default).
  WEEKLY_ENABLED: process.env.WEEKLY_DIGEST_ENABLED === 'true',
  WEEKLY_TO: process.env.WEEKLY_DIGEST_TO || process.env.DIGEST_TO || '',
  WEEKLY_CRON: process.env.WEEKLY_DIGEST_CRON || '0 8 * * 1',
  SMTP_HOST: process.env.SMTP_HOST || '',
  SMTP_PORT: parseInt(process.env.SMTP_PORT || '465', 10),
  SMTP_SECURE: process.env.SMTP_SECURE !== 'false',
  SMTP_USER: process.env.SMTP_USER || '',
  SMTP_PASS: process.env.SMTP_PASS || '',
  SMTP_FROM: process.env.SMTP_FROM || process.env.SMTP_USER || '',

  // Strava (read-only OAuth refresh-token flow).
  STRAVA_CLIENT_ID: process.env.STRAVA_CLIENT_ID || '',
  STRAVA_CLIENT_SECRET: process.env.STRAVA_CLIENT_SECRET || '',
  STRAVA_REFRESH_TOKEN: process.env.STRAVA_REFRESH_TOKEN || '',
  STRAVA_API: 'https://www.strava.com/api/v3',
  STRAVA_CACHE_TTL_MS: parseInt(process.env.STRAVA_CACHE_TTL_MS || '600000', 10),
  STRAVA_GOAL_RUN_KM: parseFloat(process.env.STRAVA_GOAL_RUN_KM || '0'),
  STRAVA_GOAL_RIDE_KM: parseFloat(process.env.STRAVA_GOAL_RIDE_KM || '0'),
  STRAVA_GOAL_SWIM_KM: parseFloat(process.env.STRAVA_GOAL_SWIM_KM || '0'),
  STRAVA_DB: process.env.STRAVA_DB || '/data/strava.db',

  // Weather (Open-Meteo, no key). Location resolves: query > saved default >
  // WEATHER_* env > Berlin. If WEATHER_LAT/LON are set they win, else
  // WEATHER_PLACE is geocoded.
  WEATHER_LAT: process.env.WEATHER_LAT || '',
  WEATHER_LON: process.env.WEATHER_LON || '',
  WEATHER_PLACE: process.env.WEATHER_PLACE || 'Berlin',
  WEATHER_TZ: process.env.WEATHER_TZ || process.env.DIGEST_TZ || 'Europe/Berlin',
  WEATHER_CACHE_TTL_MS: parseInt(process.env.WEATHER_CACHE_TTL_MS || '1800000', 10),

  // Small JSON settings store on the persistent data volume.
  SETTINGS_FILE: process.env.SETTINGS_FILE || '/data/settings.json',
};

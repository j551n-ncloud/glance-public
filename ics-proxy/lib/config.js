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

  // ICS calendar-feed export (read-only Exchange-calendar subscription URL,
  // e.g. for Nextcloud's "New subscription"). URL-embedded secret, not the
  // shared API_TOKEN header — subscription clients don't send custom headers.
  // Empty disables the route (404). See CLAUDE.md's calendar-feed section.
  CALENDAR_FEED_TOKEN: process.env.CALENDAR_FEED_TOKEN || '',
  CALENDAR_FEED_PAST_DAYS: parseInt(process.env.CALENDAR_FEED_PAST_DAYS || '30', 10),
  CALENDAR_FEED_FUTURE_DAYS: parseInt(process.env.CALENDAR_FEED_FUTURE_DAYS || '180', 10),

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
  // WEATHER_* env > Heidelberg. If WEATHER_LAT/LON are set they win, else
  // WEATHER_PLACE is geocoded.
  WEATHER_LAT: process.env.WEATHER_LAT || '',
  WEATHER_LON: process.env.WEATHER_LON || '',
  WEATHER_PLACE: process.env.WEATHER_PLACE || 'Heidelberg',
  WEATHER_TZ: process.env.WEATHER_TZ || process.env.DIGEST_TZ || 'Europe/Berlin',
  WEATHER_CACHE_TTL_MS: parseInt(process.env.WEATHER_CACHE_TTL_MS || '1800000', 10),

  // Small JSON settings store on the persistent data volume.
  SETTINGS_FILE: process.env.SETTINGS_FILE || '/data/settings.json',

  // SiYuan Note (read-only, RAG-style knowledge base search). Empty disables it.
  // Scoped to one notebook by name so the rest of the user's vault (work
  // notes, etc.) is never searched or exposed.
  SIYUAN_URL: process.env.SIYUAN_URL || '',
  SIYUAN_TOKEN: process.env.SIYUAN_TOKEN || '',
  SIYUAN_NOTEBOOK_NAME: process.env.SIYUAN_NOTEBOOK_NAME || 'RAG',

  // Semantic search over the SiYuan RAG notebook: embeds note content so
  // conceptually related notes surface even without shared keywords, and
  // stores vectors in their own SQLite file. Two backends:
  //  - local (default): on-device model via @huggingface/transformers, no
  //    external API, nothing leaves the server.
  //  - remote: set EMBEDDINGS_REMOTE_URL to instead call an OpenAI-compatible
  //    /embeddings endpoint (note content IS sent to that endpoint — a
  //    deliberate opt-in, not the default).
  EMBEDDINGS_DB: process.env.EMBEDDINGS_DB || '/data/embeddings.db',
  EMBEDDINGS_MODEL: process.env.EMBEDDINGS_MODEL || 'Xenova/multilingual-e5-small',
  EMBEDDINGS_MODEL_CACHE: process.env.EMBEDDINGS_MODEL_CACHE || '/data/models',
  EMBEDDINGS_REMOTE_URL: process.env.EMBEDDINGS_REMOTE_URL || '',
  EMBEDDINGS_REMOTE_API_KEY: process.env.EMBEDDINGS_REMOTE_API_KEY || '',
  EMBEDDINGS_REMOTE_MODEL: process.env.EMBEDDINGS_REMOTE_MODEL || 'alias-embeddings',
  // Cosine-similarity floor below which a semanticSearch match is dropped
  // as noise rather than a real answer. See lib/embeddings.js semanticSearch
  // for why this exists. 0.86, not something like 0.5: measured against the
  // live RAG notebook (Xenova/multilingual-e5-small), a gibberish query with
  // no real match still scores 0.83-0.85 against unrelated notes (this
  // model's embedding space is anisotropic, so nothing scores near 0), while
  // a query that genuinely matches a note scores 0.90+. Re-check this if the
  // embedding backend/model ever changes.
  EMBEDDINGS_MIN_SCORE: parseFloat(process.env.EMBEDDINGS_MIN_SCORE || '0.86'),

  // Garmin Connect (unofficial, username/password login -- no public
  // personal-use API exists). Used only to push structured workouts (see
  // lib/garmin.js) so they sync to the watch; nothing is read back from
  // Garmin here (Strava already covers completed-activity reads). Leave
  // GARMIN_EMAIL/PASSWORD empty to disable.
  GARMIN_EMAIL: process.env.GARMIN_EMAIL || '',
  GARMIN_PASSWORD: process.env.GARMIN_PASSWORD || '',
  GARMIN_TOKENS_FILE: process.env.GARMIN_TOKENS_FILE || '/data/garmin-tokens.json',

  // Push notifications (ntfy.sh or self-hosted) for proactive alerts that
  // shouldn't wait for the next digest email: bike maintenance gone overdue,
  // tasks overdue/due soon, Deck cards due. Disabled unless NTFY_TOPIC is set.
  NTFY_URL: process.env.NTFY_URL || 'https://ntfy.sh',
  NTFY_TOPIC: process.env.NTFY_TOPIC || '',
  NTFY_TOKEN: process.env.NTFY_TOKEN || '',
};

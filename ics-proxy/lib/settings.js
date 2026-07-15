// Tiny JSON settings store on the persistent data volume (survives restarts).
// Currently holds the weather default location; kept generic for future keys.
const fs = require('fs');
const { SETTINGS_FILE } = require('./config');

function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); }
  catch { return {}; }
}

function writeSettings(patch) {
  const merged = { ...readSettings(), ...patch };
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2));
  } catch (e) {
    console.error('writeSettings failed:', e.message);
    throw new Error('could not persist settings');
  }
  return merged;
}

module.exports = { readSettings, writeSettings };

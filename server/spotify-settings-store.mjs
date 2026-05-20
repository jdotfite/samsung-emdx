import { getDb } from "./db.mjs";
import { env } from "./env.mjs";

const SPOTIFY_SETTINGS_KEY = "spotify_settings";

function normalizeSettings(input = {}) {
  return {
    clientId: String(input.clientId || "").trim(),
    clientSecret: String(input.clientSecret || "").trim(),
    market: String(input.market || env.spotifyMarket || "US").trim().toUpperCase() || "US"
  };
}

export function loadSpotifySettingsFromStore() {
  const db = getDb();
  const row = db.prepare("SELECT value FROM app_state WHERE key = ?").get(SPOTIFY_SETTINGS_KEY);

  let stored = {};
  if (row?.value) {
    try {
      stored = JSON.parse(row.value);
    } catch {
      stored = {};
    }
  }

  const normalized = normalizeSettings({
    clientId: stored.clientId || env.spotifyClientId,
    clientSecret: stored.clientSecret || env.spotifyClientSecret,
    market: stored.market || env.spotifyMarket
  });

  return {
    ...normalized,
    configured: Boolean(normalized.clientId && normalized.clientSecret),
    source: row ? "saved" : "env"
  };
}

export function saveSpotifySettingsToStore(input = {}) {
  const db = getDb();
  const current = loadSpotifySettingsFromStore();
  const settings = normalizeSettings({
    ...input,
    clientSecret: String(input.clientSecret || "").trim() || current.clientSecret
  });

  db.prepare(`
    INSERT INTO app_state (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = CURRENT_TIMESTAMP
  `).run(SPOTIFY_SETTINGS_KEY, JSON.stringify(settings));

  return loadSpotifySettingsFromStore();
}

export function resolveSpotifySettings() {
  const settings = loadSpotifySettingsFromStore();
  return {
    clientId: settings.clientId,
    clientSecret: settings.clientSecret,
    market: settings.market
  };
}

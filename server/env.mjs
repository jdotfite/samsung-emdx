import path from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: path.join(process.cwd(), ".env"), quiet: true });

function toAbsolute(relativePath) {
  return path.isAbsolute(relativePath) ? relativePath : path.join(process.cwd(), relativePath);
}

function toPositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const env = {
  appHost: process.env.APP_HOST || "127.0.0.1",
  appPort: Number(process.env.APP_PORT || 4173),
  databasePath: toAbsolute(process.env.DATABASE_PATH || "./data/poster-wall.db"),
  outputDir: toAbsolute(process.env.OUTPUT_DIR || "./output"),
  spotifyClientId: process.env.SPOTIFY_CLIENT_ID || "",
  spotifyClientSecret: process.env.SPOTIFY_CLIENT_SECRET || "",
  spotifyMarket: process.env.SPOTIFY_MARKET || "US",
  defaultLocalIp: process.env.DEFAULT_LOCAL_IP || "",
  samsungEmdxBin: process.env.SAMSUNG_EMDX_BIN || "",
  appAuthToken: process.env.APP_AUTH_TOKEN || "",
  contentSchedulePollMs: toPositiveNumber(process.env.CONTENT_SCHEDULE_POLL_MS, 30000),
  tmdbReadAccessToken: process.env.TMDB_READ_ACCESS_TOKEN || ""
};

export function requireSpotifyConfig() {
  if (!env.spotifyClientId || !env.spotifyClientSecret) {
    throw new Error("Spotify credentials are missing. Populate SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env.");
  }
}

import path from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: path.join(process.cwd(), ".env"), quiet: true });

function toAbsolute(relativePath) {
  return path.isAbsolute(relativePath) ? relativePath : path.join(process.cwd(), relativePath);
}

export const env = {
  appHost: process.env.APP_HOST || "127.0.0.1",
  appPort: Number(process.env.APP_PORT || 4173),
  databasePath: toAbsolute(process.env.DATABASE_PATH || "./data/poster-wall.db"),
  spotifyClientId: process.env.SPOTIFY_CLIENT_ID || "",
  spotifyClientSecret: process.env.SPOTIFY_CLIENT_SECRET || "",
  spotifyMarket: process.env.SPOTIFY_MARKET || "US",
  defaultLocalIp: process.env.DEFAULT_LOCAL_IP || "",
  samsungEmdxBin: process.env.SAMSUNG_EMDX_BIN || ""
};

export function requireSpotifyConfig() {
  if (!env.spotifyClientId || !env.spotifyClientSecret) {
    throw new Error("Spotify credentials are missing. Populate SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env.");
  }
}

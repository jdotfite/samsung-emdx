import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { env } from "./env.mjs";

let database;

export function getDb() {
  if (database) {
    return database;
  }

  fs.mkdirSync(path.dirname(env.databasePath), { recursive: true });
  database = new Database(env.databasePath);
  database.pragma("journal_mode = WAL");

  database.exec(`
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS imported_albums (
      slug TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      source_id TEXT NOT NULL UNIQUE,
      artist TEXT NOT NULL,
      album TEXT NOT NULL,
      year INTEGER,
      cover_path TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  return database;
}

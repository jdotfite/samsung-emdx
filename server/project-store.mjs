import fs from "node:fs";
import path from "node:path";
import { getDb } from "./db.mjs";

const PROJECT_KEY = "project-config";
const fallbackProjectPath = path.join(process.cwd(), "data", "project.json");

export function loadProjectFromStore() {
  const db = getDb();
  const row = db.prepare("SELECT value FROM app_state WHERE key = ?").get(PROJECT_KEY);
  if (row?.value) {
    return JSON.parse(row.value);
  }

  const fallback = JSON.parse(fs.readFileSync(fallbackProjectPath, "utf8"));
  saveProjectToStore(fallback);
  return fallback;
}

export function saveProjectToStore(project) {
  const db = getDb();
  const value = JSON.stringify(project, null, 2);
  db.prepare(`
    INSERT INTO app_state (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = CURRENT_TIMESTAMP
  `).run(PROJECT_KEY, value);
  return project;
}

import { getDb } from "./db.mjs";

const CONTENT_SCHEDULES_KEY = "content-schedules";

export function loadContentSchedulesFromStore() {
  const db = getDb();
  const row = db.prepare("SELECT value FROM app_state WHERE key = ?").get(CONTENT_SCHEDULES_KEY);
  if (!row?.value) {
    return [];
  }

  try {
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveContentSchedulesToStore(schedules) {
  const db = getDb();
  const value = JSON.stringify(Array.isArray(schedules) ? schedules : [], null, 2);
  db.prepare(`
    INSERT INTO app_state (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = CURRENT_TIMESTAMP
  `).run(CONTENT_SCHEDULES_KEY, value);
  return Array.isArray(schedules) ? schedules : [];
}

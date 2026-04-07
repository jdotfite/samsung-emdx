import fs from "node:fs";
import path from "node:path";
import { getDb } from "./db.mjs";

const DEVICE_STATE_KEY = "device-state";
const previewDir = path.join(process.cwd(), "data", "device-previews");

export function loadDeviceStateFromStore() {
  const db = getDb();
  const row = db.prepare("SELECT value FROM app_state WHERE key = ?").get(DEVICE_STATE_KEY);
  return row?.value ? JSON.parse(row.value) : {};
}

export function saveDeviceStateToStore(deviceState) {
  const db = getDb();
  const value = JSON.stringify(deviceState, null, 2);
  db.prepare(`
    INSERT INTO app_state (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = CURRENT_TIMESTAMP
  `).run(DEVICE_STATE_KEY, value);
  return deviceState;
}

export function recordSentImages(results) {
  const deviceState = loadDeviceStateFromStore();
  fs.mkdirSync(previewDir, { recursive: true });

  for (const result of results) {
    const extension = path.extname(result.imagePath) || ".png";
    const fileName = `${result.screenId}${extension}`;
    const destinationPath = path.join(previewDir, fileName);
    fs.copyFileSync(result.imagePath, destinationPath);

    deviceState[result.screenId] = {
      screenId: result.screenId,
      host: result.host,
      imageUrl: `/data/device-previews/${fileName}`,
      imagePath: destinationPath,
      sentAt: new Date().toISOString()
    };
  }

  return saveDeviceStateToStore(deviceState);
}

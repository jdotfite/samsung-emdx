import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const fixtureDir = path.join(process.cwd(), "tests", "fixtures", "output");
const testDbPath = path.resolve(process.cwd(), process.env.TEST_DB_PATH || "./data/poster-wall-test.db");

async function ensurePortraitFixture() {
  const filePath = path.join(fixtureDir, "fixture-portrait.png");
  if (fs.existsSync(filePath)) return;
  const buffer = await sharp({
    create: { width: 1440, height: 2560, channels: 3, background: { r: 60, g: 90, b: 140 } }
  })
    .png()
    .toBuffer();
  fs.writeFileSync(filePath, buffer);
}

async function ensureLandscapeFixture() {
  const filePath = path.join(fixtureDir, "fixture-landscape.jpg");
  if (fs.existsSync(filePath)) return;
  const buffer = await sharp({
    create: { width: 2560, height: 1440, channels: 3, background: { r: 200, g: 120, b: 60 } }
  })
    .jpeg({ quality: 85 })
    .toBuffer();
  fs.writeFileSync(filePath, buffer);
}

export default async function globalSetup() {
  fs.mkdirSync(fixtureDir, { recursive: true });
  for (const entry of fs.readdirSync(fixtureDir)) {
    if (entry.startsWith("fixture-")) continue;
    const target = path.join(fixtureDir, entry);
    try {
      const stat = fs.statSync(target);
      if (stat.isFile()) fs.unlinkSync(target);
    } catch {}
  }
  const cachePath = path.join(fixtureDir, ".edit-cache");
  if (fs.existsSync(cachePath)) {
    fs.rmSync(cachePath, { recursive: true, force: true });
  }
  await ensurePortraitFixture();
  await ensureLandscapeFixture();
  sweepStaleTestDbs(path.dirname(testDbPath), path.basename(testDbPath));
}

function sweepStaleTestDbs(dir, currentName) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.startsWith("poster-wall-test")) continue;
    if (entry === currentName || entry.startsWith(`${currentName}-`)) continue;
    try {
      fs.rmSync(path.join(dir, entry), { force: true });
    } catch {}
  }
}

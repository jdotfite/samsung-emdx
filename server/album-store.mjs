import fs from "node:fs";
import path from "node:path";
import { getDb } from "./db.mjs";

const albumsDir = path.join(process.cwd(), "data", "albums");
const importedCoverDir = path.join(process.cwd(), "assets", "covers", "imported");

function albumFilePath(slug) {
  return path.join(albumsDir, `${slug}.json`);
}

function isFixtureSlug(slug) {
  return fs.existsSync(albumFilePath(slug));
}

export function listFixtureCatalog() {
  const catalogPath = path.join(albumsDir, "catalog.json");
  return JSON.parse(fs.readFileSync(catalogPath, "utf8")).map((entry) => ({
    ...entry,
    source: "fixture"
  }));
}

export function loadAlbumBySlug(slug) {
  if (isFixtureSlug(slug)) {
    return JSON.parse(fs.readFileSync(albumFilePath(slug), "utf8"));
  }

  const db = getDb();
  const row = db.prepare("SELECT payload_json FROM imported_albums WHERE slug = ?").get(slug);
  return row ? JSON.parse(row.payload_json) : null;
}

export function listAllCatalogEntries() {
  const fixture = listFixtureCatalog();
  const db = getDb();
  const imported = db
    .prepare("SELECT slug, source, artist, album, year FROM imported_albums ORDER BY updated_at DESC, artist, album")
    .all();
  return [...fixture, ...imported];
}

export function deleteImportedAlbums(slugs = []) {
  const validSlugs = [...new Set(slugs.map((slug) => String(slug || "").trim()).filter(Boolean))];
  if (!validSlugs.length) {
    return [];
  }

  const db = getDb();
  const selectBySlug = db.prepare("SELECT slug, cover_path FROM imported_albums WHERE slug = ?");
  const deleteBySlug = db.prepare("DELETE FROM imported_albums WHERE slug = ?");
  const deleted = [];

  const transaction = db.transaction((entries) => {
    for (const slug of entries) {
      const row = selectBySlug.get(slug);
      if (!row) {
        continue;
      }
      deleteBySlug.run(slug);
      deleted.push({
        slug: row.slug,
        coverPath: row.cover_path
      });
    }
  });

  transaction(validSlugs);

  for (const entry of deleted) {
    const coverPath = String(entry.coverPath || "");
    if (!coverPath.startsWith("/assets/covers/imported/")) {
      continue;
    }
    const absoluteCoverPath = path.resolve(process.cwd(), `.${coverPath}`);
    if (!absoluteCoverPath.startsWith(path.resolve(importedCoverDir) + path.sep)) {
      continue;
    }
    try {
      fs.unlinkSync(absoluteCoverPath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  return deleted.map((entry) => entry.slug);
}

export function saveImportedAlbum(album) {
  const db = getDb();
  db.prepare(`
    INSERT INTO imported_albums (
      slug, source, source_id, artist, album, year, cover_path, payload_json, updated_at
    ) VALUES (
      @slug, @source, @sourceId, @artist, @album, @year, @cover, @payloadJson, CURRENT_TIMESTAMP
    )
    ON CONFLICT(slug) DO UPDATE SET
      source = excluded.source,
      source_id = excluded.source_id,
      artist = excluded.artist,
      album = excluded.album,
      year = excluded.year,
      cover_path = excluded.cover_path,
      payload_json = excluded.payload_json,
      updated_at = CURRENT_TIMESTAMP
  `).run({
    slug: album.slug,
    source: album.source,
    sourceId: album.sourceId,
    artist: album.artist,
    album: album.album,
    year: album.year,
    cover: album.cover,
    payloadJson: JSON.stringify(album, null, 2)
  });
  return album;
}

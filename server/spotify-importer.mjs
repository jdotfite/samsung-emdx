import fs from "node:fs/promises";
import path from "node:path";
import { Vibrant } from "node-vibrant/node";
import { env } from "./env.mjs";
import { saveImportedAlbum } from "./album-store.mjs";
import { getAlbum } from "./spotify-client.mjs";

const importedCoverDir = path.join(process.cwd(), "assets", "covers", "imported");

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

async function downloadCover(imageUrl, slug) {
  await fs.mkdir(importedCoverDir, { recursive: true });
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`Failed to download cover art: ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const filePath = path.join(importedCoverDir, `${slug}.jpg`);
  await fs.writeFile(filePath, buffer);
  return {
    filePath,
    publicPath: `/assets/covers/imported/${slug}.jpg`
  };
}

async function extractPalette(filePath) {
  try {
    const palette = await Vibrant.from(filePath).maxColorCount(5).getPalette();
    const swatches = Object.values(palette)
      .filter(Boolean)
      .map((swatch) => swatch.hex)
      .slice(0, 5);
    return swatches.length ? swatches : ["#1a1a1a", "#f4f1e8", "#8c8375", "#4f4a43", "#cbc2b5"];
  } catch {
    return ["#1a1a1a", "#f4f1e8", "#8c8375", "#4f4a43", "#cbc2b5"];
  }
}

function extractLabel(album) {
  // Prefer copyrights for richer label info (e.g. "Atlantic Records, Never Broke Again & Quando Rondo, LLC")
  const copyrights = album.copyrights || [];
  const phonographic = copyrights.find((c) => c.type === "P");
  const general = copyrights.find((c) => c.type === "C") || copyrights[0];
  const raw = (phonographic || general)?.text || "";
  // Strip leading year and (P)/(C) markers: "2021 Atlantic Records" → "Atlantic Records"
  const cleaned = raw.replace(/^[©℗(PC)\s\d]+/i, "").trim();
  if (cleaned) return cleaned;
  // Fall back to Spotify's label field
  return album.label || "";
}

function normalizeAlbumPayload(album, coverPath, palette) {
  const primaryArtist = album.artists?.[0]?.name || "Unknown Artist";
  const year = Number(String(album.release_date || "").slice(0, 4)) || null;
  const slugBase = `${slugify(primaryArtist)}-${slugify(album.name)}-${year || "unknown"}`;
  const slug = `${slugBase}-${album.id.slice(0, 6)}`;

  return {
    slug,
    source: "spotify",
    sourceId: album.id,
    artist: primaryArtist,
    album: album.name,
    year,
    releaseDate: album.release_date || "",
    label: extractLabel(album),
    artistLabel: "Artist",
    cover: coverPath,
    palette,
    format: `${album.album_type || "album"} / Spotify`,
    footer: "Spotify import",
    tracks: (album.tracks?.items || []).map((track) => ({
      title: track.name,
      length: msToClock(track.duration_ms)
    })),
    metadata: {
      spotifyUrl: album.external_urls?.spotify || "",
      market: env.spotifyMarket
    }
  };
}

function msToClock(durationMs) {
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export async function importSpotifyAlbum(albumId) {
  const album = await getAlbum(albumId);
  const imageUrl = album.images?.[0]?.url;
  if (!imageUrl) {
    throw new Error("Album has no cover art available.");
  }

  const tempSlug = `${slugify(album.artists?.[0]?.name || "artist")}-${slugify(album.name) || album.id}`;
  const { filePath, publicPath } = await downloadCover(imageUrl, tempSlug);
  const palette = await extractPalette(filePath);
  const normalized = normalizeAlbumPayload(album, publicPath, palette);

  if (normalized.slug !== tempSlug) {
    const renamedPath = path.join(importedCoverDir, `${normalized.slug}.jpg`);
    await fs.rename(filePath, renamedPath);
    normalized.cover = `/assets/covers/imported/${normalized.slug}.jpg`;
  }

  return saveImportedAlbum(normalized);
}

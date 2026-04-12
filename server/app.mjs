import express from "express";
import path from "node:path";
import fs from "node:fs";
import sharp from "sharp";
import { env } from "./env.mjs";
import { deleteImportedAlbums, listAllCatalogEntries, loadAlbumBySlug } from "./album-store.mjs";
import { loadDeviceStateFromStore, recordSentImages } from "./device-state-store.mjs";
import { loadProjectFromStore, saveProjectToStore } from "./project-store.mjs";
import { applyEditRecipe, normalizeEditRecipe, writeEditCache } from "../scripts/lib/image-edit-service.mjs";
import { getArtistAlbumsPage, getPlaylistAlbums, parseSpotifyId, searchAlbums, searchArtists } from "./spotify-client.mjs";
import { importSpotifyAlbum } from "./spotify-importer.mjs";
import { loadSpotifySettingsFromStore, saveSpotifySettingsToStore } from "./spotify-settings-store.mjs";
import { getDb } from "./db.mjs";
import { getRuntimeState, setRuntimeState } from "./runtime-state.mjs";
import { getDeviceStatus, wakeDevice } from "./device-diagnostics.mjs";
import { discoverSamsungDevices } from "./device-discovery.mjs";
import {
  completeSendJobTarget,
  createSendJob,
  failSendJob,
  finishSendJob,
  getSendJob,
  markSendJobRunning,
  recordSendJobEvent
} from "./send-job-store.mjs";
import { selectScreens } from "../scripts/lib/project-config.mjs";
import { renderScreens } from "../scripts/lib/render-service.mjs";
import { sendImageToScreens, sendImagesToScreens, sendScreens } from "../scripts/lib/send-service.mjs";
import { DEFAULT_PROJECT } from "../src/default-project.js";

const rootDir = process.cwd();
const outputDir = env.outputDir;
const editCacheDir = path.join(outputDir, ".edit-cache");
const outputImagePattern = /\.(png|jpe?g|webp)$/i;

function orientationFromRatio(ratio) {
  if (!Number.isFinite(ratio) || ratio <= 0) {
    return null;
  }
  if (Math.abs(ratio - 1) < 0.02) {
    return "square";
  }
  return ratio > 1 ? "landscape" : "portrait";
}

async function probeImage(filePath) {
  try {
    const metadata = await sharp(filePath).metadata();
    const rotated = metadata.orientation && metadata.orientation >= 5 && metadata.orientation <= 8;
    const width = rotated ? metadata.height : metadata.width;
    const height = rotated ? metadata.width : metadata.height;
    if (!width || !height) {
      return { width: null, height: null, aspectRatio: null, orientation: null, format: metadata.format || null };
    }
    const aspectRatio = Math.round((width / height) * 1000) / 1000;
    return {
      width,
      height,
      aspectRatio,
      orientation: orientationFromRatio(aspectRatio),
      format: metadata.format || null
    };
  } catch (error) {
    console.warn(`[image-probe] failed to read ${path.basename(filePath)}: ${error.message}`);
    return { width: null, height: null, aspectRatio: null, orientation: null, format: null };
  }
}

function sanitizeUploadFileName(fileName = "upload") {
  const parsed = path.parse(fileName);
  const safeBase = (parsed.name || "upload")
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "upload";
  const ext = (parsed.ext || "").toLowerCase();
  return `${safeBase}${ext}`;
}

function buildStudioOutputBaseName(prefix, parts) {
  const tail = parts
    .map((part) =>
      String(part || "")
        .toLowerCase()
        .replace(/[^a-z0-9-_]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, ""),
    )
    .filter(Boolean)
    .join("-");

  return sanitizeUploadFileName(`${prefix}-${tail || "output"}`).replace(path.extname(`${prefix}-${tail || "output"}`), "");
}

async function listOutputImages() {
  const entries = await fs.promises.readdir(outputDir, { withFileTypes: true });
  const images = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && outputImagePattern.test(entry.name) && !/^ui-/i.test(entry.name))
      .map(async (entry) => {
        const filePath = path.join(outputDir, entry.name);
        const [stats, dimensions] = await Promise.all([
          fs.promises.stat(filePath),
          probeImage(filePath)
        ]);
        return {
          name: entry.name,
          url: `/output/${entry.name}`,
          size: stats.size,
          modifiedAt: stats.mtime.toISOString(),
          width: dimensions.width,
          height: dimensions.height,
          aspectRatio: dimensions.aspectRatio,
          orientation: dimensions.orientation,
          format: dimensions.format
        };
      }),
  );

  images.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
  return images;
}

function editCachePathFor(imageName) {
  return path.join(editCacheDir, imageName);
}

async function resolveContentImagePath(project, imageName) {
  if (path.basename(imageName) !== imageName) {
    throw Object.assign(new Error(`Invalid image name: ${imageName}`), { statusCode: 400 });
  }
  const sourcePath = path.resolve(outputDir, imageName);
  if (!sourcePath.startsWith(path.resolve(outputDir) + path.sep)) {
    throw Object.assign(new Error(`Invalid image path: ${imageName}`), { statusCode: 400 });
  }
  await fs.promises.access(sourcePath, fs.constants.R_OK);
  const editRecipe = project.contentLibrary?.items?.[imageName]?.editRecipe || null;
  if (!editRecipe) return sourcePath;
  const cachePath = editCachePathFor(imageName);
  try {
    await fs.promises.access(cachePath, fs.constants.R_OK);
    return cachePath;
  } catch {}
  const targetScreen = editRecipe.targetScreenId
    ? project.screens.find((screen) => screen.id === editRecipe.targetScreenId)
    : null;
  const buffer = await applyEditRecipe(sourcePath, editRecipe, {
    targetWidth: targetScreen?.size?.width || null,
    targetHeight: targetScreen?.size?.height || null,
    outputFormat: path.extname(imageName).slice(1)
  });
  await writeEditCache(cachePath, buffer);
  return cachePath;
}

async function removeEditCache(imageName) {
  const cachePath = editCachePathFor(imageName);
  try {
    await fs.promises.unlink(cachePath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

function findScreenById(screenId) {
  return loadProjectFromStore().screens.find((screen) => screen.id === screenId) || null;
}

export async function startAppServer({ host = env.appHost, port = env.appPort } = {}) {
  getDb();

  const app = express();
  app.use(express.json({ limit: "2mb" }));

  app.get("/api/health", (req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/project", (req, res) => {
    res.json(loadProjectFromStore());
  });

  app.get("/api/device-state", (req, res) => {
    res.json(loadDeviceStateFromStore());
  });

  app.post("/api/devices/discover", async (req, res) => {
    try {
      const project = loadProjectFromStore();
      res.json(await discoverSamsungDevices({ project }));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/send-jobs/:jobId", (req, res) => {
    const job = getSendJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "Send job not found." });
      return;
    }
    res.json(job);
  });

  app.get("/api/devices/:screenId/status", async (req, res) => {
    try {
      const screen = findScreenById(req.params.screenId);
      if (!screen) {
        res.status(404).json({ error: "Device not found." });
        return;
      }

      const status = await getDeviceStatus(screen.device);
      res.json({
        ok: true,
        screenId: screen.id,
        status
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/devices/:screenId/wake", async (req, res) => {
    try {
      const screen = findScreenById(req.params.screenId);
      if (!screen) {
        res.status(404).json({ error: "Device not found." });
        return;
      }

      const result = await wakeDevice(screen.device);
      res.json({
        ok: true,
        screenId: screen.id,
        result
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/project", (req, res) => {
    res.json(saveProjectToStore(req.body));
  });

  app.get("/api/catalog", (req, res) => {
    res.json(listAllCatalogEntries());
  });

  app.get("/api/studio/plugins/album-art/settings", (req, res) => {
    res.json(loadSpotifySettingsFromStore());
  });

  app.put("/api/studio/plugins/album-art/settings", (req, res) => {
    try {
      res.json(saveSpotifySettingsToStore(req.body || {}));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/albums/:slug", (req, res) => {
    const album = loadAlbumBySlug(req.params.slug);
    if (!album) {
      res.status(404).json({ error: "Album not found" });
      return;
    }
    res.json(album);
  });

  app.get("/api/output-images", async (req, res) => {
    try {
      const images = await listOutputImages();
      res.json({
        directory: outputDir,
        images
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/output-images/upload", express.raw({ type: "image/*", limit: "25mb" }), async (req, res) => {
    try {
      const contentType = String(req.headers["content-type"] || "").toLowerCase();
      const extensionByType = {
        "image/jpeg": ".jpg",
        "image/jpg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp"
      };
      const extension = extensionByType[contentType];

      if (!extension) {
        res.status(400).json({ error: "Unsupported image type. Use JPG, PNG, or WebP." });
        return;
      }

      if (!req.body?.length) {
        res.status(400).json({ error: "No image data received." });
        return;
      }

      await fs.promises.mkdir(outputDir, { recursive: true });
      const sourceName = decodeURIComponent(String(req.headers["x-filename"] || "upload"));
      const replaceHeader = decodeURIComponent(String(req.headers["x-replace-name"] || "")).trim();
      const replaceName = replaceHeader && path.basename(replaceHeader) === replaceHeader ? replaceHeader : "";
      const replaceBase = replaceName ? path.basename(replaceName, path.extname(replaceName)) : "";
      const sourceBase = sourceName.replace(path.extname(sourceName), "");
      const safeBaseName = sanitizeUploadFileName(replaceBase || sourceBase);
      const finalName = replaceName ? `${safeBaseName}${extension}` : `${Date.now()}-${safeBaseName}${extension}`;
      const filePath = path.join(outputDir, finalName);

      await fs.promises.writeFile(filePath, req.body);
      if (replaceName && replaceName !== finalName) {
        const previousPath = path.resolve(outputDir, replaceName);
        if (previousPath.startsWith(path.resolve(outputDir) + path.sep)) {
          try {
            await fs.promises.unlink(previousPath);
          } catch (error) {
            if (error.code !== "ENOENT") {
              throw error;
            }
          }
        }
      }
      const images = await listOutputImages();
      const uploaded = images.find((image) => image.name === finalName);

      res.json({
        ok: true,
        image: uploaded,
        replaced: replaceName || null
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/output-images/delete", async (req, res) => {
    try {
      const names = Array.isArray(req.body.names) ? req.body.names : [];
      const deleted = [];

      for (const name of names) {
        if (!name || path.basename(name) !== name) {
          continue;
        }

        const filePath = path.resolve(outputDir, name);
        if (!filePath.startsWith(path.resolve(outputDir) + path.sep)) {
          continue;
        }

        try {
          await fs.promises.unlink(filePath);
          deleted.push(name);
        } catch (error) {
          if (error.code !== "ENOENT") {
            throw error;
          }
        }
      }

      res.json({ ok: true, deleted });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/imported-albums/delete", async (req, res) => {
    try {
      const slugs = Array.isArray(req.body.slugs) ? req.body.slugs : [];
      const deleted = deleteImportedAlbums(slugs);
      res.json({ ok: true, deleted });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/content/items/:imageName/edit", async (req, res) => {
    try {
      const imageName = String(req.params.imageName || "").trim();
      if (!imageName || path.basename(imageName) !== imageName) {
        res.status(400).json({ error: "Invalid image name." });
        return;
      }

      const sourcePath = path.resolve(outputDir, imageName);
      if (!sourcePath.startsWith(path.resolve(outputDir) + path.sep)) {
        res.status(400).json({ error: "Invalid image path." });
        return;
      }
      await fs.promises.access(sourcePath, fs.constants.R_OK);

      const rawRecipe = req.body?.editRecipe || null;
      const saveAsCopy = Boolean(req.body?.saveAsCopy);
      const normalized = normalizeEditRecipe(rawRecipe);

      const project = loadProjectFromStore();
      const targetScreen = normalized?.targetScreenId
        ? project.screens.find((screen) => screen.id === normalized.targetScreenId)
        : null;
      const targetWidth = targetScreen?.size?.width || null;
      const targetHeight = targetScreen?.size?.height || null;

      if (saveAsCopy) {
        if (!normalized) {
          res.status(400).json({ error: "No edits to apply." });
          return;
        }
        const buffer = await applyEditRecipe(sourcePath, normalized, {
          targetWidth,
          targetHeight,
          outputFormat: path.extname(imageName).slice(1)
        });
        const parsed = path.parse(imageName);
        const stamp = Date.now();
        const copyName = `${parsed.name}-edit-${stamp}${parsed.ext || ".png"}`;
        const copyPath = path.join(outputDir, copyName);
        await fs.promises.mkdir(outputDir, { recursive: true });
        await fs.promises.writeFile(copyPath, buffer);
        const images = await listOutputImages();
        const copy = images.find((image) => image.name === copyName);
        res.json({ ok: true, savedAsCopy: true, image: copy });
        return;
      }

      project.contentLibrary = project.contentLibrary || { collections: [], sets: [], items: {} };
      project.contentLibrary.items = project.contentLibrary.items || {};
      const existing = project.contentLibrary.items[imageName] || { tags: [], collectionIds: [] };
      project.contentLibrary.items[imageName] = {
        tags: Array.isArray(existing.tags) ? existing.tags : [],
        collectionIds: Array.isArray(existing.collectionIds) ? existing.collectionIds : [],
        editRecipe: normalized
      };
      saveProjectToStore(project);

      if (normalized) {
        const buffer = await applyEditRecipe(sourcePath, normalized, {
          targetWidth,
          targetHeight,
          outputFormat: path.extname(imageName).slice(1)
        });
        await writeEditCache(editCachePathFor(imageName), buffer);
      } else {
        await removeEditCache(imageName);
      }

      res.json({ ok: true, editRecipe: normalized });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/content/items/:imageName/edit", async (req, res) => {
    try {
      const imageName = String(req.params.imageName || "").trim();
      if (!imageName || path.basename(imageName) !== imageName) {
        res.status(400).json({ error: "Invalid image name." });
        return;
      }
      const project = loadProjectFromStore();
      const item = project.contentLibrary?.items?.[imageName];
      if (item) {
        item.editRecipe = null;
        saveProjectToStore(project);
      }
      await removeEditCache(imageName);
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/content/send", async (req, res) => {
    try {
      const imageName = String(req.body.imageName || "").trim();
      const requestedIds = Array.isArray(req.body.screenIds) ? req.body.screenIds : [];

      if (!imageName) {
        res.status(400).json({ error: "imageName is required." });
        return;
      }

      if (path.basename(imageName) !== imageName) {
        res.status(400).json({ error: "Invalid image name." });
        return;
      }

      const sourcePath = path.resolve(outputDir, imageName);
      if (!sourcePath.startsWith(path.resolve(outputDir) + path.sep)) {
        res.status(400).json({ error: "Invalid image path." });
        return;
      }

      await fs.promises.access(sourcePath, fs.constants.R_OK);

      const project = loadProjectFromStore();

      let imagePath = sourcePath;
      const editRecipe = project.contentLibrary?.items?.[imageName]?.editRecipe || null;
      if (editRecipe) {
        const cachePath = editCachePathFor(imageName);
        try {
          await fs.promises.access(cachePath, fs.constants.R_OK);
          imagePath = cachePath;
        } catch {
          const targetScreen = editRecipe.targetScreenId
            ? project.screens.find((screen) => screen.id === editRecipe.targetScreenId)
            : null;
          const buffer = await applyEditRecipe(sourcePath, editRecipe, {
            targetWidth: targetScreen?.size?.width || null,
            targetHeight: targetScreen?.size?.height || null,
            outputFormat: path.extname(imageName).slice(1)
          });
          await writeEditCache(cachePath, buffer);
          imagePath = cachePath;
        }
      }

      const screens = project.screens.filter((screen) => requestedIds.includes(screen.id) && screen.enabled);
      const missing = requestedIds.filter((id) => !screens.some((screen) => screen.id === id));

      if (missing.length) {
        res.status(400).json({ error: `Unknown screen ids: ${missing.join(", ")}` });
        return;
      }

      if (!screens.length) {
        res.status(400).json({ error: "No target devices selected." });
        return;
      }

      const job = createSendJob({
        imageName,
        screens
      });

      markSendJobRunning(job.id);

      void (async () => {
        try {
          const results = await sendImageToScreens({
            screens,
            imagePath,
            onProgress: (screen, event) => {
              recordSendJobEvent(job.id, screen.id, event);
            }
          });

          for (const result of results) {
            completeSendJobTarget(job.id, result.screenId, result);
          }
          recordSentImages(results);

          const finalJob = getSendJob(job.id);
          const hasUnverified = finalJob?.targets.some((t) => t.status === "unverified");
          if (hasUnverified) {
            failSendJob(job.id, "One or more frames did not confirm image receipt. Try waking the display and sending again.");
          } else {
            finishSendJob(job.id);
          }
        } catch (error) {
          failSendJob(job.id, error.message || "Send failed.");
        }
      })();

      res.status(202).json({
        ok: true,
        imageName,
        jobId: job.id
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/content/send-set", async (req, res) => {
    try {
      const setId = String(req.body.setId || "").trim();
      const requestedIds = Array.isArray(req.body.screenIds) ? req.body.screenIds : [];

      if (!setId) {
        res.status(400).json({ error: "setId is required." });
        return;
      }

      const project = loadProjectFromStore();
      const set = (project.contentLibrary?.sets || []).find((entry) => entry.id === setId);
      if (!set) {
        res.status(404).json({ error: `Set not found: ${setId}` });
        return;
      }

      const positions = [...(set.items || [])].sort((a, b) => a.position - b.position);
      if (!positions.length) {
        res.status(400).json({ error: "Set has no items." });
        return;
      }

      if (requestedIds.length !== positions.length) {
        res.status(400).json({ error: `Expected ${positions.length} screenIds, got ${requestedIds.length}.` });
        return;
      }

      const screens = [];
      const imagePathByScreenId = {};
      for (let i = 0; i < positions.length; i += 1) {
        const screenId = requestedIds[i];
        const screen = project.screens.find((entry) => entry.id === screenId && entry.enabled);
        if (!screen) {
          res.status(400).json({ error: `Unknown or disabled screen: ${screenId}` });
          return;
        }
        if (screens.some((entry) => entry.id === screen.id)) {
          res.status(400).json({ error: `Screen ${screen.id} is mapped to multiple positions.` });
          return;
        }
        let imagePath;
        try {
          imagePath = await resolveContentImagePath(project, positions[i].imageName);
        } catch (err) {
          const status = err.statusCode || 500;
          res.status(status).json({ error: err.message });
          return;
        }
        screens.push(screen);
        imagePathByScreenId[screen.id] = imagePath;
      }

      const job = createSendJob({
        imageName: `Set: ${set.name}`,
        screens
      });

      markSendJobRunning(job.id);

      void (async () => {
        try {
          const results = await sendImagesToScreens({
            screens,
            imagePathByScreenId,
            onProgress: (screen, event) => {
              recordSendJobEvent(job.id, screen.id, event);
            }
          });

          for (const result of results) {
            completeSendJobTarget(job.id, result.screenId, result);
          }
          recordSentImages(results);

          const finalJob = getSendJob(job.id);
          const hasUnverified = finalJob?.targets.some((t) => t.status === "unverified");
          if (hasUnverified) {
            failSendJob(job.id, "One or more frames did not confirm image receipt. Try waking the display and sending again.");
          } else {
            finishSendJob(job.id);
          }
        } catch (error) {
          failSendJob(job.id, error.message || "Send failed.");
        }
      })();

      res.status(202).json({
        ok: true,
        setId,
        setName: set.name,
        jobId: job.id
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/spotify/search/artists", async (req, res) => {
      try {
        const query = String(req.query.q || "").trim();
        if (!query) {
          res.json([]);
        return;
      }
      res.json(await searchArtists(query));
    } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

  app.get("/api/spotify/search/albums", async (req, res) => {
      try {
        const query = String(req.query.q || "").trim();
        if (!query) {
          res.json([]);
          return;
        }
        res.json(await searchAlbums(query));
      } catch (error) {
        console.error("[spotify] album search error:", error.message);
        res.status(500).json({ error: error.message });
      }
    });

  app.get("/api/spotify/artists/:artistId/albums", async (req, res) => {
      try {
        const filter = String(req.query.filter || "album").trim() || "album";
        const offset = Math.max(0, Number.parseInt(String(req.query.offset || "0"), 10) || 0);
        const albums = await getArtistAlbumsPage(req.params.artistId, {
          filter,
          offset,
          limit: 10
        });
        res.json(albums);
      } catch (error) {
        console.error("[spotify] artist albums error:", error.message);
        res.status(500).json({ error: error.message });
      }
    });

  app.get("/api/spotify/playlists/:playlistId/albums", async (req, res) => {
    try {
      const albums = await getPlaylistAlbums(req.params.playlistId);
      res.json(albums);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/import/spotify/album", async (req, res) => {
    try {
      const albumId = parseSpotifyId(req.body.albumId || req.body.spotifyUrl || "");
      const album = await importSpotifyAlbum(albumId);
      res.json(album);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/import/spotify/playlist", async (req, res) => {
    try {
      const playlistId = parseSpotifyId(req.body.playlistId || req.body.spotifyUrl || "");
      const playlistAlbums = await getPlaylistAlbums(playlistId);
      const imported = [];
      for (const album of playlistAlbums.slice(0, 20)) {
        imported.push(await importSpotifyAlbum(album.id));
      }
      res.json(imported);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/studio/plugins/album-art/generate", async (req, res) => {
    try {
      const albumSlugs = Array.isArray(req.body.albumSlugs) ? req.body.albumSlugs.map((slug) => String(slug).trim()).filter(Boolean) : [];
      const templateId = String(req.body.templateId || "music-editorial-v1").trim();

      if (!albumSlugs.length) {
        res.status(400).json({ error: "Select at least one album to generate." });
        return;
      }

      const project = loadProjectFromStore();
      const baseScreen = project.screens[0] || DEFAULT_PROJECT.screens[0];
      const generatedScreens = [];

      for (const albumSlug of albumSlugs) {
        const album = loadAlbumBySlug(albumSlug);
        if (!album) {
          res.status(400).json({ error: `Album not found: ${albumSlug}` });
          return;
        }

        generatedScreens.push({
          ...structuredClone(baseScreen),
          id: `studio-${albumSlug}-${templateId}`.slice(0, 80),
          outputBaseName: buildStudioOutputBaseName("album-art", [album.artist, album.album, templateId]),
          name: `${album.artist} - ${album.album}`,
          enabled: false,
          template: templateId,
          albumSlug
        });
      }

      const renderConfig = {
        ...project,
        screens: generatedScreens
      };

      const results = await renderScreens({
        config: renderConfig,
        screens: generatedScreens,
        baseUrl: `http://${getRuntimeState().host}:${getRuntimeState().port}`,
        includeJpg: false
      });

      const images = await listOutputImages();
      const generated = results
        .map((result) => images.find((image) => image.name === `${result.outputBaseName}.png`))
        .filter(Boolean);

      res.json({
        ok: true,
        generated
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/actions/render", async (req, res) => {
    try {
      const project = loadProjectFromStore();
      const { selected, missing } = selectScreens(project, req.body.screenIds || []);
      if (missing.length) {
        res.status(400).json({ error: `Unknown or disabled screen ids: ${missing.join(", ")}` });
        return;
      }

      const results = await renderScreens({
        config: project,
        screens: selected,
        baseUrl: `http://${getRuntimeState().host}:${getRuntimeState().port}`
      });

      res.json({
        ok: true,
        action: "render",
        results
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/actions/send", async (req, res) => {
    try {
      const project = loadProjectFromStore();
      const { selected, missing } = selectScreens(project, req.body.screenIds || []);
      if (missing.length) {
        res.status(400).json({ error: `Unknown or disabled screen ids: ${missing.join(", ")}` });
        return;
      }

      const results = await sendScreens({
        screens: selected,
        dryRun: Boolean(req.body.dryRun)
      });

      if (!req.body.dryRun) {
        recordSentImages(results);
      }

      res.json({
        ok: true,
        action: "send",
        dryRun: Boolean(req.body.dryRun),
        results
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/actions/render-send", async (req, res) => {
    try {
      const project = loadProjectFromStore();
      const { selected, missing } = selectScreens(project, req.body.screenIds || []);
      if (missing.length) {
        res.status(400).json({ error: `Unknown or disabled screen ids: ${missing.join(", ")}` });
        return;
      }

      const renderResults = await renderScreens({
        config: project,
        screens: selected,
        baseUrl: `http://${getRuntimeState().host}:${getRuntimeState().port}`
      });
      const sendResults = await sendScreens({
        screens: selected,
        dryRun: Boolean(req.body.dryRun)
      });

      if (!req.body.dryRun) {
        recordSentImages(sendResults);
      }

      res.json({
        ok: true,
        action: "render-send",
        dryRun: Boolean(req.body.dryRun),
        renderResults,
        sendResults
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.use("/assets", express.static(path.join(rootDir, "assets"), { etag: false, maxAge: 0 }));
  app.use("/src", express.static(path.join(rootDir, "src"), { etag: false, maxAge: 0 }));
  app.use("/data", express.static(path.join(rootDir, "data"), { etag: false, maxAge: 0 }));
  app.use("/output", express.static(outputDir, { etag: false, maxAge: 0 }));

  app.get(/.*/, (req, res) => {
    res.sendFile(path.join(rootDir, "src", "index.html"));
  });

  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(port, host, () => resolve(listener));
    listener.on("error", reject);
  });
  const serverAddress = server.address();
  const resolvedPort = typeof serverAddress === "object" && serverAddress ? serverAddress.port : port;

  setRuntimeState({
    host,
    port: resolvedPort
  });

  return {
    host,
    port: resolvedPort,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  };
}

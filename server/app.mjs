import express from "express";
import path from "node:path";
import fs from "node:fs";
import { env } from "./env.mjs";
import { deleteImportedAlbums, listAllCatalogEntries, loadAlbumBySlug } from "./album-store.mjs";
import { loadDeviceStateFromStore, recordSentImages } from "./device-state-store.mjs";
import { loadProjectFromStore, saveProjectToStore } from "./project-store.mjs";
import { getArtistAlbums, getPlaylistAlbums, parseSpotifyId, searchArtists } from "./spotify-client.mjs";
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
import { sendImageToScreens, sendScreens } from "../scripts/lib/send-service.mjs";
import { DEFAULT_PROJECT } from "../src/default-project.js";

const rootDir = process.cwd();
const outputDir = path.join(rootDir, "output");
const outputImagePattern = /\.(png|jpe?g|webp)$/i;

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
        const stats = await fs.promises.stat(filePath);
        return {
          name: entry.name,
          url: `/output/${entry.name}`,
          size: stats.size,
          modifiedAt: stats.mtime.toISOString()
        };
      }),
  );

  images.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
  return images;
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

      const imagePath = path.resolve(outputDir, imageName);
      if (!imagePath.startsWith(path.resolve(outputDir) + path.sep)) {
        res.status(400).json({ error: "Invalid image path." });
        return;
      }

      await fs.promises.access(imagePath, fs.constants.R_OK);

      const project = loadProjectFromStore();
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
          finishSendJob(job.id);
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

  app.get("/api/spotify/artists/:artistId/albums", async (req, res) => {
    try {
      const albums = await getArtistAlbums(req.params.artistId);
      res.json(albums);
    } catch (error) {
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
  app.use("/output", express.static(path.join(rootDir, "output"), { etag: false, maxAge: 0 }));

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

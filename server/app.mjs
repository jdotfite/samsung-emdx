import express from "express";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import sharp from "sharp";
import { env } from "./env.mjs";
import { deleteImportedAlbums, listAllCatalogEntries, loadAlbumBySlug } from "./album-store.mjs";
import { loadContentSchedulesFromStore, saveContentSchedulesToStore } from "./content-schedule-store.mjs";
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
const CONTENT_SCHEDULE_KINDS = new Set(["image", "set"]);
const CONTENT_SCHEDULE_RECURRENCES = new Set(["once", "daily", "weekly"]);
const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function nowIso() {
  return new Date().toISOString();
}

function getDefaultTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York";
  } catch {
    return "America/New_York";
  }
}

function createLocalDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseLocalTimeMinutes(value) {
  if (!LOCAL_TIME_PATTERN.test(String(value || ""))) {
    return null;
  }
  const [hours, minutes] = String(value).split(":").map((part) => Number.parseInt(part, 10));
  return (hours * 60) + minutes;
}

function getCurrentLocalMinutes(date = new Date()) {
  return (date.getHours() * 60) + date.getMinutes();
}

function getLocalScheduleParts(date = new Date(), timeZone = getDefaultTimeZone()) {
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || getDefaultTimeZone(),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hourCycle: "h23"
    });
    const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
    const weekdayIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
    return {
      dateKey: `${parts.year}-${parts.month}-${parts.day}`,
      minutes: (Number(parts.hour) * 60) + Number(parts.minute),
      weekday: weekdayIndex >= 0 ? weekdayIndex : date.getDay()
    };
  } catch {
    return {
      dateKey: createLocalDateKey(date),
      minutes: getCurrentLocalMinutes(date),
      weekday: date.getDay()
    };
  }
}

function isScheduleJobStillRunning(schedule) {
  if (schedule?.lastStatus !== "queued" || !schedule.lastJobId) {
    return false;
  }
  const job = getSendJob(schedule.lastJobId);
  return job?.status === "queued" || job?.status === "running";
}

function sortSchedules(a, b) {
  const enabledDiff = Number(Boolean(b.enabled)) - Number(Boolean(a.enabled));
  if (enabledDiff !== 0) {
    return enabledDiff;
  }

  const updatedDiff = String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
  if (updatedDiff !== 0) {
    return updatedDiff;
  }

  return String(a.name || "").localeCompare(String(b.name || ""));
}

function normalizeStoredContentSchedule(raw = {}) {
  const kind = CONTENT_SCHEDULE_KINDS.has(String(raw.kind || "").trim()) ? String(raw.kind).trim() : "image";
  const recurrence = CONTENT_SCHEDULE_RECURRENCES.has(String(raw.recurrence || "").trim())
    ? String(raw.recurrence).trim()
    : "once";
  const enabled = raw.enabled !== false;
  const schedule = {
    id: String(raw.id || "").trim(),
    name: String(raw.name || "").trim(),
    kind,
    recurrence,
    enabled,
    imageName: kind === "image" ? String(raw.imageName || "").trim() : "",
    screenIds: kind === "image" && Array.isArray(raw.screenIds)
      ? [...new Set(raw.screenIds.map((id) => String(id || "").trim()).filter(Boolean))]
      : [],
    setId: kind === "set" ? String(raw.setId || "").trim() : "",
    runAt: recurrence === "once" ? String(raw.runAt || "").trim() : "",
    startDate: recurrence === "once" ? "" : String(raw.startDate || "").trim(),
    localTime: recurrence === "once" ? "" : String(raw.localTime || "").trim(),
    weekday: recurrence === "weekly" && Number.isInteger(raw.weekday) ? Number(raw.weekday) : null,
    timeZone: String(raw.timeZone || "").trim() || getDefaultTimeZone(),
    createdAt: String(raw.createdAt || "").trim() || nowIso(),
    updatedAt: String(raw.updatedAt || "").trim() || nowIso(),
    lastRunAt: String(raw.lastRunAt || "").trim(),
    lastRunKey: String(raw.lastRunKey || "").trim(),
    lastJobId: String(raw.lastJobId || "").trim(),
    lastStatus: String(raw.lastStatus || "").trim(),
    lastError: String(raw.lastError || "").trim()
  };

  if (!LOCAL_DATE_PATTERN.test(schedule.startDate)) {
    schedule.startDate = "";
  }
  if (!LOCAL_TIME_PATTERN.test(schedule.localTime)) {
    schedule.localTime = "";
  }
  if (schedule.recurrence !== "weekly") {
    schedule.weekday = null;
  }

  return schedule;
}

function listContentSchedules() {
  return loadContentSchedulesFromStore()
    .map((schedule) => normalizeStoredContentSchedule(schedule))
    .filter((schedule) => schedule.id)
    .sort(sortSchedules);
}

function saveContentSchedules(schedules) {
  return saveContentSchedulesToStore(
    schedules
      .map((schedule) => normalizeStoredContentSchedule(schedule))
      .filter((schedule) => schedule.id)
      .sort(sortSchedules),
  );
}

function getContentScheduleById(scheduleId) {
  return listContentSchedules().find((schedule) => schedule.id === scheduleId) || null;
}

function upsertContentSchedule(scheduleId, nextValue) {
  const schedules = listContentSchedules();
  const index = schedules.findIndex((schedule) => schedule.id === scheduleId);
  if (index === -1) {
    return null;
  }

  schedules[index] = normalizeStoredContentSchedule(nextValue);
  saveContentSchedules(schedules);
  return getContentScheduleById(scheduleId);
}

function updateContentScheduleRecord(scheduleId, updater) {
  const current = getContentScheduleById(scheduleId);
  if (!current) {
    return null;
  }

  const nextValue = typeof updater === "function"
    ? updater(structuredClone(current))
    : { ...current, ...(updater || {}) };
  return upsertContentSchedule(scheduleId, nextValue);
}

function deleteContentScheduleRecord(scheduleId) {
  const schedules = listContentSchedules();
  const nextSchedules = schedules.filter((schedule) => schedule.id !== scheduleId);
  if (nextSchedules.length === schedules.length) {
    return null;
  }

  saveContentSchedules(nextSchedules);
  return schedules.find((schedule) => schedule.id === scheduleId) || null;
}

function validateContentScheduleInput(input, { currentId = "" } = {}) {
  const project = loadProjectFromStore();
  const kind = CONTENT_SCHEDULE_KINDS.has(String(input?.kind || "").trim()) ? String(input.kind).trim() : "";
  if (!kind) {
    throw Object.assign(new Error("Choose whether this schedule sends a poster or a wall layout."), { statusCode: 400 });
  }

  const recurrence = CONTENT_SCHEDULE_RECURRENCES.has(String(input?.recurrence || "").trim())
    ? String(input.recurrence).trim()
    : "";
  if (!recurrence) {
    throw Object.assign(new Error("Choose a schedule frequency."), { statusCode: 400 });
  }

  const name = String(input?.name || "").trim();
  const enabled = input?.enabled !== false;
  const timeZone = String(input?.timeZone || "").trim() || getDefaultTimeZone();
  const createdAt = String(input?.createdAt || "").trim() || nowIso();
  const updatedAt = nowIso();

  const baseSchedule = {
    id: currentId || String(input?.id || "").trim(),
    name,
    kind,
    recurrence,
    enabled,
    imageName: "",
    screenIds: [],
    setId: "",
    runAt: "",
    startDate: "",
    localTime: "",
    weekday: null,
    timeZone,
    createdAt,
    updatedAt,
    lastRunAt: String(input?.lastRunAt || "").trim(),
    lastRunKey: String(input?.lastRunKey || "").trim(),
    lastJobId: String(input?.lastJobId || "").trim(),
    lastStatus: String(input?.lastStatus || "").trim(),
    lastError: String(input?.lastError || "").trim()
  };

  if (kind === "image") {
    const imageName = String(input?.imageName || "").trim();
    const screenIds = Array.isArray(input?.screenIds)
      ? [...new Set(input.screenIds.map((id) => String(id || "").trim()).filter(Boolean))]
      : [];

    if (!imageName) {
      throw Object.assign(new Error("Choose a poster to schedule."), { statusCode: 400 });
    }
    if (path.basename(imageName) !== imageName) {
      throw Object.assign(new Error("Invalid poster name."), { statusCode: 400 });
    }
    if (!screenIds.length) {
      throw Object.assign(new Error("Choose at least one target frame for this poster schedule."), { statusCode: 400 });
    }
    const validScreenIds = new Set((project?.screens || []).map((screen) => screen.id));
    const invalidScreenIds = screenIds.filter((screenId) => !validScreenIds.has(screenId));
    if (invalidScreenIds.length) {
      throw Object.assign(new Error(`Unknown target frames: ${invalidScreenIds.join(", ")}`), { statusCode: 400 });
    }

    baseSchedule.imageName = imageName;
    baseSchedule.screenIds = screenIds;
    if (!baseSchedule.name) {
      baseSchedule.name = imageName;
    }
  } else {
    const setId = String(input?.setId || "").trim();
    if (!setId) {
      throw Object.assign(new Error("Choose a wall layout to schedule."), { statusCode: 400 });
    }
    const hasSet = (project?.contentLibrary?.sets || []).some((set) => set.id === setId);
    if (!hasSet) {
      throw Object.assign(new Error("That wall layout no longer exists."), { statusCode: 400 });
    }
    baseSchedule.setId = setId;
    if (!baseSchedule.name) {
      baseSchedule.name = "Wall Layout";
    }
  }

  if (recurrence === "once") {
    const runAt = String(input?.runAt || "").trim();
    const parsed = new Date(runAt);
    if (!runAt || Number.isNaN(parsed.getTime())) {
      throw Object.assign(new Error("Choose a valid date and time."), { statusCode: 400 });
    }
    baseSchedule.runAt = parsed.toISOString();
  } else {
    const startDate = String(input?.startDate || "").trim();
    const localTime = String(input?.localTime || "").trim();
    if (!LOCAL_DATE_PATTERN.test(startDate)) {
      throw Object.assign(new Error("Choose a valid start date."), { statusCode: 400 });
    }
    if (!LOCAL_TIME_PATTERN.test(localTime)) {
      throw Object.assign(new Error("Choose a valid start time."), { statusCode: 400 });
    }

    baseSchedule.startDate = startDate;
    baseSchedule.localTime = localTime;

    if (recurrence === "weekly") {
      const weekday = Number.parseInt(String(input?.weekday ?? ""), 10);
      if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
        throw Object.assign(new Error("Choose a valid day for the weekly schedule."), { statusCode: 400 });
      }
      baseSchedule.weekday = weekday;
    }
  }

  return normalizeStoredContentSchedule(baseSchedule);
}

function getContentScheduleDueState(schedule, referenceDate = new Date()) {
  if (!schedule?.enabled) {
    return { due: false, runKey: "", reason: "disabled" };
  }

  if (schedule.recurrence === "once") {
    const runAt = new Date(schedule.runAt);
    if (Number.isNaN(runAt.getTime())) {
      return { due: false, runKey: "", reason: "invalid" };
    }
    if (["completed", "failed"].includes(schedule.lastStatus) || schedule.enabled === false) {
      return { due: false, runKey: "", reason: schedule.lastStatus === "failed" ? "failed" : "already-ran" };
    }
    if (isScheduleJobStillRunning(schedule)) {
      return { due: false, runKey: "once", reason: "queued" };
    }
    return {
      due: runAt.getTime() <= referenceDate.getTime(),
      runKey: "once",
      reason: runAt.getTime() <= referenceDate.getTime() ? "ready" : "future"
    };
  }

  if (!LOCAL_DATE_PATTERN.test(schedule.startDate) || !LOCAL_TIME_PATTERN.test(schedule.localTime)) {
    return { due: false, runKey: "", reason: "invalid" };
  }

  const localParts = getLocalScheduleParts(referenceDate, schedule.timeZone);
  const todayKey = localParts.dateKey;
  if (todayKey < schedule.startDate) {
    return { due: false, runKey: todayKey, reason: "before-start" };
  }

  if (schedule.recurrence === "weekly" && localParts.weekday !== schedule.weekday) {
    return { due: false, runKey: todayKey, reason: "wrong-day" };
  }

  const scheduledMinutes = parseLocalTimeMinutes(schedule.localTime);
  if (scheduledMinutes == null) {
    return { due: false, runKey: todayKey, reason: "invalid" };
  }

  if (schedule.lastRunKey === todayKey && ["queued", "completed", "failed"].includes(schedule.lastStatus)) {
    return {
      due: false,
      runKey: todayKey,
      reason: schedule.lastStatus === "queued" ? "queued" : schedule.lastStatus === "failed" ? "failed" : "already-ran"
    };
  }

  return {
    due: localParts.minutes >= scheduledMinutes,
    runKey: todayKey,
    reason: localParts.minutes >= scheduledMinutes ? "ready" : "future"
  };
}

function createContentScheduleRuntimePatch(schedule, { runKey, jobId = "", status, error = "" }) {
  const isCompleted = status === "completed";
  const timestamp = nowIso();
  return {
    ...schedule,
    enabled: schedule.recurrence === "once" && isCompleted ? false : schedule.enabled,
    updatedAt: timestamp,
    lastRunAt: isCompleted || status === "failed" ? timestamp : schedule.lastRunAt,
    lastRunKey: runKey || schedule.lastRunKey || "",
    lastJobId: jobId || schedule.lastJobId || "",
    lastStatus: status,
    lastError: error || ""
  };
}

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

function getCanonicalEditTarget(project) {
  return project?.screens?.find((screen) => screen.enabled && screen.size?.width && screen.size?.height)
    || project?.screens?.find((screen) => screen.size?.width && screen.size?.height)
    || DEFAULT_PROJECT.screens[0]
    || null;
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
  const targetScreen = getCanonicalEditTarget(project);
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

function getWallSortWeight(slot) {
  if (slot === "left") return 0;
  if (slot === "center") return 1;
  if (slot === "right") return 2;
  return 99;
}

function getDefaultSetSlot(index, total) {
  if (total === 1) return "center";
  if (total === 2) return ["left", "right"][index] || "";
  if (total === 3) return ["left", "center", "right"][index] || "";
  return "";
}

function getWallScreensBySlot(project, wallId, { enabledOnly = false } = {}) {
  return (project?.screens || [])
    .filter((screen) => screen.wallId === wallId && (!enabledOnly || screen.enabled))
    .sort((a, b) => {
      const weightDiff = getWallSortWeight(a.wallSlot) - getWallSortWeight(b.wallSlot);
      if (weightDiff !== 0) {
        return weightDiff;
      }
      return String(a.name || "").localeCompare(String(b.name || ""));
    });
}

function getContentSetMappingsForProject(project, set, { enabledOnly = false } = {}) {
  const items = Array.isArray(set?.items)
    ? [...set.items]
        .map((item, index) => ({
          imageName: String(item?.imageName || "").trim(),
          position: Number.isFinite(item?.position) ? Number(item.position) : index + 1,
          slot: String(item?.slot || "").trim()
        }))
        .filter((item) => item.imageName)
        .sort((a, b) => a.position - b.position)
        .map((item, index, all) => ({
          ...item,
          position: index + 1,
          slot: item.slot || getDefaultSetSlot(index, all.length)
        }))
    : [];

  const wallId = String(set?.wallId || "").trim();
  const wallScreens = wallId ? getWallScreensBySlot(project, wallId, { enabledOnly }) : [];
  const usedScreenIds = new Set();
  const mappings = items.map((item, index) => {
    const slot = item.slot || getDefaultSetSlot(index, items.length);
    const targetScreen = slot
      ? wallScreens.find((screen) => screen.wallSlot === slot && !usedScreenIds.has(screen.id)) || null
      : wallScreens.find((screen) => !usedScreenIds.has(screen.id)) || null;
    if (targetScreen) {
      usedScreenIds.add(targetScreen.id);
    }
    return {
      item,
      slot,
      targetScreen
    };
  });

  const issues = [];
  if (!wallId) {
    issues.push("Choose a target wall for this set.");
  }
  if (!items.length) {
    issues.push("Set has no items.");
  }

  for (const mapping of mappings) {
    if (mapping.targetScreen) {
      continue;
    }
    if (mapping.slot) {
      issues.push(`${mapping.slot} slot is not available on the selected wall.`);
    } else {
      issues.push(`Position ${mapping.item.position} does not have an available frame on the selected wall.`);
    }
  }

  return {
    mappings,
    issues,
    canSend: Boolean(wallId) && mappings.length > 0 && issues.length === 0
  };
}

function createSendJobDispatch({ imageName, screens, execute, scheduleId = "", runKey = "" }) {
  const job = createSendJob({
    imageName,
    screens
  });

  const updateScheduleAfterJob = ({ status, error = "" }) => {
    if (!scheduleId) {
      return;
    }
    updateContentScheduleRecord(scheduleId, (current) => createContentScheduleRuntimePatch(current, {
      runKey,
      jobId: job.id,
      status,
      error
    }));
  };

  markSendJobRunning(job.id);

  void (async () => {
    try {
      const results = await execute({
        onProgress: (screen, event) => {
          recordSendJobEvent(job.id, screen.id, event);
        }
      });

      for (const result of results) {
        completeSendJobTarget(job.id, result.screenId, result);
      }
      recordSentImages(results);

      const finalJob = getSendJob(job.id);
      const hasUnverified = finalJob?.targets.some((target) => target.status === "unverified");
      if (hasUnverified) {
        const message = "One or more frames did not confirm image receipt. Try waking the display and sending again.";
        failSendJob(job.id, message);
        updateScheduleAfterJob({ status: "failed", error: message });
      } else {
        finishSendJob(job.id);
        updateScheduleAfterJob({ status: "completed" });
      }
    } catch (error) {
      const message = error.message || "Send failed.";
      failSendJob(job.id, message);
      updateScheduleAfterJob({ status: "failed", error: message });
    }
  })();

  return job;
}

async function queueImageSend({ project, imageName, screenIds, scheduleId = "", runKey = "" }) {
  const normalizedName = String(imageName || "").trim();
  if (!normalizedName) {
    throw Object.assign(new Error("imageName is required."), { statusCode: 400 });
  }
  if (path.basename(normalizedName) !== normalizedName) {
    throw Object.assign(new Error("Invalid image path."), { statusCode: 400 });
  }

  const uniqueScreenIds = [...new Set((Array.isArray(screenIds) ? screenIds : []).map((id) => String(id || "").trim()).filter(Boolean))];
  if (!uniqueScreenIds.length) {
    throw Object.assign(new Error("No target devices selected."), { statusCode: 400 });
  }

  const screens = (project?.screens || []).filter((screen) => uniqueScreenIds.includes(screen.id) && screen.enabled);
  const missing = uniqueScreenIds.filter((id) => !screens.some((screen) => screen.id === id));
  if (missing.length) {
    throw Object.assign(new Error(`Unknown screen ids: ${missing.join(", ")}`), { statusCode: 400 });
  }

  const imagePath = await resolveContentImagePath(project, normalizedName);
  return createSendJobDispatch({
    imageName: normalizedName,
    screens,
    scheduleId,
    runKey,
    execute: ({ onProgress }) => sendImageToScreens({
      screens,
      imagePath,
      onProgress
    })
  });
}

async function queueSetSend({ project, setId, screenIds = [], scheduleId = "", runKey = "" }) {
  const normalizedSetId = String(setId || "").trim();
  if (!normalizedSetId) {
    throw Object.assign(new Error("setId is required."), { statusCode: 400 });
  }

  const set = (project?.contentLibrary?.sets || []).find((entry) => entry.id === normalizedSetId);
  if (!set) {
    throw Object.assign(new Error(`Set not found: ${normalizedSetId}`), { statusCode: 404 });
  }

  const items = Array.isArray(set.items)
    ? [...set.items].sort((a, b) => a.position - b.position)
    : [];
  if (!items.length) {
    throw Object.assign(new Error("Set has no items."), { statusCode: 400 });
  }

  let screens = [];
  const imagePathByScreenId = {};

  if (Array.isArray(screenIds) && screenIds.length) {
    const requestedIds = screenIds.map((id) => String(id || "").trim()).filter(Boolean);
    if (requestedIds.length !== items.length) {
      throw Object.assign(new Error(`Expected ${items.length} screenIds, got ${requestedIds.length}.`), { statusCode: 400 });
    }

    for (let index = 0; index < items.length; index += 1) {
      const screenId = requestedIds[index];
      const screen = (project?.screens || []).find((entry) => entry.id === screenId && entry.enabled);
      if (!screen) {
        throw Object.assign(new Error(`Unknown or disabled screen: ${screenId}`), { statusCode: 400 });
      }
      if (screens.some((entry) => entry.id === screen.id)) {
        throw Object.assign(new Error(`Screen ${screen.id} is mapped to multiple positions.`), { statusCode: 400 });
      }

      screens.push(screen);
      imagePathByScreenId[screen.id] = await resolveContentImagePath(project, items[index].imageName);
    }
  } else {
    const mapping = getContentSetMappingsForProject(project, set, { enabledOnly: true });
    if (!mapping.canSend) {
      throw Object.assign(new Error(mapping.issues[0] || "Finish the wall mapping before sending this set."), { statusCode: 400 });
    }

    for (const entry of mapping.mappings) {
      screens.push(entry.targetScreen);
      imagePathByScreenId[entry.targetScreen.id] = await resolveContentImagePath(project, entry.item.imageName);
    }
  }

  return createSendJobDispatch({
    imageName: `Set: ${set.name}`,
    screens,
    scheduleId,
    runKey,
    execute: ({ onProgress }) => sendImagesToScreens({
      screens,
      imagePathByScreenId,
      onProgress
    })
  });
}

async function executeDueContentSchedules() {
  const schedules = listContentSchedules();
  if (!schedules.length) {
    return;
  }
  for (const schedule of schedules) {
    const dueState = getContentScheduleDueState(schedule);
    if (!dueState.due) {
      continue;
    }

    try {
      const latest = getContentScheduleById(schedule.id);
      if (!latest) {
        continue;
      }
      const latestDueState = getContentScheduleDueState(latest);
      if (!latestDueState.due) {
        continue;
      }

      const project = loadProjectFromStore();
      const job = latest.kind === "set"
        ? await queueSetSend({ project, setId: latest.setId, scheduleId: latest.id, runKey: latestDueState.runKey })
        : await queueImageSend({
          project,
          imageName: latest.imageName,
          screenIds: latest.screenIds,
          scheduleId: latest.id,
          runKey: latestDueState.runKey
        });

      updateContentScheduleRecord(latest.id, (current) => {
        if (["completed", "failed"].includes(current.lastStatus) && current.lastJobId === job.id) {
          return current;
        }
        return createContentScheduleRuntimePatch(current, {
          runKey: latestDueState.runKey,
          jobId: job.id,
          status: "queued"
        });
      });
    } catch (error) {
      updateContentScheduleRecord(schedule.id, (current) => createContentScheduleRuntimePatch(current, {
        runKey: dueState.runKey,
        status: "failed",
        error: error.message || "Schedule failed."
      }));
    }
  }
}

function publicSpotifySettings(settings) {
  return {
    clientId: settings.clientId,
    market: settings.market,
    configured: Boolean(settings.configured),
    source: settings.source
  };
}

export async function startAppServer({ host = env.appHost, port = env.appPort } = {}) {
  getDb();
  let schedulePollRunning = false;

  const pollDueSchedules = async () => {
    if (schedulePollRunning) {
      return;
    }
    schedulePollRunning = true;
    try {
      await executeDueContentSchedules();
    } catch (error) {
      console.error("[content-schedules] poll failed:", error.message);
    } finally {
      schedulePollRunning = false;
    }
  };

  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });
  app.use(express.json({ limit: "2mb" }));
  app.use((req, res, next) => {
    if (!env.appAuthToken || req.path === "/api/health" || !req.path.startsWith("/api/")) {
      next();
      return;
    }
    const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const token = bearer || String(req.headers["x-app-token"] || "");
    if (token === env.appAuthToken) {
      next();
      return;
    }
    res.status(401).json({ error: "Authentication required." });
  });

  void pollDueSchedules();
  setInterval(() => {
    void pollDueSchedules();
  }, env.contentSchedulePollMs);

  app.get("/api/health", (req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/project", (req, res) => {
    res.json(loadProjectFromStore());
  });

  app.get("/api/device-state", (req, res) => {
    res.json(loadDeviceStateFromStore());
  });

  app.get("/api/content/schedules", (req, res) => {
    res.json(listContentSchedules());
  });

  app.post("/api/content/schedules", (req, res) => {
    try {
      const schedule = validateContentScheduleInput({
        ...req.body,
        id: crypto.randomUUID()
      });
      saveContentSchedules([...listContentSchedules(), schedule]);
      res.status(201).json(schedule);
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.message });
    }
  });

  app.put("/api/content/schedules/:scheduleId", (req, res) => {
    try {
      const current = getContentScheduleById(req.params.scheduleId);
      if (!current) {
        res.status(404).json({ error: "Schedule not found." });
        return;
      }

      const nextSchedule = validateContentScheduleInput({
        ...current,
        ...req.body,
        id: current.id,
        createdAt: current.createdAt,
        lastRunAt: current.lastRunAt,
        lastRunKey: current.lastRunKey,
        lastJobId: current.lastStatus === "failed" ? "" : current.lastJobId,
        lastStatus: current.lastStatus === "failed" ? "" : current.lastStatus,
        lastError: ""
      }, { currentId: current.id });
      const saved = upsertContentSchedule(current.id, nextSchedule);
      res.json(saved);
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.message });
    }
  });

  app.delete("/api/content/schedules/:scheduleId", (req, res) => {
    const deleted = deleteContentScheduleRecord(req.params.scheduleId);
    if (!deleted) {
      res.status(404).json({ error: "Schedule not found." });
      return;
    }
    res.json({ ok: true, deleted });
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
    res.json(publicSpotifySettings(loadSpotifySettingsFromStore()));
  });

  app.put("/api/studio/plugins/album-art/settings", (req, res) => {
    try {
      res.json(publicSpotifySettings(saveSpotifySettingsToStore(req.body || {})));
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
      const expectedFormatByType = {
        "image/jpeg": "jpeg",
        "image/jpg": "jpeg",
        "image/png": "png",
        "image/webp": "webp"
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

      try {
        const metadata = await sharp(req.body, { limitInputPixels: 40_000_000 }).metadata();
        if (!metadata.width || !metadata.height || !["jpeg", "png", "webp"].includes(metadata.format)) {
          res.status(400).json({ error: "Invalid or unsupported image data." });
          return;
        }
        if (metadata.format !== expectedFormatByType[contentType]) {
          res.status(400).json({ error: "Image bytes do not match the declared content type." });
          return;
        }
      } catch {
        res.status(400).json({ error: "Invalid or unsupported image data." });
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

  app.get("/api/content/items/:imageName/preview", async (req, res) => {
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

      const project = loadProjectFromStore();
      const targetScreen = getCanonicalEditTarget(project);
      let rawRecipe = null;
      if (typeof req.query.recipe === "string" && req.query.recipe.trim()) {
        rawRecipe = JSON.parse(req.query.recipe);
      }

      const buffer = await applyEditRecipe(sourcePath, rawRecipe, {
        targetWidth: targetScreen?.size?.width || null,
        targetHeight: targetScreen?.size?.height || null,
        outputFormat: "png"
      });

      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "no-store");
      res.send(buffer);
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
      const targetScreen = getCanonicalEditTarget(project);
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
      const project = loadProjectFromStore();
      const job = await queueImageSend({
        project,
        imageName: req.body.imageName,
        screenIds: req.body.screenIds
      });

      res.status(202).json({
        ok: true,
        imageName: String(req.body.imageName || "").trim(),
        jobId: job.id
      });
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.message });
    }
  });

  app.post("/api/content/send-set", async (req, res) => {
    try {
      const project = loadProjectFromStore();
      const setId = String(req.body.setId || "").trim();
      const set = (project.contentLibrary?.sets || []).find((entry) => entry.id === setId);
      const job = await queueSetSend({
        project,
        setId,
        screenIds: req.body.screenIds
      });

      res.status(202).json({
        ok: true,
        setId,
        setName: set?.name || "Set",
        jobId: job.id
      });
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.message });
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
  app.use("/data", (req, res) => {
    res.status(404).json({ error: "Not found" });
  });
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

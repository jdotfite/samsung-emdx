import { apiGetJson, apiPostJson, apiPutJson, apiUploadImage } from "./api.js";
import { DEFAULT_PROJECT } from "./default-project.js";
import { getStudioPluginById, STUDIO_PLUGINS } from "./plugin-registry.js";
import { getTemplateById, TEMPLATE_REGISTRY } from "./template-registry.js";
import { normalizeMusicAlbum } from "./template-utils.js";

const STORAGE_KEY = "poster-wall-project-v3";
const UI_STORAGE_KEY = "poster-wall-ui-v1";
const app = document.getElementById("app");
let sendFlowPollTimer = null;

const state = {
  project: null,
  catalog: [],
  albums: new Map(),
  deviceState: {},
  deviceDiagnostics: {},
  outputImages: [],
  outputDirectory: "",
  actions: {
    notice: "",
    error: ""
  },
  ui: {
    modal: null,
    screenId: null,
    screenDraft: null,
    pendingDeleteNames: [],
    pendingImportedDeleteSlugs: [],
    previewImageName: "",
    section: "devices",
    studioView: "directory",
    studioPluginId: STUDIO_PLUGINS[0]?.id || "",
    contentScreenId: null,
    contentBroadcastIds: [],
    contentSelectedImage: "",
    contentReplaceImage: "",
    contentManageMode: false,
    contentManageSelections: [],
    sendFlow: null,
    spotifySettingsDraft: null
  },
  discovery: {
    loading: false,
    error: "",
    network: null,
    results: []
  },
  spotify: {
    artistQuery: "",
    playlistQuery: "",
    artistView: "results",
    artistResults: [],
    artistAlbums: [],
    selectedArtistName: "",
    notice: "",
    error: ""
  },
  spotifySettings: {
    clientId: "",
    clientSecret: "",
    market: "US",
    configured: false,
    source: "env"
  },
  studio: {
    albumArt: {
      importCollapsed: false,
      filterQuery: "",
      selectedSlugs: [],
      recentImportedSlugs: [],
      templateId: "music-editorial-v1",
      generatedImageNames: []
    }
  }
};

init().catch((error) => {
  app.innerHTML = `<pre style="padding:40px;font:16px/1.5 'IBM Plex Mono', monospace;">${error.message}</pre>`;
  console.error(error);
});

async function init() {
  const [catalog, project, deviceState, outputPayload, spotifySettings] = await Promise.all([
    loadCatalog(),
    loadProject(),
    loadDeviceState(),
    loadOutputImages(),
    loadSpotifySettings()
  ]);
  state.catalog = catalog;
  state.project = normalizeProject(project);
  state.deviceState = deviceState;
  state.outputImages = outputPayload.images || [];
  state.outputDirectory = outputPayload.directory || "";
  state.spotifySettings = normalizeSpotifySettings(spotifySettings);
  applyStoredUiState();
  const initialSlugs = new Set(state.project.screens.map((screen) => screen.albumSlug).filter(Boolean));
  if (state.ui.section === "studio" && state.ui.studioView === "workspace" && state.ui.studioPluginId === "album-art-generator") {
    state.catalog.forEach((entry) => initialSlugs.add(entry.slug));
  }
  await ensureAlbums([...initialSlugs]);

  const params = new URLSearchParams(window.location.search);
  if (params.get("view") === "render") {
    renderSingleScreen(params.get("screen"));
    return;
  }

  renderWorkspace();
  void refreshDeviceStatuses({ silent: true });
}

function normalizeSpotifySettings(settings = {}) {
  return {
    clientId: String(settings.clientId || "").trim(),
    clientSecret: String(settings.clientSecret || "").trim(),
    market: String(settings.market || "US").trim().toUpperCase() || "US",
    configured: Boolean(settings.configured ?? (settings.clientId && settings.clientSecret)),
    source: settings.source || "env"
  };
}

function applyStoredUiState() {
  try {
    const raw = localStorage.getItem(UI_STORAGE_KEY);
    if (!raw) {
      return;
    }
    const parsed = JSON.parse(raw);
    if (["devices", "content", "studio"].includes(parsed.section)) {
      state.ui.section = parsed.section;
    }
    if (["directory", "workspace"].includes(parsed.studioView)) {
      state.ui.studioView = parsed.studioView;
    }
    if (parsed.studioPluginId && getStudioPluginById(parsed.studioPluginId)) {
      state.ui.studioPluginId = parsed.studioPluginId;
    }
  } catch {}
}

function persistUiState() {
  try {
    localStorage.setItem(
      UI_STORAGE_KEY,
      JSON.stringify({
        section: state.ui.section,
        studioView: state.ui.studioView,
        studioPluginId: state.ui.studioPluginId
      }),
    );
  } catch {}
}

function normalizeProject(project) {
  const base = structuredClone(DEFAULT_PROJECT);
  return {
    ...base,
    ...project,
    screens: (project.screens || base.screens).map((screen, index) => ({
      ...structuredClone(base.screens[index % base.screens.length]),
      ...screen,
      size: { ...base.screens[0].size, ...(screen.size || {}) },
      frame: { ...base.screens[0].frame, ...(screen.frame || {}) },
      device: { ...base.screens[0].device, ...(screen.device || {}) }
    }))
  };
}

async function loadCatalog() {
  try {
    return await apiGetJson("/api/catalog");
  } catch {
    const response = await fetch("/data/albums/catalog.json");
    return response.ok ? response.json() : [];
  }
}

async function loadProject() {
  const params = new URLSearchParams(window.location.search);
  const encoded = params.get("state");
  if (encoded) {
    return JSON.parse(decodeBase64Url(encoded));
  }

  try {
    return await apiGetJson("/api/project");
  } catch {
    const localState = localStorage.getItem(STORAGE_KEY);
    if (localState) {
      return JSON.parse(localState);
    }
    return structuredClone(DEFAULT_PROJECT);
  }
}

async function loadDeviceState() {
  try {
    return await apiGetJson("/api/device-state");
  } catch {
    return {};
  }
}

async function loadOutputImages() {
  try {
    return await apiGetJson("/api/output-images");
  } catch {
    return { directory: "", images: [] };
  }
}

async function loadSpotifySettings() {
  try {
    return await apiGetJson("/api/studio/plugins/album-art/settings");
  } catch {
    return {
      clientId: "",
      clientSecret: "",
      market: "US",
      configured: false,
      source: "env"
    };
  }
}

async function ensureAlbums(slugs) {
  const unique = [...new Set(slugs.filter(Boolean))];
  await Promise.all(
    unique.map(async (slug) => {
      if (state.albums.has(slug)) {
        return;
      }
      const album = await apiGetJson(`/api/albums/${slug}`);
      state.albums.set(slug, normalizeMusicAlbum({ ...album, slug }));
    }),
  );
}

function getAlbum(slug) {
  return state.albums.get(slug);
}

async function refreshCatalogAndAlbums(slugs = []) {
  state.catalog = await loadCatalog();
  await ensureAlbums(slugs);
}

function persistProject() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.project, null, 2));
  apiPutJson("/api/project", state.project).catch((error) => {
    console.error(error);
  });
}

function renderSingleScreen(screenId) {
  const screen = state.project.screens.find((entry) => entry.id === screenId) || state.project.screens[0];
  const album = getAlbum(screen.albumSlug);
  const markup = renderPosterMarkup(screen, album);
  app.innerHTML = `<main class="render-shell"><div id="render-root">${markup}</div></main>`;
}

function renderPosterMarkup(screen, album) {
  const template = getTemplateById(screen.template);
  if (!template) {
    return `<article class="poster" style="--poster-width:${screen.size.width}px;--poster-height:${screen.size.height}px;display:grid;place-items:center;">Template not found: ${screen.template}</article>`;
  }
  if (!album) {
    return `<article class="poster" style="--poster-width:${screen.size.width}px;--poster-height:${screen.size.height}px;display:grid;place-items:center;">Album not found: ${screen.albumSlug}</article>`;
  }
  return template.render({ screen, album });
}

function createTemplateOptions(selectedId) {
  return TEMPLATE_REGISTRY.map(
    (template) => `<option value="${template.id}" ${template.id === selectedId ? "selected" : ""}>${template.name}</option>`,
  ).join("");
}

function createAlbumOptions(selectedSlug) {
  return state.catalog
    .map(
      (album) => `<option value="${album.slug}" ${album.slug === selectedSlug ? "selected" : ""}>${album.artist} - ${album.album}</option>`,
    )
    .join("");
}

function formatDateTime(value) {
  if (!value) {
    return "Never sent";
  }

  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function getDevicePreview(screen) {
  const sent = state.deviceState[screen.id];
  if (sent?.imageUrl) {
    const version = sent.sentAt ? `?t=${encodeURIComponent(sent.sentAt)}` : "";
    return {
      url: `${sent.imageUrl}${version}`,
      label: `Last sent ${formatDateTime(sent.sentAt)}`
    };
  }

  return null;
}

function getDeviceDiagnostic(screenId) {
  return state.deviceDiagnostics[screenId] || {
    loading: false,
    waking: false,
    error: "",
    status: null
  };
}

function getDeviceCardMeta(screenId) {
  const diagnostic = getDeviceDiagnostic(screenId);
  if (diagnostic.loading && !diagnostic.status) {
    return "Checking device...";
  }
  if (diagnostic.status?.battery?.batteryPercent != null) {
    return `Battery ${diagnostic.status.battery.batteryPercent}%${diagnostic.status.battery.pluggedIn ? " / Plugged in" : ""}`;
  }
  if (diagnostic.status?.reachable) {
    return diagnostic.status.deviceName || "Reachable";
  }
  if (diagnostic.error || diagnostic.status?.error) {
    return "Status unavailable";
  }
  return "No live status yet";
}

function summarizeDeviceStatus(status) {
  if (!status) {
    return {
      title: "No live status checked yet",
      detail: "Use Check Status or Wake to ask the frame directly."
    };
  }

  const title = status.powerState ? `Power ${status.powerState}` : status.reachable ? "Reachable" : "Unreachable";
  const details = [];

  if (status.deviceName) {
    details.push(status.deviceName);
  }
  if (status.serialNumber) {
    details.push(`S/N ${status.serialNumber}`);
  }
  if (typeof status.latencyMs === "number") {
    details.push(`${status.latencyMs} ms`);
  }
  if (status.battery?.batteryPercent != null) {
    details.push(`${status.battery.batteryPercent}% battery`);
  }
  if (status.error) {
    details.push(status.error);
  }
  if (status.checkedAt) {
    details.push(`Checked ${formatDateTime(status.checkedAt)}`);
  }

  return {
    title,
    detail: details.join(" / ") || "Live response received from the frame."
  };
}

function createDeviceStatusMarkup(screenId, options = {}) {
  const diagnostic = getDeviceDiagnostic(screenId);
  let title = "No live status checked yet";
  let detail = "Use Check Status or Wake to ask the frame directly.";
  let classes = "device-live-status";

  if (diagnostic.loading) {
    title = "Checking status";
    detail = "Waiting for the frame to respond.";
    classes += " is-busy";
  } else if (diagnostic.waking) {
    title = "Waking device";
    detail = "Sending Wake-on-LAN and probing the frame.";
    classes += " is-busy";
  } else if (diagnostic.error) {
    title = "Status unavailable";
    detail = diagnostic.error;
    classes += " is-error";
  } else if (diagnostic.status) {
    const summary = summarizeDeviceStatus(diagnostic.status);
    title = summary.title;
    detail = summary.detail;
  }

  return `
    <div class="${classes} ${options.compact ? "is-compact" : ""}">
      <span class="device-summary-kicker">Live Status</span>
      <strong>${title}</strong>
      <span>${detail}</span>
    </div>
  `;
}

function getWakeGlyph(screenId) {
  const diagnostic = getDeviceDiagnostic(screenId);
  if (diagnostic.loading || diagnostic.waking) {
    return "wake";
  }
  return diagnostic.status?.reachable ? "wake" : "moon";
}

function createDeviceUtilityActions(screenId, options = {}) {
  const diagnostic = getDeviceDiagnostic(screenId);
  const isBusy = diagnostic.loading || diagnostic.waking;
  const compact = Boolean(options.compact);
  return `
    <div class="device-utility-row ${compact ? "is-compact" : ""}">
      <button
        type="button"
        class="secondary device-utility-button"
        data-action="check-device-status"
        data-screen-id="${screenId}"
        aria-label="Check device status"
        title="Check device status"
        ${isBusy ? "disabled" : ""}
      >
        ${iconSvg("status")}
        ${compact ? "" : `<span>${diagnostic.loading ? "Checking" : "Status"}</span>`}
      </button>
      <button
        type="button"
        class="secondary device-utility-button"
        data-action="wake-device"
        data-screen-id="${screenId}"
        aria-label="Wake device"
        title="Wake device"
        ${isBusy ? "disabled" : ""}
      >
        ${iconSvg(getWakeGlyph(screenId))}
        ${compact ? "" : `<span>${diagnostic.waking ? "Waking" : "Wake"}</span>`}
      </button>
    </div>
  `;
}

function getContentTargetIds() {
  const ids = new Set();
  if (state.ui.contentScreenId) {
    ids.add(state.ui.contentScreenId);
  }
  for (const id of state.ui.contentBroadcastIds) {
    ids.add(id);
  }
  return [...ids];
}

function getContentTargetScreens() {
  const ids = getContentTargetIds();
  return state.project.screens.filter((screen) => screen.enabled && ids.includes(screen.id));
}

function stopSendFlowPolling() {
  if (sendFlowPollTimer) {
    clearInterval(sendFlowPollTimer);
    sendFlowPollTimer = null;
  }
}

function createPendingSendFlow({ imageName, targetNames }) {
  return {
    active: true,
    jobId: "",
    imageName,
    targetNames,
    status: "starting",
    stage: "queued",
    error: "",
    targets: [],
    progress: 4,
    steps: [
      { title: "Preparing delivery", detail: "Validating the selected image and target frames.", state: "active" },
      { title: "Waking displays", detail: "Sending Wake-on-LAN to configured frames.", state: "pending" },
      { title: "Sending command", detail: "Connecting over MDC and setting the content URL.", state: "pending" },
      { title: "Frame fetch", detail: "Waiting for the frame to request content.json and the image.", state: "pending" },
      { title: "Verified", detail: "Confirming the image request completed.", state: "pending" }
    ]
  };
}

function computeSendFlowStepState(job) {
  const targets = job.targets || [];
  const all = (predicate) => targets.length > 0 && targets.every(predicate);
  const any = (predicate) => targets.some(predicate);
  const failed = job.status === "failed";

  const prepared = job.status !== "queued";
  const woke = any((target) => target.milestones?.wakeSent);
  const contentSet = any((target) => target.milestones?.contentSet);
  const contentFetched = any((target) => target.milestones?.contentJsonFetched);
  const imageFetched = all((target) => target.milestones?.imageFetched);

  const steps = [
    { title: "Preparing delivery", detail: "Validating the selected image and target frames." },
    { title: "Waking displays", detail: "Sending Wake-on-LAN to configured frames." },
    { title: "Sending command", detail: "Connecting over MDC and setting the content URL." },
    { title: "Frame fetch", detail: "Waiting for the frame to request content.json and the image." },
    { title: "Verified", detail: "Image fetch completed by every selected frame." }
  ];

  const completion = [prepared, woke || !targets.some((target) => target.host), contentSet, contentFetched, imageFetched];
  const firstIncomplete = completion.findIndex((value) => !value);

  return steps.map((step, index) => {
    if (failed && index === (firstIncomplete === -1 ? 0 : firstIncomplete)) {
      return { ...step, state: "error" };
    }
    if (completion[index]) {
      return { ...step, state: "complete" };
    }
    if (job.status === "completed" && index <= 4) {
      return { ...step, state: "complete" };
    }
    return { ...step, state: index === (firstIncomplete === -1 ? 0 : firstIncomplete) ? "active" : "pending" };
  });
}

function computeSendFlowProgress(job) {
  const targets = job.targets || [];
  if (job.status === "completed") {
    return 100;
  }
  if (job.status === "failed") {
    const anyFetched = targets.some((target) => target.milestones?.imageFetched);
    return anyFetched ? 88 : 52;
  }

  const points = [
    job.status !== "queued",
    targets.some((target) => target.milestones?.wakeSent),
    targets.some((target) => target.milestones?.contentSet),
    targets.some((target) => target.milestones?.contentJsonFetched),
    targets.every((target) => target.milestones?.imageFetched)
  ];
  const completed = points.filter(Boolean).length;
  return Math.max(6, Math.min(96, 8 + completed * 22));
}

function syncSendFlowFromJob(job) {
  const flow = state.ui.sendFlow || {};
  state.ui.sendFlow = {
    ...flow,
    active: true,
    jobId: job.id,
    imageName: job.imageName,
    targetNames: job.targets.map((target) => target.name),
    status: job.status,
    stage: job.stage,
    error: job.error || "",
    targets: job.targets,
    progress: computeSendFlowProgress(job),
    steps: computeSendFlowStepState(job)
  };
}

async function pollSendFlowJob(jobId, { immediate = false } = {}) {
  const poll = async () => {
    try {
      const job = await apiGetJson(`/api/send-jobs/${jobId}`);
      syncSendFlowFromJob(job);
      if (job.status === "completed") {
        state.deviceState = await loadDeviceState();
      }
      renderWorkspace();

      if (job.status === "completed" || job.status === "failed") {
        stopSendFlowPolling();
      }
    } catch (error) {
      stopSendFlowPolling();
      state.ui.sendFlow = {
        ...(state.ui.sendFlow || {}),
        active: true,
        jobId,
        status: "failed",
        error: error.message,
        progress: 12,
        steps: (state.ui.sendFlow?.steps || []).map((step, index) => ({
          ...step,
          state: index === 0 ? "error" : "pending"
        }))
      };
      renderWorkspace();
    }
  };

  stopSendFlowPolling();
  if (immediate) {
    await poll();
  }
  sendFlowPollTimer = setInterval(() => {
    void poll();
  }, 1000);
}

function resetContentUi() {
  state.ui.contentScreenId = null;
  state.ui.contentBroadcastIds = [];
  state.ui.contentSelectedImage = "";
  state.ui.contentReplaceImage = "";
  state.ui.contentManageMode = false;
  state.ui.contentManageSelections = [];
}

function scrollToElement(selector, { behavior = "smooth", block = "start" } = {}) {
  requestAnimationFrame(() => {
    document.querySelector(selector)?.scrollIntoView({ behavior, block });
  });
}

function cloneScreen(screen) {
  return structuredClone(screen);
}

function formatBytes(value) {
  if (!value) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function createSectionTabs() {
  const sections = [
    { id: "devices", label: "Devices" },
    { id: "content", label: "Content" },
    { id: "studio", label: "Studio" }
  ];

  return `
    <nav class="section-tabs" aria-label="Sections">
      ${sections
        .map(
          (section) => `
            <button
              type="button"
              class="section-tab ${state.ui.section === section.id ? "is-active" : ""}"
              data-action="open-section"
              data-section="${section.id}"
            >
              ${section.label}
            </button>
          `,
        )
        .join("")}
    </nav>
  `;
}

function iconSvg(type) {
  const icons = {
    plus: `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 5v14M5 12h14" />
      </svg>
    `,
    replace: `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 7h11" />
        <path d="M11 4l4 3-4 3" />
        <path d="M20 17H9" />
        <path d="m13 14-4 3 4 3" />
      </svg>
    `,
    upload: `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 16V5" />
        <path d="m8 9 4-4 4 4" />
        <path d="M5 19h14" />
      </svg>
    `,
    manage: `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 7h8" />
        <path d="M16 7h4" />
        <path d="M4 17h4" />
        <path d="M12 17h8" />
        <circle cx="14" cy="7" r="2" />
        <circle cx="10" cy="17" r="2" />
      </svg>
    `,
    search: `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m21 21-4.35-4.35" />
        <circle cx="11" cy="11" r="6" />
      </svg>
    `,
    settings: `
      <svg viewBox="0 0 24 24" aria-hidden="true" class="icon-fill">
        <path d="m9.25 22l-.4-3.2q-.325-.125-.612-.3t-.563-.375L4.7 19.375l-2.75-4.75l2.575-1.95Q4.5 12.5 4.5 12.338v-.675q0-.163.025-.338L1.95 9.375l2.75-4.75l2.975 1.25q.275-.2.575-.375t.6-.3l.4-3.2h5.5l.4 3.2q.325.125.613.3t.562.375l2.975-1.25l2.75 4.75l-2.575 1.95q.025.175.025.338v.674q0 .163-.05.338l2.575 1.95l-2.75 4.75l-2.95-1.25q-.275.2-.575.375t-.6.3l-.4 3.2zm2.8-6.5q1.45 0 2.475-1.025T15.55 12t-1.025-2.475T12.05 8.5q-1.475 0-2.488 1.025T8.55 12t1.013 2.475T12.05 15.5" />
      </svg>
    `,
    controls: `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 6h16M4 12h16M4 18h16M8 6a2 2 0 1 1 0 0M16 12a2 2 0 1 1 0 0M10 18a2 2 0 1 1 0 0" />
      </svg>
    `,
    status: `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 20a8 8 0 1 0-8-8" />
        <path d="M12 8v4l2.5 2.5" />
      </svg>
    `,
    wake: `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M13 2L6 14h5l-1 8 8-12h-5z" />
      </svg>
    `,
    moon: `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M20 14.5A7.5 7.5 0 0 1 9.5 4A8.5 8.5 0 1 0 20 14.5" />
      </svg>
    `,
    close: `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 6l12 12M18 6 6 18" />
      </svg>
    `,
    zoom: `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M15 3h6v6" />
        <path d="M9 21H3v-6" />
        <path d="M21 3l-7 7" />
        <path d="M3 21l7-7" />
      </svg>
    `,
    up: `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m12 6-5 5" />
        <path d="m12 6 5 5" />
        <path d="M12 6v12" />
      </svg>
    `,
    down: `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m12 18-5-5" />
        <path d="m12 18 5-5" />
        <path d="M12 6v12" />
      </svg>
    `
  };

  return icons[type] || "";
}

function createScreenForm(screen) {
  return `
    <section class="screen-form screen-form--modal" data-screen-id="${screen.id}">
      <div class="screen-card-header">
        <div class="screen-card-title">
          <h3>${screen.name}</h3>
          <p>${screen.device.host || "No host configured"}</p>
        </div>
      </div>
      <div class="screen-card-tools">
        <div class="screen-card-actions">
          <label class="toggle toggle--inline">
            <input type="checkbox" data-path="enabled" ${screen.enabled ? "checked" : ""} />
            Available for sends
          </label>
          <button type="button" class="secondary" data-action="duplicate-screen" data-screen-id="${screen.id}">Duplicate</button>
          <button type="button" class="secondary" data-action="remove-screen" data-screen-id="${screen.id}">Remove</button>
        </div>
      </div>

      <div class="field-row">
        <label>
          Device Name
          <input type="text" data-path="name" value="${screen.name}" />
        </label>
        <label>
          Device Host
          <input type="text" data-path="device.host" value="${screen.device.host}" />
        </label>
      </div>

      <div class="field-row field-row--three">
        <label>
          Device PIN
          <input type="text" data-path="device.pin" value="${screen.device.pin}" />
        </label>
        <label>
          Device MAC
          <input type="text" data-path="device.mac" value="${screen.device.mac}" />
        </label>
        <label>
          Local IP
          <input type="text" data-path="device.localIp" value="${screen.device.localIp || ""}" />
        </label>
      </div>
    </section>
  `;
}

function createPreviewCard(screen) {
  const preview = getDevicePreview(screen);
  const screenIndex = state.project.screens.findIndex((entry) => entry.id === screen.id);
  const isFirst = screenIndex <= 0;
  const isLast = screenIndex === state.project.screens.length - 1;

  return `
    <article class="preview-card device-card">
      <div class="preview-card-header">
        <div>
          <h3>${screen.name}</h3>
          <p>${getDeviceCardMeta(screen.id)}</p>
        </div>
        <div class="preview-head-tools">
          <button
            type="button"
            class="icon-button icon-button--ghost icon-button--small"
            data-action="move-screen-up"
            data-screen-id="${screen.id}"
            aria-label="Move ${screen.name} earlier"
            title="Move earlier"
            ${isFirst ? "disabled" : ""}
          >
            ${iconSvg("up")}
          </button>
          <button
            type="button"
            class="icon-button icon-button--ghost icon-button--small"
            data-action="move-screen-down"
            data-screen-id="${screen.id}"
            aria-label="Move ${screen.name} later"
            title="Move later"
            ${isLast ? "disabled" : ""}
          >
            ${iconSvg("down")}
          </button>
          <button
            type="button"
            class="icon-button icon-button--ghost"
            data-action="open-screen-modal"
            data-screen-id="${screen.id}"
            aria-label="Edit ${screen.name}"
            title="Edit ${screen.name}"
          >
            ${iconSvg("controls")}
          </button>
        </div>
      </div>
      <div class="device-preview">
        ${
          preview
            ? `<img class="device-preview-image" src="${preview.url}" alt="Last image sent to ${screen.name}" />`
            : `<div class="device-preview-placeholder">No image sent from this app yet.</div>`
        }
      </div>
      ${createDeviceStatusMarkup(screen.id, { compact: true })}
      <div class="device-card-footer">
        ${createDeviceUtilityActions(screen.id, { compact: true })}
        <button type="button" class="device-content-button" data-action="open-content" data-screen-id="${screen.id}">
          Change Content
        </button>
      </div>
    </article>
  `;
}

function createOutputImageCard(image) {
  const isManageMode = state.ui.contentManageMode;
  const isSelected = isManageMode
    ? state.ui.contentManageSelections.includes(image.name)
    : state.ui.contentSelectedImage === image.name;
  return `
    <article
      class="output-card ${isSelected ? "is-selected" : ""} ${isManageMode ? "is-manage-mode" : ""}"
      data-image-name="${image.name}"
    >
      ${
        !isManageMode
          ? `
            <button
              type="button"
              class="icon-button icon-button--ghost icon-button--small output-card-preview-button"
              data-action="open-content-preview"
              data-image-name="${image.name}"
              aria-label="Preview ${image.name}"
              title="Preview image"
            >
              ${iconSvg("zoom")}
            </button>
          `
          : ""
      }
      <button
        type="button"
        class="output-card-hit"
        data-action="select-content-image"
        data-image-name="${image.name}"
      >
      ${isManageMode ? `<span class="output-card-select ${isSelected ? "is-selected" : ""}"></span>` : ""}
      <div class="output-card-preview">
        <img src="${image.url}?t=${encodeURIComponent(image.modifiedAt)}" alt="${image.name}" />
      </div>
      <div class="output-card-copy">
        <strong>${image.name}</strong>
        <span>${formatDateTime(image.modifiedAt)} / ${formatBytes(image.size)}</span>
      </div>
      </button>
    </article>
  `;
}

function createTargetDeviceButton(screen) {
  const isPrimary = screen.id === state.ui.contentScreenId;
  const isSelected = getContentTargetIds().includes(screen.id);
  return `
    <button
      type="button"
      class="broadcast-chip ${isSelected ? "is-selected" : ""} ${isPrimary ? "is-primary" : ""}"
      data-action="toggle-content-target"
      data-screen-id="${screen.id}"
    >
      <strong>${screen.name}</strong>
      <span>${screen.device.host || "No host"}</span>
    </button>
  `;
}

function createContentActionBar() {
  if (state.ui.section !== "content") {
    return "";
  }

  if (state.ui.contentManageMode) {
    const count = state.ui.contentManageSelections.length;
    return `
      <div class="content-action-bar">
        <div class="content-footer-copy">
          <span class="device-summary-kicker">Manage Images</span>
          <strong>${count ? `${count} selected` : "No images selected"}</strong>
          <span>${count ? "Delete selected output files." : "Tap images to select them for deletion."}</span>
        </div>
        <div class="content-footer-actions">
          <button type="button" class="secondary" data-action="cancel-content">Cancel</button>
          <button type="button" ${count ? "" : "disabled"} data-action="delete-content">Delete</button>
        </div>
      </div>
    `;
  }

  const selectedImage = state.outputImages.find((image) => image.name === state.ui.contentSelectedImage) || null;
  const targetScreens = getContentTargetScreens();
  return `
    <div class="content-action-bar">
      <div class="content-footer-copy">
        <span class="device-summary-kicker">Selection</span>
        <strong>${selectedImage ? selectedImage.name : "No image selected"}</strong>
        <span>${targetScreens.length ? `${targetScreens.map((screen) => screen.name).join(", ")}` : "No target devices selected"}</span>
      </div>
      <div class="content-footer-actions">
        <button type="button" class="secondary" data-action="cancel-content">Cancel</button>
        <button type="button" class="secondary" ${selectedImage ? "" : "disabled"} data-action="delete-content">Delete</button>
        <button type="button" class="secondary" ${selectedImage ? "" : "disabled"} data-action="replace-content">Replace</button>
        <button type="button" ${selectedImage && targetScreens.length ? "" : "disabled"} data-action="send-content">Send</button>
      </div>
    </div>
  `;
}

function createSendFlowModal() {
  const flow = state.ui.sendFlow;
  if (!flow?.active) {
    return "";
  }

  const title =
    flow.status === "completed" ? "Send complete" : flow.status === "failed" ? "Send failed" : "Sending content";
  const detail =
    flow.status === "completed"
      ? `Delivered ${flow.imageName} to ${flow.targetNames.join(", ")}.`
      : flow.status === "failed"
        ? flow.error || "The send did not complete."
        : `Sending ${flow.imageName} to ${flow.targetNames.join(", ")}.`;

  return `
    <div class="modal-backdrop modal-backdrop--send"></div>
    <section class="modal-shell modal-shell--send" role="dialog" aria-modal="true" aria-label="Send progress">
      <div class="modal-header modal-header--send">
        <div>
          <p class="modal-kicker">Delivery Progress</p>
          <h2>${title}</h2>
          <p class="send-flow-copy">${detail}</p>
        </div>
      </div>
      <div class="modal-body modal-body--send">
        <div class="send-flow-visual ${flow.status === "running" || flow.status === "starting" ? "is-running" : ""}">
          <span></span>
          <span></span>
          <span></span>
        </div>
        <div class="send-flow-progress">
          <div class="send-flow-progress-bar">
            <div class="send-flow-progress-fill ${flow.status === "running" || flow.status === "starting" ? "is-running" : ""}" style="width:${flow.progress}%"></div>
          </div>
          <strong>${flow.progress}%</strong>
        </div>
        <div class="send-flow-steps">
          ${flow.steps
            .map(
              (step) => `
                <div class="send-step is-${step.state}">
                  <div class="send-step-marker"></div>
                  <div class="send-step-copy">
                    <strong>${step.title}</strong>
                    <span>${step.detail}</span>
                  </div>
                </div>
              `,
            )
            .join("")}
        </div>
        ${
          flow.targets?.length
            ? `
              <div class="send-flow-results">
                <span class="device-summary-kicker">Targets</span>
                ${flow.targets
                  .map((target) => {
                    const detailParts = [
                      target.name,
                      target.host,
                      target.milestones?.wakeSent ? "wake sent" : "",
                      target.milestones?.contentSet ? "command set" : "",
                      target.milestones?.contentJsonFetched ? "content.json fetched" : "",
                      target.milestones?.imageFetched ? "image fetched" : "",
                      target.status === "failed" ? target.error : ""
                    ].filter(Boolean);
                    return `<p>${detailParts.join(" / ")}</p>`;
                  })
                  .join("")}
              </div>
            `
            : ""
        }
        ${flow.status === "failed" ? `<div class="action-status error">${flow.error}</div>` : ""}
      </div>
      <div class="modal-footer">
        ${
          flow.status === "running" || flow.status === "starting"
            ? `<button type="button" class="secondary" disabled>Sending...</button>`
            : `<button type="button" data-action="close-send-flow">Done</button>`
        }
      </div>
    </section>
  `;
}

function createSpotifyPanel() {
  const showingArtistAlbums = state.spotify.artistView === "albums" && state.spotify.artistAlbums.length;
  const spotifyReady = state.spotifySettings.configured;
  return `
    <section class="spotify-panel studio-plugin-subsection">
      <div class="studio-section-header">
        <div>
          <span class="device-summary-kicker">Import</span>
          <h3>Spotify Import</h3>
        </div>
        <button type="button" class="secondary" data-action="toggle-spotify-import">${state.studio.albumArt.importCollapsed ? "Show" : "Hide"}</button>
      </div>
      ${
        state.studio.albumArt.importCollapsed
          ? `<p class="spotify-copy">Search artists or import playlists when you need more source albums. Hide this section once your source library is loaded.</p>`
          : `
            <p class="spotify-copy">Search artists, inspect album lists, or import a playlist of album references into the source library. Generated posters still land in Content.</p>
            <div class="spotify-settings-note ${spotifyReady ? "is-ready" : "is-missing"}">
              <strong>${spotifyReady ? "Spotify connected" : "Spotify credentials required"}</strong>
              <span>${spotifyReady ? `Using ${state.spotifySettings.source === "saved" ? "saved plugin settings" : ".env defaults"} for Spotify requests.` : "Open the gear to add your Spotify client ID and secret before searching."}</span>
            </div>
            <div class="spotify-search-row">
              <input id="spotify-artist-query" type="text" placeholder="Search artist" value="${state.spotify.artistQuery}" />
              <button type="button" data-action="spotify-search-artists" ${spotifyReady ? "" : "disabled"}>Search</button>
            </div>
            <div class="spotify-search-row">
              <input id="spotify-playlist-query" type="text" placeholder="Playlist URL or ID" value="${state.spotify.playlistQuery}" />
              <button type="button" class="secondary" data-action="spotify-import-playlist" ${spotifyReady ? "" : "disabled"}>Add Playlist Albums</button>
            </div>
            ${state.spotify.notice ? `<p class="spotify-notice">${state.spotify.notice}</p>` : ""}
            ${state.spotify.error ? `<p class="spotify-error">${state.spotify.error}</p>` : ""}
            ${
              !showingArtistAlbums && state.spotify.artistResults.length
                ? `
                  <div class="spotify-results">
                    ${state.spotify.artistResults
                      .map(
                        (artist) => `
                          <button type="button" class="spotify-result" data-action="spotify-load-artist" data-artist-id="${artist.id}">
                            <span>${artist.name}</span>
                            <span>${artist.followers?.total?.toLocaleString?.() || 0} followers</span>
                          </button>
                        `,
                      )
                      .join("")}
                  </div>
                `
                : ""
            }
            ${
              showingArtistAlbums
                ? `
                  <div class="spotify-results spotify-results--albums">
                    <div class="spotify-results-header">
                      <p class="spotify-subhead">Albums for ${state.spotify.selectedArtistName}</p>
                      <button type="button" class="secondary" data-action="spotify-back-to-artists">Back</button>
                    </div>
                    ${state.spotify.artistAlbums
                      .map(
                        (album) => `
                          <div class="spotify-album-card">
                            <div>
                              <strong>${album.name}</strong>
                              <span>${String(album.release_date || "").slice(0, 4) || "Unknown year"} / ${album.album_type}</span>
                            </div>
                            <button type="button" class="secondary" data-action="spotify-import-album" data-album-id="${album.id}">Add</button>
                          </div>
                        `,
                      )
                      .join("")}
                  </div>
                `
                : ""
            }
          `
      }
    </section>
  `;
}

function getImportedStudioEntries() {
  return state.catalog.filter((entry) => entry.source === "spotify");
}

function getTemporaryImportedSlugs(slugs = []) {
  return slugs.filter((slug) => state.catalog.find((entry) => entry.slug === slug)?.source === "spotify");
}

function getStudioPluginStatusLabel(status) {
  if (status === "installed") {
    return "Installed";
  }
  if (status === "planned") {
    return "Planned";
  }
  return "Concept";
}

function createStudioPluginCard(plugin) {
  return `
    <article class="studio-plugin-card" style="--plugin-accent:${plugin.accent}">
      <div class="studio-plugin-card-top">
        <span class="studio-plugin-mark">${plugin.mark}</span>
        <div class="studio-plugin-badges">
          <span class="studio-plugin-badge">${plugin.category}</span>
          <span class="studio-plugin-badge studio-plugin-badge--status is-${plugin.status}">${getStudioPluginStatusLabel(plugin.status)}</span>
        </div>
      </div>
      <div class="studio-plugin-card-copy">
        <h3>${plugin.name}</h3>
        <p>${plugin.summary}</p>
      </div>
      <div class="studio-plugin-capabilities">
        ${plugin.capabilities.map((capability) => `<span>${capability}</span>`).join("")}
      </div>
      <div class="studio-plugin-card-footer">
        <span>v${plugin.version}</span>
        <button type="button" data-action="open-studio-plugin" data-plugin-id="${plugin.id}">
          Open
        </button>
      </div>
    </article>
  `;
}

function createStudioDirectoryPanel() {
  return `
    <section class="studio-marketplace">
      <div class="studio-hero">
        <div>
          <h2>Studio Plugins</h2>
          <p>Studio is the extension layer for your wall. Open a plugin to import source material, generate new visuals, and push finished outputs into the shared Content library.</p>
        </div>
        <div class="studio-hero-meta">
          <span>${STUDIO_PLUGINS.length} plugins</span>
          <span>${STUDIO_PLUGINS.filter((plugin) => plugin.status === "installed").length} active</span>
        </div>
      </div>
      <div class="studio-plugin-grid">
        ${STUDIO_PLUGINS.map(createStudioPluginCard).join("")}
      </div>
    </section>
  `;
}

function createStudioSelectedAlbumCard(entry) {
  const isRecent = state.studio.albumArt.recentImportedSlugs.includes(entry.slug);
  const album = getAlbum(entry.slug);
  const cover = album?.cover ? `<img src="${album.cover}" alt="${entry.artist} - ${entry.album}" />` : `<span>${entry.artist.slice(0, 1)}${entry.album.slice(0, 1)}</span>`;
  return `
    <article id="studio-album-${entry.slug}" class="studio-album-card-shell is-selected ${isRecent ? "is-recent" : ""}">
      <div class="studio-album-card">
        <div class="studio-album-card-cover">${cover}</div>
        <div class="studio-album-card-copy">
          <strong>${entry.album}</strong>
          <span>${entry.artist}</span>
          <span>${entry.year || "Unknown year"}</span>
        </div>
        <button type="button" class="secondary studio-album-remove" data-action="remove-studio-album" data-album-slug="${entry.slug}">Remove</button>
      </div>
    </article>
  `;
}

function createGeneratedStudioResultCards() {
  const generated = state.studio.albumArt.generatedImageNames
    .map((name) => state.outputImages.find((image) => image.name === name))
    .filter(Boolean);

  if (!generated.length) {
    return "";
  }

  return `
    <section class="studio-plugin-subsection">
      <div class="studio-section-header">
        <div>
          <span class="device-summary-kicker">Generated Outputs</span>
          <h3>Ready in Content</h3>
        </div>
        <button type="button" class="secondary" data-action="open-generated-content">Open in Content</button>
      </div>
      <div class="studio-generated-grid">
        ${generated
          .map(
            (image) => `
              <article class="studio-generated-card">
                <div class="studio-generated-card-preview">
                  <img src="${image.url}?t=${encodeURIComponent(image.modifiedAt)}" alt="${image.name}" />
                </div>
                <div class="studio-generated-card-copy">
                  <strong>${image.name}</strong>
                  <span>${formatDateTime(image.modifiedAt)}</span>
                </div>
              </article>
            `,
          )
          .join("")}
      </div>
    </section>
  `;
}

function createStudioTemplateCard(template, album) {
  const isSelected = state.studio.albumArt.templateId === template.id;
  const baseScreen = state.project.screens[0] ? cloneScreen(state.project.screens[0]) : structuredClone(DEFAULT_PROJECT.screens[0]);
  const previewWidth = 252;
  const previewHeight = Math.round((baseScreen.size.height / baseScreen.size.width) * previewWidth);
  const previewScale = previewWidth / baseScreen.size.width;
  const previewScreen = {
    ...baseScreen,
    template: template.id,
    albumSlug: album?.slug || state.catalog[0]?.slug || ""
  };
  const previewMarkup = album ? template.render({ screen: previewScreen, album }) : `<div class="studio-template-empty">No preview</div>`;

  return `
    <button type="button" class="studio-template-card ${isSelected ? "is-selected" : ""}" data-action="select-studio-template" data-template-id="${template.id}">
      <div class="studio-template-preview" style="--studio-preview-width:${previewWidth}px;--studio-preview-height:${previewHeight}px;">
        ${
          album
            ? `
              <div class="studio-template-preview-scale" style="--studio-preview-scale:${previewScale};">
                <div class="studio-template-preview-inner">
                  ${previewMarkup}
                </div>
              </div>
            `
            : `<div class="studio-template-empty">No preview</div>`
        }
      </div>
      <div class="studio-template-card-copy">
        <strong>${template.name}</strong>
        <span>${isSelected ? "Selected design" : "Tap to select this design"}</span>
      </div>
    </button>
  `;
}

function renderAlbumArtWorkspace() {
  const selectedEntries = state.studio.albumArt.selectedSlugs
    .map((slug) => state.catalog.find((entry) => entry.slug === slug))
    .filter(Boolean);
  const previewAlbum = selectedEntries.length ? getAlbum(selectedEntries[0]?.slug) : null;
  const hasSelectedEntries = selectedEntries.length > 0;

  return `
    <section class="studio-plugin-body">
      ${createSpotifyPanel()}
      <section class="studio-plugin-subsection">
        <div class="studio-section-header">
          <div>
            <span class="device-summary-kicker">Queue</span>
            <h3>Selected albums</h3>
            <p class="studio-section-copy">Albums you add from Spotify search or playlist import will appear here for the current poster batch.</p>
          </div>
          <div class="studio-library-tools">
            <button type="button" class="secondary" data-action="clear-studio-album-selection" ${hasSelectedEntries ? "" : "disabled"}>Clear Queue</button>
          </div>
        </div>
        <div class="studio-album-grid">
          ${selectedEntries.length ? selectedEntries.map(createStudioSelectedAlbumCard).join("") : `<div class="empty-state empty-state--compact"><div><h2>No albums selected yet</h2><p>Search Spotify above or import a playlist to build the poster batch.</p></div></div>`}
        </div>
      </section>
      <section class="studio-plugin-subsection">
        <div class="studio-section-header">
          <div>
            <span class="device-summary-kicker">Design</span>
            <h3>Pick a poster design</h3>
            <p class="studio-section-copy">Choose one layout for the current batch. The preview uses the first selected album.</p>
          </div>
        </div>
        <div class="studio-template-grid">
          ${TEMPLATE_REGISTRY.map((template) => createStudioTemplateCard(template, previewAlbum)).join("")}
        </div>
      </section>
      <section class="studio-plugin-subsection">
        <div class="studio-section-header">
          <div>
            <span class="device-summary-kicker">Add to Content</span>
            <h3>Create poster set</h3>
          </div>
        </div>
        <div class="studio-generate-panel">
          <div class="studio-generate-controls">
            <div class="studio-selected-list">
              <span class="device-summary-kicker">Selected albums</span>
              ${selectedEntries.length
                ? selectedEntries.map((entry) => `<span>${entry.artist} - ${entry.album}</span>`).join("")
                : `<p>No albums selected yet.</p>`}
            </div>
          </div>
          <div class="studio-generate-actions">
            <p>The selected design will be rendered into the shared Content library as stable PNG files. Re-running the same album/design pair replaces the existing output instead of creating clutter.</p>
            <button type="button" ${selectedEntries.length ? "" : "disabled"} data-action="generate-album-art-posters">Add Posters to Content</button>
          </div>
        </div>
      </section>
      ${createGeneratedStudioResultCards()}
    </section>
  `;
}

function renderPlaceholderPluginWorkspace(plugin, placeholder) {
  return `
    <section class="studio-plugin-body">
      <div class="studio-plugin-body-copy">
        <h3>Workspace preview</h3>
        <p>${plugin.summary}</p>
      </div>
      <div class="studio-placeholder-panel">
        <span class="device-summary-kicker">${placeholder.kicker}</span>
        <strong>${placeholder.title}</strong>
        <p>${placeholder.body}</p>
      </div>
    </section>
  `;
}

function createStudioWorkspacePanel() {
  const selectedPlugin = getStudioPluginById(state.ui.studioPluginId);
  if (!selectedPlugin) {
    return createStudioDirectoryPanel();
  }
  const workspaceMarkup = selectedPlugin?.renderWorkspace?.({
    plugin: selectedPlugin,
    state,
    helpers: {
      renderSpotifyPanel: createSpotifyPanel,
      renderAlbumArtWorkspace,
      renderPlaceholderPluginWorkspace
    }
  }) || "";

  return `
    <section class="studio-marketplace">
      <section class="studio-plugin-workspace">
        <div class="studio-workspace-header">
          <button type="button" class="secondary" data-action="back-to-studio-directory">Back to Plugins</button>
          <div class="studio-plugin-detail-meta">
            ${
              selectedPlugin.id === "album-art-generator"
                ? `
                  <button
                    type="button"
                    class="icon-button icon-button--ghost icon-button--small"
                    data-action="open-spotify-settings"
                    aria-label="Open Spotify settings"
                    title="Spotify settings"
                  >
                    ${iconSvg("settings")}
                  </button>
                `
                : ""
            }
            <span class="studio-plugin-badge studio-plugin-badge--status is-${selectedPlugin.status}">${getStudioPluginStatusLabel(selectedPlugin.status)}</span>
            <span class="studio-plugin-badge">v${selectedPlugin.version}</span>
          </div>
        </div>
        <section class="studio-plugin-detail" style="--plugin-accent:${selectedPlugin.accent}">
          <div class="studio-plugin-detail-header">
            <div class="studio-plugin-detail-title">
              <span class="studio-plugin-mark">${selectedPlugin.mark}</span>
              <div>
                <p class="modal-kicker">${selectedPlugin.category}</p>
                <h3>${selectedPlugin.name}</h3>
                <p>${selectedPlugin.summary}</p>
              </div>
            </div>
          </div>
          <div class="studio-plugin-detail-grid studio-plugin-detail-grid--single">
            <div class="studio-plugin-main">
              ${
                selectedPlugin.detailSections?.length
                  ? `
                    <div class="studio-plugin-overview-inline">
                      <span class="device-summary-kicker">Overview</span>
                      ${selectedPlugin.detailSections
                        .map(
                          (section) => `
                            <div class="studio-detail-block">
                              <strong>${section.title}</strong>
                              <p>${section.body}</p>
                            </div>
                          `,
                        )
                        .join("")}
                    </div>
                  `
                  : ""
              }
              ${workspaceMarkup}
            </div>
          </div>
        </section>
      </section>
    </section>
  `;
}

function createStudioPanel() {
  if (state.ui.studioView === "workspace") {
    return createStudioWorkspacePanel();
  }

  return createStudioDirectoryPanel();
}

function createScreenModal() {
  const screen = state.ui.screenDraft || state.project.screens.find((entry) => entry.id === state.ui.screenId);
  const savedScreen = state.project.screens.find((entry) => entry.id === state.ui.screenId);
  if (!screen) {
    return "";
  }

  return `
    <div class="modal-backdrop" data-action="close-modal"></div>
    <section class="modal-shell modal-shell--screen" role="dialog" aria-modal="true" aria-label="Device details">
      <div class="modal-header">
        <div>
          <p class="modal-kicker">Device Details</p>
          <h2>${screen.name}</h2>
        </div>
        <button type="button" class="icon-button icon-button--ghost" data-action="close-modal" aria-label="Close device details">
          ${iconSvg("close")}
        </button>
      </div>
      <div class="modal-body">
        <section class="modal-section modal-section--stacked">
          ${createDeviceStatusMarkup(screen.id)}
          ${createDeviceUtilityActions(screen.id)}
          ${
            savedScreen && state.ui.screenDraft
              ? `<p class="modal-inline-note">Live status uses the saved host, PIN, and MAC until you save this form.</p>`
              : ""
          }
        </section>
        ${createScreenForm(screen)}
      </div>
      <div class="modal-footer">
        <button type="button" data-action="save-screen" data-screen-id="${screen.id}">Save</button>
      </div>
    </section>
  `;
}

function createSettingsModal() {
  return `
    <div class="modal-backdrop" data-action="close-modal"></div>
    <section class="modal-shell modal-shell--settings" role="dialog" aria-modal="true" aria-label="Settings">
      <div class="modal-header">
        <div>
          <p class="modal-kicker">Settings</p>
          <h2>Samsung EMDX</h2>
        </div>
        <button type="button" class="icon-button icon-button--ghost" data-action="close-modal" aria-label="Close settings">
          ${iconSvg("close")}
        </button>
      </div>
      <div class="modal-body modal-body--settings">
        <section class="modal-section">
          <h2>Settings</h2>
          <p class="spotify-copy">This area will hold app-level options later. Device inventory lives on Devices, content sending lives in Content, and imports or automations live in Studio.</p>
          ${state.actions.notice ? `<div class="action-status notice">${state.actions.notice}</div>` : ""}
          ${state.actions.error ? `<div class="action-status error">${state.actions.error}</div>` : ""}
        </section>
      </div>
    </section>
  `;
}

function createAddDeviceModal() {
  return `
    <div class="modal-backdrop" data-action="close-modal"></div>
    <section class="modal-shell modal-shell--compact" role="dialog" aria-modal="true" aria-label="Add device">
      <div class="modal-header">
        <div>
          <p class="modal-kicker">Add Device</p>
          <h2>Add a Samsung frame</h2>
          <p class="send-flow-copy">Choose whether to scan the network or enter the device details manually.</p>
        </div>
        <button type="button" class="icon-button icon-button--ghost" data-action="close-modal" aria-label="Close add device menu">
          ${iconSvg("close")}
        </button>
      </div>
      <div class="modal-body modal-body--settings">
        <div class="add-device-options">
          <button type="button" class="add-device-option" data-action="open-discover">
            <span class="add-device-option-icon">${iconSvg("search")}</span>
            <span class="add-device-option-copy">
              <strong>Find Devices</strong>
              <span>Scan the local network for reachable Samsung EMDX frames.</span>
            </span>
          </button>
          <button type="button" class="add-device-option" data-action="add-screen-manual">
            <span class="add-device-option-icon">${iconSvg("plus")}</span>
            <span class="add-device-option-copy">
              <strong>Add Manually</strong>
              <span>Enter the host, PIN, MAC, and local IP yourself.</span>
            </span>
          </button>
        </div>
      </div>
    </section>
  `;
}

function getDiscoveredScreenMatch(result) {
  return state.project.screens.find((screen) =>
    screen.device.host === result.host || (result.mac && screen.device.mac && screen.device.mac.toLowerCase() === result.mac.toLowerCase())
  ) || null;
}

function createDiscoveryModal() {
  const network = state.discovery.network;
  return `
    <div class="modal-backdrop" data-action="close-modal"></div>
    <section class="modal-shell modal-shell--settings" role="dialog" aria-modal="true" aria-label="Find devices">
      <div class="modal-header">
        <div>
          <p class="modal-kicker">Device Discovery</p>
          <h2>Find Samsung Frames</h2>
          <p class="send-flow-copy">${
            network
              ? `Scanning ${network.cidr} from ${network.localIp}.`
              : "Scan the local subnet for reachable Samsung EMDX frames."
          }</p>
        </div>
        <button type="button" class="icon-button icon-button--ghost" data-action="close-modal" aria-label="Close device discovery">
          ${iconSvg("close")}
        </button>
      </div>
      <div class="modal-body modal-body--settings">
        <div class="toolbar">
          <button type="button" class="secondary" data-action="refresh-discovery" ${state.discovery.loading ? "disabled" : ""}>
            ${state.discovery.loading ? "Scanning..." : "Scan Again"}
          </button>
        </div>
        ${state.discovery.error ? `<div class="action-status error">${state.discovery.error}</div>` : ""}
        ${
          state.discovery.loading
            ? `<div class="empty-state empty-state--compact"><div><h2>Scanning network</h2><p>Probing the local subnet for reachable Samsung frames.</p></div></div>`
            : state.discovery.results.length
              ? `
                <div class="discovery-grid">
                  ${state.discovery.results
                    .map((result) => {
                      const existing = getDiscoveredScreenMatch(result);
                      return `
                        <article class="discovery-card">
                          <div class="discovery-card-copy">
                            <strong>${result.deviceName || result.host}</strong>
                            <span>${result.host}${result.mac ? ` / ${result.mac}` : ""}</span>
                            <span>${
                              result.battery?.batteryPercent != null
                                ? `Battery ${result.battery.batteryPercent}%${result.battery.pluggedIn ? " / Plugged in" : ""}`
                                : result.mdcConnected
                                  ? "Connected over MDC"
                                  : "Port 1515 reachable"
                            }</span>
                          </div>
                          <div class="discovery-card-actions">
                            ${
                              existing
                                ? `<button type="button" class="secondary" disabled>Added as ${existing.name}</button>`
                                : `<button type="button" data-action="add-discovered-device" data-device-host="${result.host}">Add Device</button>`
                            }
                          </div>
                        </article>
                      `;
                    })
                    .join("")}
                </div>
              `
              : `<div class="empty-state empty-state--compact"><div><h2>No devices found</h2><p>Only awake and network-reachable frames will appear here.</p></div></div>`
        }
      </div>
    </section>
  `;
}

function createDeleteConfirmModal() {
  const names = state.ui.pendingDeleteNames || [];
  const count = names.length;
  const isSingle = count === 1;

  return `
    <div class="modal-backdrop" data-action="close-delete-confirm"></div>
    <section class="modal-shell modal-shell--compact" role="dialog" aria-modal="true" aria-label="Confirm delete">
      <div class="modal-header">
        <div>
          <p class="modal-kicker">Delete Content</p>
          <h2>Delete ${count} image${count === 1 ? "" : "s"}?</h2>
          <p class="send-flow-copy">${
            isSingle
              ? `This will permanently remove ${names[0]} from the content library.`
              : "This will permanently remove the selected images from the content library."
          }</p>
        </div>
        <button type="button" class="icon-button icon-button--ghost" data-action="close-delete-confirm" aria-label="Close delete confirmation">
          ${iconSvg("close")}
        </button>
      </div>
      <div class="modal-body modal-body--settings">
        <section class="modal-section modal-section--stacked">
          ${names.length ? `<div class="confirm-delete-list">${names.map((name) => `<span>${name}</span>`).join("")}</div>` : ""}
        </section>
      </div>
      <div class="modal-footer">
        <button type="button" class="secondary" data-action="close-delete-confirm">Cancel</button>
        <button type="button" data-action="confirm-delete-content">Delete</button>
      </div>
    </section>
  `;
}

function createDeleteImportedAlbumsModal() {
  const slugs = state.ui.pendingImportedDeleteSlugs || [];
  const albums = slugs
    .map((slug) => state.catalog.find((entry) => entry.slug === slug))
    .filter(Boolean);
  const count = albums.length;

  return `
    <div class="modal-backdrop" data-action="close-delete-imported"></div>
    <section class="modal-shell modal-shell--compact" role="dialog" aria-modal="true" aria-label="Delete source albums">
      <div class="modal-header">
        <div>
          <p class="modal-kicker">Delete Source Albums</p>
          <h2>Remove ${count} source album${count === 1 ? "" : "s"}?</h2>
          <p class="send-flow-copy">This removes the imported Spotify source data and cached cover art from Studio. Any posters already generated into Content will stay there.</p>
        </div>
        <button type="button" class="icon-button icon-button--ghost" data-action="close-delete-imported" aria-label="Close delete confirmation">
          ${iconSvg("close")}
        </button>
      </div>
      <div class="modal-body modal-body--settings">
        <section class="modal-section modal-section--stacked">
          ${albums.length ? `<div class="confirm-delete-list">${albums.map((album) => `<span>${album.artist} - ${album.album}</span>`).join("")}</div>` : ""}
        </section>
      </div>
      <div class="modal-footer">
        <button type="button" class="secondary" data-action="close-delete-imported">Cancel</button>
        <button type="button" data-action="confirm-delete-imported">Delete</button>
      </div>
    </section>
  `;
}

function createSpotifySettingsModal() {
  const draft = state.ui.spotifySettingsDraft || normalizeSpotifySettings(state.spotifySettings);
  return `
    <div class="modal-backdrop" data-action="close-modal"></div>
    <section class="modal-shell modal-shell--compact" role="dialog" aria-modal="true" aria-label="Spotify settings">
      <div class="modal-header">
        <div>
          <p class="modal-kicker">Album Art Plugin</p>
          <h2>Spotify Settings</h2>
          <p class="send-flow-copy">Store your Spotify developer credentials locally for the Album Art plugin. Saved values override .env defaults on this machine.</p>
        </div>
        <button type="button" class="icon-button icon-button--ghost" data-action="close-modal" aria-label="Close Spotify settings">
          ${iconSvg("close")}
        </button>
      </div>
      <div class="modal-body modal-body--settings">
        <section class="screen-form screen-form--modal">
          <div class="field-row">
            <label>
              Spotify Client ID
              <input id="spotify-settings-client-id" type="text" value="${draft.clientId}" />
            </label>
            <label>
              Market
              <input id="spotify-settings-market" type="text" value="${draft.market}" maxlength="2" />
            </label>
          </div>
          <label>
            Spotify Client Secret
            <input id="spotify-settings-client-secret" type="password" value="${draft.clientSecret}" />
          </label>
          <p class="modal-inline-note">
            Current source: ${state.spotifySettings.source === "saved" ? "saved plugin settings" : ".env defaults"}.
          </p>
        </section>
      </div>
      <div class="modal-footer">
        <button type="button" data-action="save-spotify-settings">Save</button>
      </div>
    </section>
  `;
}

function createContentPreviewModal() {
  const image = state.outputImages.find((entry) => entry.name === state.ui.previewImageName);
  if (!image) {
    return "";
  }

  return `
    <div class="modal-backdrop" data-action="close-content-preview"></div>
    <section class="modal-shell modal-shell--preview" role="dialog" aria-modal="true" aria-label="Content preview">
      <div class="modal-header">
        <div>
          <p class="modal-kicker">Content Preview</p>
          <h2>${image.name}</h2>
          <p class="send-flow-copy">${formatDateTime(image.modifiedAt)} / ${formatBytes(image.size)}</p>
        </div>
        <button type="button" class="icon-button icon-button--ghost" data-action="close-content-preview" aria-label="Close preview">
          ${iconSvg("close")}
        </button>
      </div>
      <div class="modal-body modal-body--preview">
        <div class="content-preview-frame">
          <img src="${image.url}?t=${encodeURIComponent(image.modifiedAt)}" alt="${image.name}" />
        </div>
      </div>
    </section>
  `;
}

function createSectionPanel() {
  if (state.ui.section === "content") {
    const selectedScreen = state.project.screens.find((screen) => screen.id === state.ui.contentScreenId);
    return `
      <section class="content-panel">
        <div class="content-header">
          <div class="content-header-copy">
            <h2>Content</h2>
            <p>${selectedScreen ? `Choose imagery for ${selectedScreen.name}.` : "Browse generated images and upload one quickly from this device."}</p>
          </div>
          <div class="content-header-actions">
            <button type="button" class="content-upload-button" data-action="toggle-content-manage">
              ${iconSvg("manage")}
              <span>${state.ui.contentManageMode ? "Done" : "Manage"}</span>
            </button>
            <button type="button" class="content-upload-button" data-action="open-upload">
              ${iconSvg("upload")}
              <span>Upload Image</span>
            </button>
          </div>
        </div>
        <div class="broadcast-row">
          <span class="device-summary-kicker">Target Devices</span>
          <div class="broadcast-grid">
            ${state.project.screens.filter((screen) => screen.enabled).map(createTargetDeviceButton).join("")}
          </div>
        </div>
        ${state.actions.notice ? `<div class="action-status notice">${state.actions.notice}</div>` : ""}
        ${state.actions.error ? `<div class="action-status error">${state.actions.error}</div>` : ""}
        ${
          state.outputImages.length
            ? `<div class="output-grid">${state.outputImages.map(createOutputImageCard).join("")}</div>`
            : `<div class="empty-state empty-state--compact"><div><h2>No output images yet</h2><p>Rendered or test images from the app will appear here.</p></div></div>`
        }
      </section>
    `;
  }

  if (state.ui.section === "studio") {
    return createStudioPanel();
  }

  const screens = state.project.screens;
  return screens.length
    ? `
      <section class="device-panel">
        ${state.actions.notice ? `<div class="action-status notice">${state.actions.notice}</div>` : ""}
        ${state.actions.error ? `<div class="action-status error">${state.actions.error}</div>` : ""}
        <div class="preview-grid">${screens.map(createPreviewCard).join("")}</div>
      </section>
    `
    : `
      <div class="empty-state">
        <div>
          <h2>No devices configured</h2>
          <p>Add a device to start tracking screen inventory and the last image sent from this app.</p>
          <button type="button" class="empty-action" data-action="open-add-device">Add Device</button>
        </div>
      </div>
    `;
}

function createActiveModal() {
  if (state.ui.sendFlow?.active) {
    return createSendFlowModal();
  }
  if (state.ui.modal === "content-preview") {
    return createContentPreviewModal();
  }
  if (state.ui.modal === "delete-imported-albums") {
    return createDeleteImportedAlbumsModal();
  }
  if (state.ui.modal === "delete-content") {
    return createDeleteConfirmModal();
  }
  if (state.ui.modal === "add-device") {
    return createAddDeviceModal();
  }
  if (state.ui.modal === "discover") {
    return createDiscoveryModal();
  }
  if (state.ui.modal === "screen") {
    return createScreenModal();
  }
  if (state.ui.modal === "settings") {
    return createSettingsModal();
  }
  if (state.ui.modal === "spotify-settings") {
    return createSpotifySettingsModal();
  }
  return "";
}

function renderWorkspace() {
  persistUiState();
  app.innerHTML = `
    <main class="shell">
      <section class="workspace workspace--wide">
        <header class="topbar">
          <div class="topbar-copy">
            <h1>Samsung EMDX</h1>
          </div>
          <div class="topbar-actions">
            <button type="button" class="icon-button icon-button--primary" data-action="open-add-device" aria-label="Add device" title="Add device">
              ${iconSvg("plus")}
            </button>
            <button type="button" class="icon-button" data-action="open-settings" aria-label="Open settings" title="Open settings">
              ${iconSvg("settings")}
            </button>
          </div>
        </header>

        <div class="workspace-header">
          ${createSectionTabs()}
        </div>
        ${createSectionPanel()}
        ${createContentActionBar()}
        <input id="content-upload-input" type="file" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" hidden />
      </section>
      ${createActiveModal()}
    </main>
  `;

  bindWorkspaceEvents();
}

async function refreshDeviceStatuses({ silent = false } = {}) {
  const screens = state.project.screens.filter((screen) => screen.enabled && screen.device?.host && screen.device?.pin);
  if (!screens.length) {
    return;
  }

  for (const screen of screens) {
    state.deviceDiagnostics[screen.id] = {
      ...getDeviceDiagnostic(screen.id),
      loading: true,
      waking: false,
      error: ""
    };
  }
  renderWorkspace();

  const results = await Promise.allSettled(
    screens.map(async (screen) => {
      const payload = await apiGetJson(`/api/devices/${screen.id}/status`);
      return {
        screenId: screen.id,
        status: payload.status
      };
    }),
  );

  results.forEach((result, index) => {
    const screen = screens[index];
    if (result.status === "fulfilled") {
      state.deviceDiagnostics[screen.id] = {
        loading: false,
        waking: false,
        error: "",
        status: result.value.status
      };
      return;
    }

    state.deviceDiagnostics[screen.id] = {
      loading: false,
      waking: false,
      error: result.reason?.message || "Status unavailable.",
      status: null
    };
  });

  if (!silent) {
    state.actions.notice = "Device status refreshed.";
    state.actions.error = "";
  }
  renderWorkspace();
}

function bindWorkspaceEvents() {
  document.getElementById("project-name")?.addEventListener("input", (event) => {
    state.project.name = event.target.value;
    persistProject();
  });

  document.getElementById("spotify-artist-query")?.addEventListener("input", (event) => {
    state.spotify.artistQuery = event.target.value;
  });
  document.getElementById("spotify-artist-query")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      const trigger = app.querySelector('[data-action="spotify-search-artists"]');
      trigger?.click();
    }
  });

  document.getElementById("spotify-playlist-query")?.addEventListener("input", (event) => {
    state.spotify.playlistQuery = event.target.value;
  });
  document.getElementById("spotify-playlist-query")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      const trigger = app.querySelector('[data-action="spotify-import-playlist"]');
      trigger?.click();
    }
  });

  document.getElementById("studio-album-filter")?.addEventListener("input", (event) => {
    state.studio.albumArt.filterQuery = event.target.value;
    renderWorkspace();
  });

  document.getElementById("studio-template-select")?.addEventListener("change", (event) => {
    state.studio.albumArt.templateId = event.target.value;
    renderWorkspace();
  });

  document.getElementById("content-upload-input")?.addEventListener("change", (event) => {
    handleContentUpload(event).catch((error) => {
      state.actions.error = error.message;
      renderWorkspace();
    });
  });

  app.querySelectorAll("[data-path]").forEach((element) => {
    element.addEventListener("change", handleFieldChange);
  });

  app.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => {
      handleAction(button).catch((error) => {
        state.actions.error = error.message;
        renderWorkspace();
      });
    });
  });

  bindContentPressEvents();
}

function bindContentPressEvents() {
  let pressTimer = null;

  app.querySelectorAll(".output-card").forEach((card) => {
    const imageName = card.dataset.imageName;

    const clearTimer = () => {
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
    };

    card.addEventListener("pointerdown", (event) => {
      clearTimer();
      pressTimer = setTimeout(() => {
        if (!state.ui.contentManageMode) {
          state.ui.contentManageMode = true;
          state.ui.contentManageSelections = [imageName];
          state.ui.contentSelectedImage = "";
        } else if (!state.ui.contentManageSelections.includes(imageName)) {
          state.ui.contentManageSelections = [...state.ui.contentManageSelections, imageName];
        }
        state.actions.notice = "";
        state.actions.error = "";
        renderWorkspace();
      }, 450);
    });

    card.addEventListener("pointerup", clearTimer);
    card.addEventListener("pointerleave", clearTimer);
    card.addEventListener("pointercancel", clearTimer);
    card.addEventListener("contextmenu", (event) => event.preventDefault());
  });
}

async function handleFieldChange(event) {
  const form = event.target.closest("[data-screen-id]");
  if (!form) {
    return;
  }

  const screen = state.ui.screenDraft;
  if (!screen) {
    return;
  }
  const path = event.target.dataset.path;
  const rawValue = event.target.type === "checkbox" ? event.target.checked : event.target.value;
  const value = event.target.type === "number" ? Number(rawValue) : rawValue;

  setValueByPath(screen, path, value);
}

async function handleAction(button) {
  const action = button.dataset.action;
  const screenId = button.dataset.screenId;
  const screenName = screenId
    ? state.project.screens.find((entry) => entry.id === screenId)?.name || screenId
    : "";
  state.actions.error = "";
  state.spotify.error = "";

  if (action === "open-add-device") {
    state.ui.modal = "add-device";
    state.ui.screenId = null;
    state.ui.screenDraft = null;
    renderWorkspace();
    return;
  }

  if (action === "add-screen-manual") {
    const created = createScreenDraft();
    state.ui.modal = "screen";
    state.ui.screenId = created.id;
    state.ui.screenDraft = cloneScreen(created);
    renderWorkspace();
    return;
  }

  if (action === "open-settings") {
    state.ui.modal = "settings";
    state.ui.screenDraft = null;
    renderWorkspace();
    return;
  }

  if (action === "open-spotify-settings") {
    state.ui.modal = "spotify-settings";
    state.ui.spotifySettingsDraft = normalizeSpotifySettings(state.spotifySettings);
    renderWorkspace();
    return;
  }

  if (action === "open-discover") {
    state.ui.modal = "discover";
    renderWorkspace();
    await runDiscoveryScan();
    return;
  }

  if (action === "refresh-discovery") {
    await runDiscoveryScan();
    return;
  }

  if (action === "open-section") {
    state.ui.section = button.dataset.section || "devices";
    if (state.ui.section === "studio") {
      state.ui.studioView = "directory";
    }
    if (state.ui.section === "content") {
      const outputPayload = await loadOutputImages();
      state.outputImages = outputPayload.images || [];
      state.outputDirectory = outputPayload.directory || "";
    }
    renderWorkspace();
    return;
  }

  if (action === "open-studio-plugin") {
    state.ui.section = "studio";
    state.ui.studioPluginId = button.dataset.pluginId || STUDIO_PLUGINS[0]?.id || "";
    state.ui.studioView = "workspace";
    if (state.ui.studioPluginId === "album-art-generator") {
      await ensureAlbums(state.catalog.map((entry) => entry.slug));
    }
    state.actions.error = "";
    renderWorkspace();
    return;
  }

  if (action === "back-to-studio-directory") {
    state.ui.studioView = "directory";
    state.actions.error = "";
    renderWorkspace();
    return;
  }

  if (action === "open-content") {
    state.ui.section = "content";
    state.ui.contentScreenId = screenId || null;
    state.ui.contentBroadcastIds = [];
    state.ui.contentSelectedImage = "";
    state.ui.contentManageMode = false;
    state.ui.contentManageSelections = [];
    state.ui.modal = null;
    state.ui.screenId = null;
    const outputPayload = await loadOutputImages();
    state.outputImages = outputPayload.images || [];
    state.outputDirectory = outputPayload.directory || "";
    renderWorkspace();
    return;
  }

  if (action === "add-discovered-device") {
    const host = button.dataset.deviceHost || "";
    const discovered = state.discovery.results.find((result) => result.host === host);
    if (!discovered) {
      state.actions.error = "Discovered device no longer available.";
      renderWorkspace();
      return;
    }

    const defaultPin = discovered.detectedPin || state.project.screens.find((screen) => screen.device.pin)?.device.pin || "";
    const created = {
      id: `screen-${crypto.randomUUID().slice(0, 8)}`,
      name: discovered.deviceName || `Discovered Device ${state.project.screens.length + 1}`,
      enabled: true,
      profile: "music",
      template: "music-editorial-v1",
      albumSlug: state.catalog[0]?.slug || "ten",
      size: { width: 1440, height: 2560 },
      frame: {
        paddingTop: 60,
        paddingRight: 60,
        paddingBottom: 60,
        paddingLeft: 60,
        swatchCount: 5,
        imageFit: "cover"
      },
      device: {
        host: discovered.host,
        pin: defaultPin,
        mac: discovered.mac || "",
        localIp: state.discovery.network?.localIp || ""
      }
    };

    state.project.screens.push(created);
    persistProject();
    state.actions.notice = `Added ${created.name}.`;
    state.actions.error = "";
    renderWorkspace();
    return;
  }

  if (action === "check-device-status" && screenId) {
    state.deviceDiagnostics[screenId] = {
      ...getDeviceDiagnostic(screenId),
      loading: true,
      waking: false,
      error: ""
    };
    state.actions.notice = "";
    renderWorkspace();

    try {
      const payload = await apiGetJson(`/api/devices/${screenId}/status`);
      state.deviceDiagnostics[screenId] = {
        loading: false,
        waking: false,
        error: "",
        status: payload.status
      };
      state.actions.notice = `Checked ${screenName}.`;
      state.actions.error = "";
    } catch (error) {
      state.deviceDiagnostics[screenId] = {
        ...getDeviceDiagnostic(screenId),
        loading: false,
        waking: false,
        error: error.message
      };
      state.actions.error = `Status check failed for ${screenName}: ${error.message}`;
    }

    renderWorkspace();
    return;
  }

  if (action === "wake-device" && screenId) {
    state.deviceDiagnostics[screenId] = {
      ...getDeviceDiagnostic(screenId),
      loading: false,
      waking: true,
      error: ""
    };
    state.actions.notice = "";
    renderWorkspace();

    try {
      await apiPostJson(`/api/devices/${screenId}/wake`, {});
      const payload = await apiGetJson(`/api/devices/${screenId}/status`);
      state.deviceDiagnostics[screenId] = {
        loading: false,
        waking: false,
        error: "",
        status: payload.status
      };
      state.actions.notice = `Sent wake signal to ${screenName}.`;
      state.actions.error = "";
    } catch (error) {
      state.deviceDiagnostics[screenId] = {
        ...getDeviceDiagnostic(screenId),
        loading: false,
        waking: false,
        error: error.message
      };
      state.actions.error = `Wake failed for ${screenName}: ${error.message}`;
    }

    renderWorkspace();
    return;
  }

  if (action === "open-upload") {
    state.ui.contentReplaceImage = "";
    document.getElementById("content-upload-input")?.click();
    return;
  }

  if (action === "replace-content") {
    const selectedImage = state.outputImages.find((image) => image.name === state.ui.contentSelectedImage);
    if (!selectedImage) {
      state.actions.error = "Select an image to replace.";
      renderWorkspace();
      return;
    }
    state.ui.contentReplaceImage = selectedImage.name;
    document.getElementById("content-upload-input")?.click();
    return;
  }

  if (action === "toggle-spotify-import") {
    state.studio.albumArt.importCollapsed = !state.studio.albumArt.importCollapsed;
    renderWorkspace();
    return;
  }

  if (action === "toggle-content-manage") {
    state.ui.contentManageMode = !state.ui.contentManageMode;
    state.ui.contentManageSelections = [];
    state.actions.error = "";
    renderWorkspace();
    return;
  }

  if (action === "toggle-studio-album") {
    const slug = button.dataset.albumSlug || "";
    const next = new Set(state.studio.albumArt.selectedSlugs);
    if (next.has(slug)) {
      next.delete(slug);
    } else {
      next.add(slug);
    }
    state.studio.albumArt.selectedSlugs = [...next];
    renderWorkspace();
    return;
  }

  if (action === "select-studio-template") {
    const templateId = button.dataset.templateId || "";
    if (templateId) {
      state.studio.albumArt.templateId = templateId;
      renderWorkspace();
    }
    return;
  }

  if (action === "clear-studio-album-selection") {
    const slugsToDelete = getTemporaryImportedSlugs(state.studio.albumArt.selectedSlugs);
    if (slugsToDelete.length) {
      await apiPostJson("/api/imported-albums/delete", { slugs: slugsToDelete });
      await refreshCatalogAndAlbums();
    }
    state.studio.albumArt.selectedSlugs = [];
    state.studio.albumArt.recentImportedSlugs = state.studio.albumArt.recentImportedSlugs.filter((slug) => !slugsToDelete.includes(slug));
    renderWorkspace();
    return;
  }

  if (action === "remove-studio-album") {
    const slug = button.dataset.albumSlug || "";
    const slugsToDelete = getTemporaryImportedSlugs([slug]);
    if (slugsToDelete.length) {
      await apiPostJson("/api/imported-albums/delete", { slugs: slugsToDelete });
      await refreshCatalogAndAlbums();
    }
    state.studio.albumArt.selectedSlugs = state.studio.albumArt.selectedSlugs.filter((entry) => entry !== slug);
    state.studio.albumArt.recentImportedSlugs = state.studio.albumArt.recentImportedSlugs.filter((entry) => entry !== slug);
    renderWorkspace();
    return;
  }

  if (action === "generate-album-art-posters") {
    const albumSlugs = [...state.studio.albumArt.selectedSlugs];
    if (!albumSlugs.length) {
      state.actions.error = "Select at least one album before generating posters.";
      renderWorkspace();
      return;
    }
    const payload = await apiPostJson("/api/studio/plugins/album-art/generate", {
      albumSlugs,
      templateId: state.studio.albumArt.templateId
    });
    const slugsToDelete = getTemporaryImportedSlugs(albumSlugs);
    if (slugsToDelete.length) {
      await apiPostJson("/api/imported-albums/delete", { slugs: slugsToDelete });
      await refreshCatalogAndAlbums();
    }
    const outputPayload = await loadOutputImages();
    state.outputImages = outputPayload.images || [];
    state.outputDirectory = outputPayload.directory || "";
    const generatedNames = (payload.generated || []).map((image) => image.name);
    state.studio.albumArt.generatedImageNames = generatedNames;
    state.studio.albumArt.selectedSlugs = [];
    state.studio.albumArt.recentImportedSlugs = state.studio.albumArt.recentImportedSlugs.filter((slug) => !slugsToDelete.includes(slug));
    state.ui.section = "content";
    state.ui.contentSelectedImage = generatedNames[0] || "";
    state.ui.contentScreenId = null;
    state.ui.contentBroadcastIds = [];
    state.ui.contentManageMode = false;
    state.ui.contentManageSelections = [];
    state.actions.notice = `Generated ${payload.generated?.length || 0} poster${payload.generated?.length === 1 ? "" : "s"} and opened Content.`;
    state.actions.error = "";
    renderWorkspace();
    return;
  }

  if (action === "open-generated-content") {
    const firstGenerated = state.studio.albumArt.generatedImageNames[0] || "";
    state.ui.section = "content";
    state.ui.contentSelectedImage = firstGenerated;
    state.ui.contentScreenId = null;
    state.ui.contentBroadcastIds = [];
    state.ui.contentManageMode = false;
    state.ui.contentManageSelections = [];
    state.actions.error = "";
    renderWorkspace();
    return;
  }

  if (action === "toggle-content-target" && screenId) {
    const next = new Set(state.ui.contentBroadcastIds);
    const isPrimary = state.ui.contentScreenId === screenId;

    if (isPrimary) {
      if (state.ui.contentBroadcastIds.length) {
        const [nextPrimary, ...remaining] = state.ui.contentBroadcastIds;
        state.ui.contentScreenId = nextPrimary;
        state.ui.contentBroadcastIds = remaining.filter((id) => id !== nextPrimary);
      } else {
        state.ui.contentScreenId = null;
        state.ui.contentBroadcastIds = [];
      }
    } else if (!state.ui.contentScreenId) {
      state.ui.contentScreenId = screenId;
    } else if (next.has(screenId)) {
      next.delete(screenId);
      state.ui.contentBroadcastIds = [...next];
    } else {
      if (state.ui.contentBroadcastIds.length === 0) {
        state.ui.contentScreenId = screenId;
      } else {
        next.add(screenId);
        state.ui.contentBroadcastIds = [...next];
      }
    }
    renderWorkspace();
    return;
  }

  if (action === "select-content-image") {
    const imageName = button.dataset.imageName || "";
    if (state.ui.contentManageMode) {
      const next = new Set(state.ui.contentManageSelections);
      if (next.has(imageName)) {
        next.delete(imageName);
      } else {
        next.add(imageName);
      }
      state.ui.contentManageSelections = [...next];
    } else {
      state.ui.contentSelectedImage = imageName;
    }
    renderWorkspace();
    return;
  }

  if (action === "open-content-preview") {
    state.ui.previewImageName = button.dataset.imageName || "";
    state.ui.modal = "content-preview";
    renderWorkspace();
    return;
  }

  if (action === "cancel-content") {
    if (state.ui.contentManageMode) {
      state.ui.contentManageMode = false;
      state.ui.contentManageSelections = [];
      state.actions.error = "";
      renderWorkspace();
      return;
    }
    state.ui.section = "devices";
    resetContentUi();
    state.actions.notice = "";
    state.actions.error = "";
    renderWorkspace();
    return;
  }

  if (action === "send-content") {
    const selectedImage = state.outputImages.find((image) => image.name === state.ui.contentSelectedImage);
    const targetScreens = getContentTargetScreens();
    const targetIds = targetScreens.map((screen) => screen.id);
    if (!selectedImage || !targetIds.length) {
      state.actions.error = "Select an image and at least one target device.";
      renderWorkspace();
      return;
    }
    state.ui.sendFlow = createPendingSendFlow({
      imageName: selectedImage.name,
      targetNames: targetScreens.map((screen) => screen.name)
    });
    renderWorkspace();
    try {
      const payload = await apiPostJson("/api/content/send", {
        imageName: selectedImage.name,
        screenIds: targetIds
      });
      state.ui.sendFlow.jobId = payload.jobId;
      state.ui.sendFlow.status = "running";
      await pollSendFlowJob(payload.jobId, { immediate: true });
    } catch (error) {
      state.actions.error = error.message;
      stopSendFlowPolling();
      state.ui.sendFlow = {
        ...(state.ui.sendFlow || {}),
        active: true,
        status: "failed",
        error: error.message,
        progress: 12,
        steps: (state.ui.sendFlow?.steps || []).map((step, index) => ({
          ...step,
          state: index === 0 ? "error" : "pending"
        }))
      };
    }
    renderWorkspace();
    return;
  }

  if (action === "close-send-flow") {
    stopSendFlowPolling();
    state.deviceState = await loadDeviceState();
    if (state.ui.sendFlow?.status === "completed") {
      state.actions.notice = `Sent ${state.ui.sendFlow.imageName} to ${state.ui.sendFlow.targetNames.join(", ")}.`;
      state.actions.error = "";
    }
    state.ui.sendFlow = null;
    renderWorkspace();
    return;
  }

  if (action === "delete-content") {
    const names = state.ui.contentManageMode ? [...state.ui.contentManageSelections] : state.ui.contentSelectedImage ? [state.ui.contentSelectedImage] : [];
    if (!names.length) {
      state.actions.error = state.ui.contentManageMode ? "Select at least one image to delete." : "Select an image to delete.";
      renderWorkspace();
      return;
    }
    state.ui.pendingDeleteNames = names;
    state.ui.modal = "delete-content";
    renderWorkspace();
    return;
  }

  if (action === "close-delete-confirm") {
    state.ui.modal = null;
    state.ui.pendingDeleteNames = [];
    renderWorkspace();
    return;
  }

  if (action === "close-content-preview") {
    state.ui.modal = null;
    state.ui.previewImageName = "";
    renderWorkspace();
    return;
  }

  if (action === "close-delete-imported") {
    state.ui.modal = null;
    state.ui.pendingImportedDeleteSlugs = [];
    renderWorkspace();
    return;
  }

  if (action === "confirm-delete-content") {
    const names = [...(state.ui.pendingDeleteNames || [])];
    if (!names.length) {
      state.ui.modal = null;
      renderWorkspace();
      return;
    }
    const payload = await apiPostJson("/api/output-images/delete", { names });
    const outputPayload = await loadOutputImages();
    state.outputImages = outputPayload.images || [];
    state.outputDirectory = outputPayload.directory || "";
    state.ui.contentManageSelections = [];
    state.ui.contentManageMode = false;
    state.ui.pendingDeleteNames = [];
    state.ui.modal = null;
    if (names.includes(state.ui.contentSelectedImage)) {
      state.ui.contentSelectedImage = "";
    }
    state.actions.notice = `Deleted ${payload.deleted.length} image${payload.deleted.length === 1 ? "" : "s"}.`;
    state.actions.error = "";
    renderWorkspace();
    return;
  }

  if (action === "confirm-delete-imported") {
    const slugs = [...(state.ui.pendingImportedDeleteSlugs || [])];
    if (!slugs.length) {
      state.ui.modal = null;
      renderWorkspace();
      return;
    }
    const payload = await apiPostJson("/api/imported-albums/delete", { slugs });
    state.ui.pendingImportedDeleteSlugs = [];
    state.ui.modal = null;
    state.studio.albumArt.selectedSlugs = state.studio.albumArt.selectedSlugs.filter((slug) => !payload.deleted.includes(slug));
    state.studio.albumArt.recentImportedSlugs = state.studio.albumArt.recentImportedSlugs.filter((slug) => !payload.deleted.includes(slug));
    await refreshCatalogAndAlbums();
    state.actions.notice = `Removed ${payload.deleted.length} source album${payload.deleted.length === 1 ? "" : "s"} from Studio.`;
    state.actions.error = "";
    renderWorkspace();
    return;
  }

  if (action === "move-screen-up" && screenId) {
    moveScreen(screenId, -1);
    return;
  }

  if (action === "move-screen-down" && screenId) {
    moveScreen(screenId, 1);
    return;
  }

  if (action === "open-screen-modal" && screenId) {
    state.ui.modal = "screen";
    state.ui.screenId = screenId;
    state.ui.screenDraft = cloneScreen(state.project.screens.find((entry) => entry.id === screenId));
    renderWorkspace();
    return;
  }

  if (action === "close-modal") {
    state.ui.modal = null;
    state.ui.screenId = null;
    state.ui.screenDraft = null;
    state.ui.pendingDeleteNames = [];
    state.ui.pendingImportedDeleteSlugs = [];
    state.ui.spotifySettingsDraft = null;
    state.ui.previewImageName = "";
    renderWorkspace();
    return;
  }

  if (action === "save-spotify-settings") {
    const clientId = document.getElementById("spotify-settings-client-id")?.value?.trim() || "";
    const clientSecret = document.getElementById("spotify-settings-client-secret")?.value?.trim() || "";
    const market = document.getElementById("spotify-settings-market")?.value?.trim() || "US";
    const saved = await apiPutJson("/api/studio/plugins/album-art/settings", {
      clientId,
      clientSecret,
      market
    });
    state.spotifySettings = normalizeSpotifySettings(saved);
    state.ui.modal = null;
    state.ui.spotifySettingsDraft = null;
    state.spotify.notice = "Spotify settings saved.";
    state.spotify.error = "";
    renderWorkspace();
    return;
  }

  if (action === "duplicate-screen" && screenId) {
    duplicateScreen(screenId);
    return;
  }

  if (action === "remove-screen" && screenId) {
    state.project.screens = state.project.screens.filter((screen) => screen.id !== screenId);
    if (state.ui.screenId === screenId) {
      state.ui.modal = null;
      state.ui.screenId = null;
      state.ui.screenDraft = null;
    }
    persistProject();
    renderWorkspace();
    return;
  }

  if (action === "save-screen" && screenId) {
    const index = state.project.screens.findIndex((entry) => entry.id === screenId);
    if (!state.ui.screenDraft) {
      state.actions.error = "Unable to save device details.";
      renderWorkspace();
      return;
    }
    if (index === -1) {
      state.project.screens.push(cloneScreen(state.ui.screenDraft));
    } else {
      state.project.screens[index] = cloneScreen(state.ui.screenDraft);
    }
    persistProject();
    state.ui.modal = null;
    state.ui.screenId = null;
    state.ui.screenDraft = null;
    const savedScreen = state.project.screens.find((entry) => entry.id === screenId);
    state.actions.notice = `Saved ${savedScreen?.name || "device"}.`;
    state.actions.error = "";
    renderWorkspace();
    return;
  }

  if (action === "download-config") {
    downloadConfig();
    return;
  }

  if (action === "copy-config") {
    await navigator.clipboard.writeText(JSON.stringify(state.project, null, 2));
    return;
  }

  if (action === "apply-json") {
    await applyJson();
    return;
  }

  if (action === "reset-project") {
    state.project = structuredClone(DEFAULT_PROJECT);
    await refreshCatalogAndAlbums(state.project.screens.map((screen) => screen.albumSlug));
    persistProject();
    renderWorkspace();
    return;
  }

  if (action === "render-all") {
    await runWallAction("/api/actions/render", [], "Rendered enabled screens.");
    return;
  }

  if (action === "send-all-dry") {
    await runWallAction("/api/actions/send", [], "Dry-run send prepared for enabled screens.", true);
    return;
  }

  if (action === "send-all") {
    if (window.confirm("Send the current rendered posters to all enabled screens?")) {
      await runWallAction("/api/actions/send", [], "Sent enabled screens.");
    }
    return;
  }

  if (action === "render-send-all-dry") {
    await runWallAction("/api/actions/render-send", [], "Rendered and prepared dry-run send for enabled screens.", true);
    return;
  }

  if (action === "render-send-all") {
    if (window.confirm("Render and send posters to all enabled screens?")) {
      await runWallAction("/api/actions/render-send", [], "Rendered and sent enabled screens.");
    }
    return;
  }

  if (action === "render-screen" && screenId) {
    await runWallAction("/api/actions/render", [screenId], `Rendered ${screenName}.`);
    return;
  }

  if (action === "send-screen-dry" && screenId) {
    await runWallAction("/api/actions/send", [screenId], `Dry-run send prepared for ${screenName}.`, true);
    return;
  }

  if (action === "send-screen" && screenId) {
    if (window.confirm(`Send the current rendered poster to ${screenName}?`)) {
      await runWallAction("/api/actions/send", [screenId], `Sent ${screenName}.`);
    }
    return;
  }

  if (action === "render-send-screen-dry" && screenId) {
    await runWallAction("/api/actions/render-send", [screenId], `Rendered and prepared dry-run send for ${screenName}.`, true);
    return;
  }

  if (action === "render-send-screen" && screenId) {
    if (window.confirm(`Render and send a poster to ${screenName}?`)) {
      await runWallAction("/api/actions/render-send", [screenId], `Rendered and sent ${screenName}.`);
    }
    return;
  }

  if (action === "spotify-search-artists") {
    const query = document.getElementById("spotify-artist-query")?.value?.trim() || "";
    state.spotify.artistQuery = query;
    state.spotify.artistResults = query ? await apiGetJson(`/api/spotify/search/artists?q=${encodeURIComponent(query)}`) : [];
    state.spotify.artistView = "results";
    state.spotify.artistAlbums = [];
    state.spotify.selectedArtistName = "";
    state.spotify.notice = state.spotify.artistResults.length ? "" : "No artist matches found.";
    renderWorkspace();
    return;
  }

  if (action === "spotify-load-artist") {
    const artistId = button.dataset.artistId;
    const artist = state.spotify.artistResults.find((entry) => entry.id === artistId);
    state.spotify.artistView = "albums";
    state.spotify.artistAlbums = await apiGetJson(`/api/spotify/artists/${artistId}/albums`);
    state.spotify.selectedArtistName = artist?.name || "Artist";
    state.spotify.notice = `Loaded ${state.spotify.artistAlbums.length} releases for ${state.spotify.selectedArtistName}.`;
    renderWorkspace();
    scrollToElement(".spotify-results--albums", { block: "nearest" });
    return;
  }

  if (action === "spotify-back-to-artists") {
    state.spotify.artistView = "results";
    state.spotify.artistAlbums = [];
    state.spotify.notice = "";
    renderWorkspace();
    return;
  }

  if (action === "spotify-import-album") {
    const albumId = button.dataset.albumId;
    const imported = await apiPostJson("/api/import/spotify/album", { albumId });
    await refreshCatalogAndAlbums([imported.slug]);
    state.studio.albumArt.recentImportedSlugs = [imported.slug, ...state.studio.albumArt.recentImportedSlugs.filter((slug) => slug !== imported.slug)].slice(0, 12);
    state.studio.albumArt.selectedSlugs = [imported.slug, ...state.studio.albumArt.selectedSlugs.filter((slug) => slug !== imported.slug)];
    state.spotify.notice = `Imported ${imported.artist} - ${imported.album}.`;
    renderWorkspace();
    scrollToElement(`#studio-album-${imported.slug}`, { block: "center" });
    return;
  }

  if (action === "spotify-import-playlist") {
    const playlistInput = document.getElementById("spotify-playlist-query")?.value?.trim() || "";
    state.spotify.playlistQuery = playlistInput;
    const imported = await apiPostJson("/api/import/spotify/playlist", { playlistId: playlistInput });
    await refreshCatalogAndAlbums(imported.map((album) => album.slug));
    state.studio.albumArt.recentImportedSlugs = [
      ...imported.map((album) => album.slug),
      ...state.studio.albumArt.recentImportedSlugs.filter((slug) => !imported.some((album) => album.slug === slug))
    ].slice(0, 20);
    state.studio.albumArt.selectedSlugs = [
      ...imported.map((album) => album.slug),
      ...state.studio.albumArt.selectedSlugs.filter((slug) => !imported.some((album) => album.slug === slug))
    ];
    state.spotify.notice = `Imported ${imported.length} albums from playlist.`;
    renderWorkspace();
    if (imported[0]?.slug) {
      scrollToElement(`#studio-album-${imported[0].slug}`, { block: "center" });
    }
  }
}

async function handleContentUpload(event) {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }

  const replaceName = state.ui.contentReplaceImage || "";
  const uploaded = await apiUploadImage("/api/output-images/upload", file, replaceName ? { replaceName } : {});
  const outputPayload = await loadOutputImages();
  state.outputImages = outputPayload.images || [];
  state.outputDirectory = outputPayload.directory || "";
  state.ui.contentSelectedImage = uploaded.image?.name || "";
  state.ui.contentReplaceImage = "";
  state.ui.contentManageMode = false;
  state.ui.contentManageSelections = [];
  state.actions.notice = uploaded.replaced
    ? `Replaced ${uploaded.replaced}${uploaded.image?.name && uploaded.image.name !== uploaded.replaced ? ` with ${uploaded.image.name}` : ""}.`
    : `Uploaded ${uploaded.image?.name || file.name}.`;
  state.actions.error = "";
  event.target.value = "";
  renderWorkspace();
}

async function runWallAction(endpoint, screenIds, successMessage, dryRun = false) {
  const payload = await apiPostJson(endpoint, {
    screenIds,
    dryRun
  });
  state.deviceState = await loadDeviceState();
  const ids = [
    ...(payload.results || []).map((result) => result.screenId),
    ...(payload.renderResults || []).map((result) => result.screenId),
    ...(payload.sendResults || []).map((result) => result.screenId)
  ];
  state.actions.notice = `${successMessage}${ids.length ? ` ${[...new Set(ids)].join(", ")}` : ""}`;
  renderWorkspace();
}

function setValueByPath(target, path, value) {
  const parts = path.split(".");
  let pointer = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    pointer = pointer[parts[index]];
  }
  pointer[parts.at(-1)] = value;
}

function createScreenDraft() {
  const nextIndex = state.project.screens.length + 1;
  return {
    id: `screen-${crypto.randomUUID().slice(0, 8)}`,
    name: `New Device ${nextIndex}`,
    enabled: true,
    profile: "music",
    template: "music-editorial-v1",
    albumSlug: state.catalog[0]?.slug || "ten",
    size: { width: 1440, height: 2560 },
    frame: {
      paddingTop: 60,
      paddingRight: 60,
      paddingBottom: 60,
      paddingLeft: 60,
      swatchCount: 5,
      imageFit: "cover"
    },
    device: {
      host: "",
      pin: "",
      mac: "",
      localIp: ""
    }
  };
}

function duplicateScreen(screenId) {
  const original = state.project.screens.find((screen) => screen.id === screenId);
  if (!original) {
    return;
  }
  const duplicate = {
    ...structuredClone(original),
    id: `screen-${crypto.randomUUID().slice(0, 8)}`,
    name: `${original.name} Copy`
  };
  state.project.screens.push(duplicate);
  state.ui.modal = "screen";
  state.ui.screenId = duplicate.id;
  state.ui.screenDraft = cloneScreen(duplicate);
  persistProject();
  renderWorkspace();
}

function moveScreen(screenId, direction) {
  const index = state.project.screens.findIndex((screen) => screen.id === screenId);
  if (index === -1) {
    return;
  }

  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= state.project.screens.length) {
    return;
  }

  const screens = [...state.project.screens];
  const [screen] = screens.splice(index, 1);
  screens.splice(nextIndex, 0, screen);
  state.project.screens = screens;
  persistProject();
  state.actions.notice = `Moved ${screen.name} ${direction < 0 ? "earlier" : "later"} in the list.`;
  state.actions.error = "";
  renderWorkspace();
}

async function runDiscoveryScan() {
  state.discovery.loading = true;
  state.discovery.error = "";
  renderWorkspace();

  try {
    const payload = await apiPostJson("/api/devices/discover", {});
    state.discovery.loading = false;
    state.discovery.network = {
      localIp: payload.localIp,
      cidr: payload.cidr,
      subnet: payload.subnet,
      broadcast: payload.broadcast
    };
    state.discovery.results = payload.results || [];
  } catch (error) {
    state.discovery.loading = false;
    state.discovery.error = error.message;
    state.discovery.results = [];
  }

  renderWorkspace();
}

function downloadConfig() {
  const blob = new Blob([JSON.stringify(state.project, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "project.json";
  link.click();
  URL.revokeObjectURL(url);
}

async function applyJson() {
  const text = document.getElementById("config-json").value;
  state.project = normalizeProject(JSON.parse(text));
  await refreshCatalogAndAlbums(state.project.screens.map((screen) => screen.albumSlug));
  persistProject();
  renderWorkspace();
}

function decodeBase64Url(value) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return atob(padded);
}

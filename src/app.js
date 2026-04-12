import { apiDeleteJson, apiGetJson, apiPostJson, apiPutJson, apiUploadImage } from "./api.js";
import { DEFAULT_PROJECT } from "./default-project.js";
import { getStudioPluginById, STUDIO_PLUGINS } from "./plugin-registry.js";
import { getTemplateById, TEMPLATE_REGISTRY } from "./template-registry.js";
import { normalizeMusicAlbum } from "./template-utils.js";

const STORAGE_KEY = "poster-wall-project-v3";
const UI_STORAGE_KEY = "poster-wall-ui-v1";
const SPOTIFY_ARTIST_ALBUM_PAGE_SIZE = 10;
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
    toasts: [],
    lastActionNotice: "",
    lastActionError: "",
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
    contentLibraryFilter: "all",
    contentLibrarySearch: "",
    contentLibrarySort: "recent",
    contentManageMode: false,
    contentManageSelections: [],
    contentEdit: null,
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
    albumQuery: "",
    playlistQuery: "",
    artistView: "results",
    artistResults: [],
    albumResults: [],
    artistAlbums: [],
    artistAlbumsPage: 1,
    artistAlbumsTotal: 0,
    artistAlbumsHasMore: false,
    artistAlbumFilter: "album",
    selectedArtistId: "",
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
      step: "pick",
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
  const rawScreens = project.screens || base.screens;
  const baseScreen = base.screens[0];
  const normalizedRooms = new Map((project.rooms || []).map((room) => [room.id, room]));
  const normalizedWalls = new Map((project.walls || []).map((wall) => [wall.id, wall]));
  const contentLibrary = normalizeContentLibrary(project.contentLibrary || base.contentLibrary);

  const screens = rawScreens.map((screen, index) => {
    const nextScreen = {
      ...structuredClone(base.screens[index % base.screens.length]),
      ...screen,
      size: { ...baseScreen.size, ...(screen.size || {}) },
      frame: { ...baseScreen.frame, ...(screen.frame || {}) },
      device: { ...baseScreen.device, ...(screen.device || {}) }
    };

    const inferredRoomName = inferRoomName(nextScreen.name);
    const roomId = nextScreen.roomId || createLocationId(inferredRoomName || "ungrouped");
    const roomName = nextScreen.roomName || normalizedRooms.get(roomId)?.name || inferredRoomName || humanizeLocationId(roomId);
    const inferredWallName = inferWallName(nextScreen.name, roomName);
    const wallId = nextScreen.wallId || createLocationId(`${roomId}-${inferredWallName || "wall"}`);
    const wallName = nextScreen.wallName || normalizedWalls.get(wallId)?.name || inferredWallName || humanizeLocationId(wallId);
    const wallSlot = nextScreen.wallSlot || inferWallSlot(nextScreen.name) || "";

    normalizedRooms.set(roomId, { id: roomId, name: roomName });
    normalizedWalls.set(wallId, { id: wallId, roomId, name: wallName });

    return {
      ...nextScreen,
      roomId,
      roomName,
      wallId,
      wallName,
      wallSlot
    };
  });

  return {
    ...base,
    ...project,
    contentLibrary,
    rooms: [...normalizedRooms.values()],
    walls: [...normalizedWalls.values()],
    screens
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

async function loadSpotifyArtistAlbumsPage({ artistId, filter = "album", offset = 0, append = false } = {}) {
  if (!artistId) {
    state.spotify.artistAlbums = [];
    state.spotify.artistAlbumsPage = 1;
    state.spotify.artistAlbumsTotal = 0;
    state.spotify.artistAlbumsHasMore = false;
    return;
  }

  const payload = await apiGetJson(
    `/api/spotify/artists/${artistId}/albums?filter=${encodeURIComponent(filter)}&offset=${offset}`,
  );
  const nextItems = payload.items || [];
  state.spotify.artistAlbums = append ? [...state.spotify.artistAlbums, ...nextItems] : nextItems;
  state.spotify.artistAlbumsTotal = payload.total || nextItems.length;
  state.spotify.artistAlbumsHasMore = Boolean(payload.hasMore);
  state.spotify.artistAlbumsPage = Math.floor((offset + nextItems.length) / SPOTIFY_ARTIST_ALBUM_PAGE_SIZE) || 1;
}

function persistProject() {
  state.project = normalizeProject(state.project);
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
  if (diagnostic.loading) {
    return "Checking...";
  }
  if (diagnostic.waking) {
    return "Waking...";
  }
  if (diagnostic.status?.checkedAt) {
    return `Checked ${formatDateTime(diagnostic.status.checkedAt)}`;
  }
  if (diagnostic.error || diagnostic.status?.error) {
    return "Status unavailable";
  }
  return "No live check yet";
}

function getDeviceCardStatus(screenId) {
  const diagnostic = getDeviceDiagnostic(screenId);
  if (diagnostic.loading) {
    return { label: "Checking", tone: "is-checking" };
  }
  if (diagnostic.waking) {
    return { label: "Waking", tone: "is-checking" };
  }
  if (diagnostic.status?.reachable) {
    return { label: "Online", tone: "is-online" };
  }
  if (diagnostic.error || diagnostic.status?.error || diagnostic.status?.reachable === false) {
    return { label: "Offline", tone: "is-offline" };
  }
  return { label: "Unknown", tone: "is-unknown" };
}

function summarizeDeviceStatus(status) {
  if (!status) {
    return {
      title: "No live status checked yet",
      detail: "Use Check Status or Wake to ask the frame directly."
    };
  }

  const title = status.powerState
    ? `Power ${status.powerState}`
    : status.reachable ? "Reachable" : "Unreachable";

  const details = [];

  if (typeof status.latencyMs === "number") {
    details.push(`${status.latencyMs} ms`);
  }
  if (status.battery?.batteryPercent != null) {
    details.push(`${status.battery.batteryPercent}% battery`);
  }
  if (status.error && !status.powerState) {
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
        aria-label="Refresh device status"
        title="Refresh device status"
        ${isBusy ? "disabled" : ""}
      >
        ${iconSvg("refresh")}
        ${compact ? "" : `<span>${diagnostic.loading ? "Refreshing..." : "Refresh Status"}</span>`}
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
        ${compact ? "" : `<span>${diagnostic.waking ? "Waking..." : "Wake Device"}</span>`}
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

function getFitCheckTargetScreens() {
  const selected = getContentTargetScreens();
  if (selected.length) {
    return selected;
  }
  return state.project.screens.filter((screen) => screen.enabled);
}

function screenOrientation(screen) {
  const w = screen?.size?.width || 0;
  const h = screen?.size?.height || 0;
  if (!w || !h) return null;
  if (Math.abs(w / h - 1) < 0.02) return "square";
  return w > h ? "landscape" : "portrait";
}

function screenAspectRatio(screen) {
  const w = screen?.size?.width || 0;
  const h = screen?.size?.height || 0;
  if (!w || !h) return null;
  return Math.round((w / h) * 1000) / 1000;
}

function evaluateImageFit(image, targetScreens) {
  if (!image.width || !image.height || !targetScreens?.length) {
    return { status: "unknown", warnings: [] };
  }
  const imageOrientation = image.orientation;
  const imageAspect = image.aspectRatio;
  const mismatchedOrientation = [];
  const mismatchedAspect = [];
  let exactFit = false;

  for (const screen of targetScreens) {
    const targetOrientation = screenOrientation(screen);
    const targetAspect = screenAspectRatio(screen);
    if (!targetAspect) continue;

    if (imageOrientation && targetOrientation && imageOrientation !== targetOrientation && imageOrientation !== "square") {
      mismatchedOrientation.push(screen);
      continue;
    }
    const aspectDelta = Math.abs(imageAspect - targetAspect) / targetAspect;
    if (aspectDelta > 0.1) {
      mismatchedAspect.push({ screen, delta: aspectDelta });
    } else {
      exactFit = true;
    }
  }

  if (mismatchedOrientation.length) {
    return {
      status: "warn-orientation",
      warnings: mismatchedOrientation,
      label: "Wrong orientation",
      title: `Image is ${imageOrientation}, target screen${mismatchedOrientation.length > 1 ? "s are" : " is"} ${screenOrientation(mismatchedOrientation[0])}.`
    };
  }
  if (mismatchedAspect.length && !exactFit) {
    return {
      status: "warn-aspect",
      warnings: mismatchedAspect,
      label: "Aspect mismatch",
      title: `Image aspect ${imageAspect} differs from target screen${mismatchedAspect.length > 1 ? "s" : ""}; will crop or letterbox.`
    };
  }
  return { status: "ok", warnings: [] };
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
      { title: "Preparing", detail: "Validating image and waking displays.", icon: "wake", state: "active" },
      { title: "Connecting", detail: "Establishing MDC connection to frame.", icon: "connect", state: "pending" },
      { title: "Commanding", detail: "Setting the content download URL.", icon: "command", state: "pending" },
      { title: "Fetching", detail: "Frame is downloading content.json and image.", icon: "download", state: "pending" },
      { title: "Delivered", detail: "Image received by all target frames.", icon: "check", state: "pending" }
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
    { title: "Preparing", detail: "Validating image and waking displays.", icon: "wake" },
    { title: "Connecting", detail: "Establishing MDC connection to frame.", icon: "connect" },
    { title: "Commanding", detail: "Setting the content download URL.", icon: "command" },
    { title: "Fetching", detail: "Frame is downloading content.json and image.", icon: "download" },
    { title: "Delivered", detail: "Image received by all target frames.", icon: "check" }
  ];

  const completion = [prepared && (woke || !targets.some((target) => target.host)), contentSet, contentFetched, contentFetched && any((target) => target.milestones?.imageFetched), imageFetched];
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
    if (failed && index === steps.length - 1 && targets.some((t) => t.status === "unverified")) {
      return { ...step, title: "Unverified", detail: "Frame did not confirm receipt.", state: "error" };
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
  state.ui.contentLibraryFilter = "all";
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

function createLocationId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "ungrouped";
}

const EDIT_RECIPE_DEFAULTS = Object.freeze({
  fit: "contain",
  cropAnchor: "center",
  rotate: 0,
  grayscale: false,
  invert: false,
  brightness: 1,
  contrast: 1,
  gamma: 1,
  sharpen: 0,
  blur: 0,
  blackPoint: 0,
  whitePoint: 1,
  targetScreenId: null
});

const EDIT_FIT_MODES = new Set(["contain", "cover"]);
const EDIT_CROP_ANCHORS = new Set(["center", "top", "bottom", "left", "right"]);
const EDIT_ROTATIONS = new Set([0, 90, 180, 270]);

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) {
    return null;
  }
  return Math.min(max, Math.max(min, value));
}

function getDefaultEditRecipe() {
  return { ...EDIT_RECIPE_DEFAULTS };
}

function isDefaultEditRecipe(recipe) {
  if (!recipe) {
    return true;
  }
  return (
    recipe.fit === EDIT_RECIPE_DEFAULTS.fit &&
    recipe.cropAnchor === EDIT_RECIPE_DEFAULTS.cropAnchor &&
    recipe.rotate === EDIT_RECIPE_DEFAULTS.rotate &&
    recipe.grayscale === EDIT_RECIPE_DEFAULTS.grayscale &&
    recipe.invert === EDIT_RECIPE_DEFAULTS.invert &&
    recipe.brightness === EDIT_RECIPE_DEFAULTS.brightness &&
    recipe.contrast === EDIT_RECIPE_DEFAULTS.contrast &&
    recipe.gamma === EDIT_RECIPE_DEFAULTS.gamma &&
    recipe.sharpen === EDIT_RECIPE_DEFAULTS.sharpen &&
    recipe.blur === EDIT_RECIPE_DEFAULTS.blur &&
    recipe.blackPoint === EDIT_RECIPE_DEFAULTS.blackPoint &&
    recipe.whitePoint === EDIT_RECIPE_DEFAULTS.whitePoint &&
    !recipe.targetScreenId
  );
}

function normalizeEditRecipe(input) {
  if (!input || typeof input !== "object") {
    return null;
  }
  const fit = EDIT_FIT_MODES.has(input.fit) ? input.fit : EDIT_RECIPE_DEFAULTS.fit;
  const cropAnchor = EDIT_CROP_ANCHORS.has(input.cropAnchor) ? input.cropAnchor : EDIT_RECIPE_DEFAULTS.cropAnchor;
  const rotate = EDIT_ROTATIONS.has(Number(input.rotate)) ? Number(input.rotate) : EDIT_RECIPE_DEFAULTS.rotate;
  const grayscale = Boolean(input.grayscale);
  const invert = Boolean(input.invert);
  const brightness = clampNumber(Number(input.brightness), 0.5, 1.5) ?? EDIT_RECIPE_DEFAULTS.brightness;
  const contrast = clampNumber(Number(input.contrast), 0.5, 1.5) ?? EDIT_RECIPE_DEFAULTS.contrast;
  const gamma = clampNumber(Number(input.gamma), 1, 3) ?? EDIT_RECIPE_DEFAULTS.gamma;
  const sharpen = clampNumber(Number(input.sharpen), 0, 5) ?? EDIT_RECIPE_DEFAULTS.sharpen;
  const blur = clampNumber(Number(input.blur), 0, 5) ?? EDIT_RECIPE_DEFAULTS.blur;
  const blackPoint = clampNumber(Number(input.blackPoint), 0, 0.4) ?? EDIT_RECIPE_DEFAULTS.blackPoint;
  const whitePoint = clampNumber(Number(input.whitePoint), 0.6, 1) ?? EDIT_RECIPE_DEFAULTS.whitePoint;
  const targetScreenId = typeof input.targetScreenId === "string" && input.targetScreenId.trim()
    ? input.targetScreenId.trim()
    : null;
  const recipe = {
    fit, cropAnchor, rotate, grayscale, invert, brightness, contrast,
    gamma, sharpen, blur, blackPoint, whitePoint, targetScreenId,
    updatedAt: typeof input.updatedAt === "string" && input.updatedAt ? input.updatedAt : new Date().toISOString()
  };
  return isDefaultEditRecipe(recipe) ? null : recipe;
}

function normalizeContentLibrary(contentLibrary = {}) {
  const collections = Array.isArray(contentLibrary.collections)
    ? contentLibrary.collections
        .map((collection) => ({
          id: createLocationId(collection.id || collection.name || crypto.randomUUID()),
          name: String(collection.name || "").trim()
        }))
        .filter((collection) => collection.name)
    : [];
  const collectionIds = new Set(collections.map((collection) => collection.id));

  const items = contentLibrary.items && typeof contentLibrary.items === "object"
    ? Object.fromEntries(
        Object.entries(contentLibrary.items).map(([imageName, meta]) => {
          const tags = Array.isArray(meta?.tags)
            ? [...new Set(meta.tags.map((tag) => String(tag || "").trim()).filter(Boolean))]
            : [];
          const nextCollectionIds = Array.isArray(meta?.collectionIds)
            ? [...new Set(meta.collectionIds.filter((id) => collectionIds.has(id)))]
            : [];
          const editRecipe = normalizeEditRecipe(meta?.editRecipe || null);
          return [imageName, { tags, collectionIds: nextCollectionIds, editRecipe }];
        }),
      )
    : {};

  const sets = Array.isArray(contentLibrary.sets)
    ? contentLibrary.sets
        .map((set) => ({
          id: createLocationId(set.id || set.name || crypto.randomUUID()),
          name: String(set.name || "").trim(),
          collectionId: collectionIds.has(set.collectionId) ? set.collectionId : "",
          items: Array.isArray(set.items)
            ? set.items
                .map((item, index) => ({
                  imageName: String(item?.imageName || "").trim(),
                  position: Number.isFinite(item?.position) ? Number(item.position) : index + 1
                }))
                .filter((item) => item.imageName)
                .sort((a, b) => a.position - b.position)
            : []
        }))
        .filter((set) => set.name)
    : [];

  return {
    collections,
    sets,
    items
  };
}

function getContentLibrary() {
  return state.project?.contentLibrary || { collections: [], sets: [], items: {} };
}

function getContentImageMeta(imageName) {
  const contentLibrary = getContentLibrary();
  const meta = contentLibrary.items?.[imageName] || {};
  return {
    tags: Array.isArray(meta.tags) ? meta.tags : [],
    collectionIds: Array.isArray(meta.collectionIds) ? meta.collectionIds : [],
    editRecipe: meta.editRecipe || null
  };
}

function getCollectionById(collectionId) {
  return getContentLibrary().collections.find((collection) => collection.id === collectionId) || null;
}

function getSetMembershipByImageName() {
  const memberships = new Map();
  for (const set of getContentLibrary().sets) {
    for (const item of set.items || []) {
      memberships.set(item.imageName, {
        setId: set.id,
        setName: set.name,
        position: item.position,
        count: set.items.length
      });
    }
  }
  return memberships;
}

function getEnrichedOutputImages() {
  const memberships = getSetMembershipByImageName();
  return state.outputImages.map((image) => {
    const meta = getContentImageMeta(image.name);
    const collections = meta.collectionIds
      .map((collectionId) => getCollectionById(collectionId))
      .filter(Boolean);
    return {
      ...image,
      contentMeta: meta,
      collections,
      collectionNames: collections.map((collection) => collection.name),
      setMembership: memberships.get(image.name) || null,
      editRecipe: meta.editRecipe || null
    };
  });
}

function getVisibleOutputImages() {
  const images = getEnrichedOutputImages();
  const filter = state.ui.contentLibraryFilter || "all";
  let filtered = images;
  if (filter === "unassigned") {
    filtered = images.filter((image) => image.collectionNames.length === 0);
  } else if (filter.startsWith("collection:")) {
    const collectionId = filter.slice("collection:".length);
    filtered = images.filter((image) => image.contentMeta.collectionIds.includes(collectionId));
  }
  const query = (state.ui.contentLibrarySearch || "").trim().toLowerCase();
  if (query) {
    filtered = filtered.filter((image) => {
      if (image.name.toLowerCase().includes(query)) return true;
      if (image.collectionNames.some((name) => name.toLowerCase().includes(query))) return true;
      if ((image.contentMeta.tags || []).some((tag) => String(tag).toLowerCase().includes(query))) return true;
      if (image.orientation && image.orientation.toLowerCase().includes(query)) return true;
      if (image.format && image.format.toLowerCase().includes(query)) return true;
      return false;
    });
  }
  return sortOutputImages(filtered, state.ui.contentLibrarySort || "recent");
}

function sortOutputImages(images, sortKey) {
  const sorted = [...images];
  switch (sortKey) {
    case "name-asc":
      sorted.sort((a, b) => a.name.localeCompare(b.name));
      break;
    case "name-desc":
      sorted.sort((a, b) => b.name.localeCompare(a.name));
      break;
    case "oldest":
      sorted.sort((a, b) => String(a.modifiedAt || "").localeCompare(String(b.modifiedAt || "")));
      break;
    case "largest":
      sorted.sort((a, b) => ((b.width || 0) * (b.height || 0)) - ((a.width || 0) * (a.height || 0)));
      break;
    case "smallest":
      sorted.sort((a, b) => ((a.width || Infinity) * (a.height || Infinity)) - ((b.width || Infinity) * (b.height || Infinity)));
      break;
    case "recent":
    default:
      sorted.sort((a, b) => String(b.modifiedAt || "").localeCompare(String(a.modifiedAt || "")));
      break;
  }
  return sorted;
}

function getContentCollectionSummaries() {
  const images = getEnrichedOutputImages();
  const collections = getContentLibrary().collections.map((collection) => ({
    ...collection,
    count: images.filter((image) => image.contentMeta.collectionIds.includes(collection.id)).length
  }));
  const unassignedCount = images.filter((image) => image.collectionNames.length === 0).length;
  const setCount = getContentLibrary().sets.length;
  return {
    collections,
    total: images.length,
    unassignedCount,
    setCount
  };
}

function getActiveContentCollection() {
  const filter = state.ui.contentLibraryFilter || "all";
  if (!filter.startsWith("collection:")) {
    return null;
  }
  return getCollectionById(filter.slice("collection:".length));
}

function ensureContentCollection(name) {
  const trimmedName = String(name || "").trim();
  if (!trimmedName) {
    return null;
  }

  const existing = getContentLibrary().collections.find((collection) => collection.name.toLowerCase() === trimmedName.toLowerCase());
  if (existing) {
    return existing;
  }

  const collection = {
    id: createLocationId(trimmedName),
    name: trimmedName
  };
  state.project.contentLibrary.collections.push(collection);
  state.project.contentLibrary = normalizeContentLibrary(state.project.contentLibrary);
  return state.project.contentLibrary.collections.find((entry) => entry.id === collection.id) || collection;
}

function assignImagesToCollection(imageNames, collectionId) {
  if (!collectionId) {
    return 0;
  }
  const names = [...new Set(imageNames.filter(Boolean))];
  let changed = 0;
  for (const imageName of names) {
    const current = getContentImageMeta(imageName);
    if (current.collectionIds.includes(collectionId)) {
      continue;
    }
    state.project.contentLibrary.items[imageName] = {
      ...current,
      collectionIds: [...current.collectionIds, collectionId]
    };
    changed += 1;
  }
  state.project.contentLibrary = normalizeContentLibrary(state.project.contentLibrary);
  return changed;
}

function createContentSet(name, imageNames) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return null;
  const uniqueNames = [...new Set(imageNames.filter(Boolean))];
  if (uniqueNames.length < 2) return null;
  const id = createLocationId(`set-${trimmed}-${Date.now()}`);
  const set = {
    id,
    name: trimmed,
    collectionId: "",
    items: uniqueNames.map((imageName, index) => ({ imageName, position: index + 1 }))
  };
  state.project.contentLibrary.sets = [...(state.project.contentLibrary.sets || []), set];
  state.project.contentLibrary = normalizeContentLibrary(state.project.contentLibrary);
  return state.project.contentLibrary.sets.find((entry) => entry.id === id) || set;
}

function deleteContentSet(setId) {
  const before = (state.project.contentLibrary.sets || []).length;
  state.project.contentLibrary.sets = (state.project.contentLibrary.sets || []).filter((set) => set.id !== setId);
  const removed = before !== state.project.contentLibrary.sets.length;
  if (removed) {
    state.project.contentLibrary = normalizeContentLibrary(state.project.contentLibrary);
  }
  return removed;
}

function getContentSetById(setId) {
  return (getContentLibrary().sets || []).find((set) => set.id === setId) || null;
}

function clearImagesFromCollections(imageNames) {
  const names = [...new Set(imageNames.filter(Boolean))];
  let changed = 0;
  for (const imageName of names) {
    const current = getContentImageMeta(imageName);
    if (!current.collectionIds.length) {
      continue;
    }
    state.project.contentLibrary.items[imageName] = {
      ...current,
      collectionIds: []
    };
    changed += 1;
  }
  state.project.contentLibrary = normalizeContentLibrary(state.project.contentLibrary);
  return changed;
}

function pruneContentLibraryForImages(imageNames) {
  const names = new Set(imageNames.filter(Boolean));
  if (!names.size) {
    return;
  }

  for (const imageName of names) {
    delete state.project.contentLibrary.items[imageName];
  }

  state.project.contentLibrary.sets = state.project.contentLibrary.sets.map((set) => ({
    ...set,
    items: (set.items || []).filter((item) => !names.has(item.imageName))
  }));

  state.project.contentLibrary = normalizeContentLibrary(state.project.contentLibrary);
}

function migrateContentImageMeta(previousName, nextName) {
  if (!previousName || !nextName || previousName === nextName) {
    return;
  }
  const previousMeta = state.project.contentLibrary.items[previousName];
  if (!previousMeta) {
    return;
  }
  state.project.contentLibrary.items[nextName] = previousMeta;
  delete state.project.contentLibrary.items[previousName];
  state.project.contentLibrary.sets = state.project.contentLibrary.sets.map((set) => ({
    ...set,
    items: (set.items || []).map((item) => (item.imageName === previousName ? { ...item, imageName: nextName } : item))
  }));
  state.project.contentLibrary = normalizeContentLibrary(state.project.contentLibrary);
}

function humanizeLocationId(value) {
  return String(value || "ungrouped")
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function inferRoomName(deviceName = "") {
  const name = String(deviceName).trim();
  if (!name) {
    return "";
  }
  const lower = name.toLowerCase();
  if (lower.includes("office")) return "Office";
  if (lower.includes("basement")) return "Basement";
  if (lower.includes("living room")) return "Living Room";
  const leading = name.split(/[-:/|]/)[0]?.trim();
  if (leading && leading !== name) {
    return leading;
  }
  return "";
}

function inferWallName(deviceName = "", roomName = "") {
  const lower = String(deviceName).toLowerCase();
  if (lower.includes("poster wall")) return "Poster Wall";
  if (lower.includes("gallery wall")) return "Gallery Wall";
  if (lower.includes("desk")) return "Desk Frame";
  if (roomName) {
    return roomName === "Office" ? "Desk Frame" : `${roomName} Wall`;
  }
  return "";
}

function inferWallSlot(deviceName = "") {
  const lower = String(deviceName).toLowerCase();
  if (lower.includes("left")) return "left";
  if (lower.includes("center") || lower.includes("centre") || lower.includes("middle")) return "center";
  if (lower.includes("right")) return "right";
  const match = lower.match(/(?:^|[\s-])([123])(?:$|[\s-])/);
  if (match?.[1] === "1") return "left";
  if (match?.[1] === "2") return "center";
  if (match?.[1] === "3") return "right";
  return "";
}

function wallSlotLabel(slot = "") {
  return slot ? slot.charAt(0).toUpperCase() + slot.slice(1) : "Unassigned";
}

function getWallSortWeight(slot = "") {
  return { left: 1, center: 2, right: 3 }[slot] || 99;
}

function getGroupedScreens() {
  const roomMap = new Map();

  state.project.screens.forEach((screen) => {
    const roomId = screen.roomId || "ungrouped";
    const roomName = screen.roomName || humanizeLocationId(roomId);
    const wallId = screen.wallId || `${roomId}-wall`;
    const wallName = screen.wallName || humanizeLocationId(wallId);

    if (!roomMap.has(roomId)) {
      roomMap.set(roomId, { id: roomId, name: roomName, walls: new Map() });
    }

    const room = roomMap.get(roomId);
    if (!room.walls.has(wallId)) {
      room.walls.set(wallId, { id: wallId, name: wallName, screens: [] });
    }

    room.walls.get(wallId).screens.push(screen);
  });

  return [...roomMap.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((room) => ({
      ...room,
      walls: [...room.walls.values()]
        .map((wall) => ({
          ...wall,
          screens: [...wall.screens].sort((a, b) => {
            const slotDiff = getWallSortWeight(a.wallSlot) - getWallSortWeight(b.wallSlot);
            if (slotDiff !== 0) return slotDiff;
            return a.name.localeCompare(b.name);
          })
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
    }));
}

function getWallSlotOccupancy(wall) {
  const slots = new Map();
  wall.screens.forEach((screen) => {
    const key = screen.wallSlot || "unassigned";
    if (!slots.has(key)) {
      slots.set(key, []);
    }
    slots.get(key).push(screen);
  });

  const occupancy = [
    { id: "left", label: "Left", screens: slots.get("left") || [] },
    { id: "center", label: "Center", screens: slots.get("center") || [] },
    { id: "right", label: "Right", screens: slots.get("right") || [] },
    { id: "unassigned", label: "Unassigned", screens: slots.get("unassigned") || [] }
  ];

  return occupancy.filter((entry) => entry.id !== "unassigned" || entry.screens.length);
}

function getWallSlotWarnings(occupancy) {
  const warnings = occupancy
    .filter((slot) => slot.id !== "unassigned" && slot.screens.length > 1)
    .map((slot) => `${slot.label} has ${slot.screens.length} devices assigned.`);

  const missing = occupancy
    .filter((slot) => slot.id !== "unassigned" && slot.screens.length === 0)
    .map((slot) => slot.label.toLowerCase());

  if (missing.length) {
    warnings.push(`Missing slots: ${missing.join(", ")}.`);
  }

  return warnings;
}

function getRoomNameOptions() {
  return [...new Set((state.project.rooms || []).map((room) => room.name).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function getWallNameOptions(roomName = "") {
  const normalizedRoomId = createLocationId(roomName || "ungrouped");
  const matchingWalls = (state.project.walls || [])
    .filter((wall) => !roomName || wall.roomId === normalizedRoomId)
    .map((wall) => wall.name)
    .filter(Boolean);
  const allWalls = (state.project.walls || []).map((wall) => wall.name).filter(Boolean);

  const fallbackWalls = !matchingWalls.length && roomName
    ? state.project.screens
        .filter((screen) => createLocationId(screen.roomName || "") === normalizedRoomId)
        .map((screen) => screen.wallName)
        .filter(Boolean)
    : [];

  return [...new Set([...matchingWalls, ...fallbackWalls, ...allWalls])].sort((a, b) => a.localeCompare(b));
}

function createOptionsMarkup(options) {
  return options.map((option) => `<option value="${option}"></option>`).join("");
}

function pushToast(message, tone = "notice") {
  if (!message) {
    return;
  }

  const toast = {
    id: `toast-${crypto.randomUUID().slice(0, 8)}`,
    message,
    tone
  };
  state.ui.toasts = [...state.ui.toasts, toast].slice(-4);
  setTimeout(() => {
    const nextToasts = state.ui.toasts.filter((entry) => entry.id !== toast.id);
    if (nextToasts.length !== state.ui.toasts.length) {
      state.ui.toasts = nextToasts;
      renderWorkspace();
    }
  }, tone === "error" ? 5200 : 3400);
}

function flushActionToasts() {
  if (state.actions.notice) {
    if (state.actions.notice !== state.ui.lastActionNotice) {
      pushToast(state.actions.notice, "notice");
      state.ui.lastActionNotice = state.actions.notice;
    }
    state.actions.notice = "";
  } else {
    state.ui.lastActionNotice = "";
  }

  if (state.actions.error) {
    if (state.actions.error !== state.ui.lastActionError) {
      pushToast(state.actions.error, "error");
      state.ui.lastActionError = state.actions.error;
    }
    state.actions.error = "";
  } else {
    state.ui.lastActionError = "";
  }
}

function flushSpotifyToasts() {
  if (state.spotify.notice) {
    pushToast(state.spotify.notice, "notice");
    state.spotify.notice = "";
  }

  if (state.spotify.error) {
    pushToast(state.spotify.error, "error");
    state.spotify.error = "";
  }
}

function createToastLayer() {
  if (!state.ui.toasts.length) {
    return "";
  }

  return `
    <div class="toast-layer" aria-live="polite" aria-atomic="true">
      ${state.ui.toasts
        .map(
          (toast) => `
            <div class="toast toast--${toast.tone}" role="${toast.tone === "error" ? "alert" : "status"}">
              <span>${toast.message}</span>
              <button type="button" class="toast-dismiss" data-action="dismiss-toast" data-toast-id="${toast.id}" aria-label="Dismiss message">
                ${iconSvg("close")}
              </button>
            </div>
          `,
        )
        .join("")}
    </div>
  `;
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
    music: `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M15 5v10.2a2.8 2.8 0 1 1-1.5-2.48V8.2l-6 1.5v7.5a2.8 2.8 0 1 1-1.5-2.48V8.5c0-.69.47-1.29 1.14-1.46L15 5z" />
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
    refresh: `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M21 12a9 9 0 1 1-2.64-6.36" />
        <path d="M21 3v6h-6" />
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
    edit: `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 20h4l10-10-4-4L4 16v4z" />
        <path d="M14 6l4 4" />
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
    `,
  };

  return icons[type] || "";
}

function createScreenForm(screen) {
  const roomOptions = getRoomNameOptions();
  const wallOptions = getWallNameOptions(screen.roomName);
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
          Room
          <input type="text" data-path="roomName" value="${screen.roomName || ""}" placeholder="Office" list="room-name-options" />
        </label>
        <label>
          Wall
          <input type="text" data-path="wallName" value="${screen.wallName || ""}" placeholder="Poster Wall" list="wall-name-options" />
        </label>
        <label>
          Wall Slot
          <select data-path="wallSlot">
            <option value="" ${!screen.wallSlot ? "selected" : ""}>Unassigned</option>
            <option value="left" ${screen.wallSlot === "left" ? "selected" : ""}>Left</option>
            <option value="center" ${screen.wallSlot === "center" ? "selected" : ""}>Center</option>
            <option value="right" ${screen.wallSlot === "right" ? "selected" : ""}>Right</option>
          </select>
        </label>
      </div>
      <datalist id="room-name-options">${createOptionsMarkup(roomOptions)}</datalist>
      <datalist id="wall-name-options">${createOptionsMarkup(wallOptions)}</datalist>

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
  const status = getDeviceCardStatus(screen.id);
  const screenIndex = state.project.screens.findIndex((entry) => entry.id === screen.id);
  const isFirst = screenIndex <= 0;
  const isLast = screenIndex === state.project.screens.length - 1;

  return `
    <article class="preview-card device-card">
      <div class="preview-card-header">
        <div>
          <div class="device-card-title-row">
            <h3>${screen.name}</h3>
            <span class="device-status-chip ${status.tone}">${status.label}</span>
          </div>
          <p>${screen.wallSlot ? `${wallSlotLabel(screen.wallSlot)} slot` : "Unassigned slot"} · ${getDeviceCardMeta(screen.id)}</p>
        </div>
        <div class="preview-head-tools">
          <button
            type="button"
            class="icon-button icon-button--ghost icon-button--small"
            data-action="check-device-status"
            data-screen-id="${screen.id}"
            aria-label="Refresh status for ${screen.name}"
            title="Refresh status"
          >
            ${iconSvg("refresh")}
          </button>
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
            ? `<img class="device-preview-image" src="${preview.url}" alt="Last image sent to ${screen.name}" />
               <span class="device-preview-label">${preview.label}</span>`
            : `<div class="device-preview-placeholder">No image sent from this app yet.</div>`
        }
      </div>
      <div class="device-card-footer">
        <button type="button" class="device-content-button" data-action="open-content" data-screen-id="${screen.id}">
          Change Content
        </button>
      </div>
    </article>
  `;
}

function formatImageDimensions(image) {
  if (!image.width || !image.height) {
    return "";
  }
  const parts = [`${image.width}×${image.height}`];
  if (image.orientation) {
    parts.push(image.orientation);
  }
  if (image.format) {
    parts.push(String(image.format).toUpperCase());
  }
  return parts.join(" · ");
}

function createOutputImageCard(image) {
  const isManageMode = state.ui.contentManageMode;
  const isSelected = isManageMode
    ? state.ui.contentManageSelections.includes(image.name)
    : state.ui.contentSelectedImage === image.name;
  const fitCheck = evaluateImageFit(image, getFitCheckTargetScreens());
  const fitChip = fitCheck.status.startsWith("warn")
    ? `<span class="content-meta-chip content-meta-chip--warn" title="${fitCheck.title}">${fitCheck.label}</span>`
    : "";
  const badges = [
    fitChip,
    ...image.collectionNames.map((name) => `<span class="content-meta-chip">${name}</span>`),
    image.setMembership
      ? `<span class="content-meta-chip content-meta-chip--set">${image.setMembership.setName} ${image.setMembership.position}/${image.setMembership.count}</span>`
      : "",
    image.editRecipe ? `<span class="content-meta-chip content-meta-chip--edited">Edited</span>` : ""
  ].filter(Boolean);
  const dimensionsLine = formatImageDimensions(image);
  const metaLine = dimensionsLine
    ? `${dimensionsLine} · ${formatBytes(image.size)}`
    : `${formatDateTime(image.modifiedAt)} · ${formatBytes(image.size)}`;
  const previewAction = isManageMode ? "select-content-image" : "open-content-preview";
  return `
    <article
      class="output-card ${isSelected ? "is-selected" : ""} ${isManageMode ? "is-manage-mode" : ""}"
      data-image-name="${image.name}"
    >
      ${
        !isManageMode
          ? `
            <div class="output-card-actions">
              <button
                type="button"
                class="icon-button icon-button--ghost icon-button--small"
                data-action="open-content-edit"
                data-image-name="${image.name}"
                aria-label="Edit ${image.name}"
                title="Edit image"
              >
                ${iconSvg("edit")}
              </button>
              <button
                type="button"
                class="icon-button icon-button--ghost icon-button--small"
                data-action="open-content-preview"
                data-image-name="${image.name}"
                aria-label="Preview ${image.name}"
                title="Preview image"
              >
                ${iconSvg("zoom")}
              </button>
            </div>
          `
          : ""
      }
      <button
        type="button"
        class="output-card-preview"
        data-action="${previewAction}"
        data-image-name="${image.name}"
        aria-label="${isManageMode ? `Select ${image.name}` : `Preview ${image.name}`}"
      >
        ${isManageMode ? `<span class="output-card-select ${isSelected ? "is-selected" : ""}"></span>` : ""}
        <img src="${image.url}?t=${encodeURIComponent(image.modifiedAt)}" alt="${image.name}" />
      </button>
      <button
        type="button"
        class="output-card-copy"
        data-action="select-content-image"
        data-image-name="${image.name}"
      >
        <strong>${image.name}</strong>
        <span>${metaLine}</span>
        ${badges.length ? `<div class="content-meta-row">${badges.join("")}</div>` : ""}
      </button>
    </article>
  `;
}

function createContentBrowseCollectionsPanel() {
  const summary = getContentCollectionSummaries();
  if (!summary.collections.length) {
    return `
      <section class="content-library-panel content-library-panel--browse">
        <div class="content-library-copy">
          <span class="device-summary-kicker">Collections</span>
          <strong>Browse all posters</strong>
          <span>When you are ready to organize themes like movie posters or US locations, use Manage Library to create collections.</span>
        </div>
      </section>
    `;
  }

  const collectionCards = summary.collections.map((collection) => {
    const isSelected = state.ui.contentLibraryFilter === `collection:${collection.id}`;
    return `
      <button
        type="button"
        class="content-collection-card ${isSelected ? "is-selected" : ""}"
        data-action="filter-content-library"
        data-filter="collection:${collection.id}"
      >
        <span class="device-summary-kicker">Collection</span>
        <strong>${collection.name}</strong>
        <span>${collection.count} image${collection.count === 1 ? "" : "s"}</span>
      </button>
    `;
  }).join("");

  return `
    <section class="content-library-panel content-library-panel--browse">
      <div class="content-library-row content-library-row--browse">
        <div class="content-library-copy">
          <span class="device-summary-kicker">Collections</span>
          <strong>${summary.collections.length} collection${summary.collections.length === 1 ? "" : "s"} ready</strong>
          <span>Open a collection to browse a theme quickly. Use Manage Library only when you want to organize posters.</span>
        </div>
      </div>
      <div class="content-collection-grid">
        <button
          type="button"
          class="content-collection-card ${state.ui.contentLibraryFilter === "all" ? "is-selected" : ""}"
          data-action="filter-content-library"
          data-filter="all"
        >
          <span class="device-summary-kicker">Library</span>
          <strong>All Posters</strong>
          <span>${summary.total} image${summary.total === 1 ? "" : "s"}</span>
        </button>
        ${collectionCards}
      </div>
    </section>
  `;
}

function createContentSetsPanel() {
  const sets = getContentLibrary().sets || [];
  if (!sets.length) return "";
  const enabledScreens = state.project.screens.filter((screen) => screen.enabled);
  return `
    <section class="content-library-panel content-library-panel--sets">
      <div class="content-library-copy">
        <span class="device-summary-kicker">Ordered Sets</span>
        <strong>${sets.length} set${sets.length === 1 ? "" : "s"} ready to send</strong>
        <span>Each set maps position 1..N to the first ${enabledScreens.length} enabled frame${enabledScreens.length === 1 ? "" : "s"}. Send Set dispatches every position in parallel.</span>
      </div>
      <div class="content-set-grid">
        ${sets.map((set) => createContentSetCard(set, enabledScreens)).join("")}
      </div>
    </section>
  `;
}

function createContentSetCard(set, enabledScreens) {
  const positions = set.items || [];
  const canSend = positions.length > 0 && enabledScreens.length >= positions.length;
  const imagesByName = new Map(state.outputImages.map((image) => [image.name, image]));
  const thumbs = positions.map((item) => {
    const image = imagesByName.get(item.imageName);
    const src = image ? `${image.url}?t=${encodeURIComponent(image.modifiedAt)}` : "";
    const targetScreen = enabledScreens[item.position - 1] || null;
    const mapLabel = targetScreen ? targetScreen.name : "No frame";
    return `
      <div class="content-set-thumb">
        <div class="content-set-thumb-image">
          ${src ? `<img src="${src}" alt="${item.imageName}" />` : `<span class="content-set-thumb-missing">Missing</span>`}
          <span class="content-set-position-badge">${item.position}</span>
        </div>
        <div class="content-set-thumb-meta">
          <strong>${item.imageName}</strong>
          <span>→ ${mapLabel}</span>
        </div>
      </div>
    `;
  }).join("");
  const sendTitle = canSend
    ? `Send ${set.name} to ${positions.length} frame${positions.length === 1 ? "" : "s"}`
    : `Enable at least ${positions.length} frame${positions.length === 1 ? "" : "s"} to send this set`;
  return `
    <article class="content-set-card" data-set-id="${set.id}">
      <header class="content-set-card-header">
        <div class="content-set-card-copy">
          <strong>${set.name}</strong>
          <span>${positions.length} position${positions.length === 1 ? "" : "s"}</span>
        </div>
        <button type="button" class="icon-button icon-button--ghost icon-button--small" data-action="delete-content-set" data-set-id="${set.id}" aria-label="Delete set">×</button>
      </header>
      <div class="content-set-card-thumbs">${thumbs}</div>
      <footer class="content-set-card-footer">
        <button type="button" data-action="send-content-set" data-set-id="${set.id}" ${canSend ? "" : "disabled"} title="${sendTitle}">Send Set</button>
      </footer>
    </article>
  `;
}

function createContentBrowseToolbar() {
  const query = state.ui.contentLibrarySearch || "";
  const sortKey = state.ui.contentLibrarySort || "recent";
  const totalCount = state.outputImages.length;
  const visibleCount = getVisibleOutputImages().length;
  const hasFilter = (state.ui.contentLibraryFilter || "all") !== "all" || Boolean(query);
  return `
    <div class="content-library-toolbar">
      <div class="content-library-toolbar-search">
        <input
          id="content-library-search"
          type="search"
          placeholder="Search by name, tag, collection, orientation"
          value="${query.replace(/"/g, "&quot;")}"
          autocomplete="off"
          spellcheck="false"
        />
        ${query ? `<button type="button" class="content-library-toolbar-clear" data-action="clear-content-library-search" aria-label="Clear search">×</button>` : ""}
      </div>
      <div class="content-library-toolbar-controls">
        <label class="content-library-toolbar-sort">
          <span>Sort</span>
          <select id="content-library-sort">
            <option value="recent" ${sortKey === "recent" ? "selected" : ""}>Newest first</option>
            <option value="oldest" ${sortKey === "oldest" ? "selected" : ""}>Oldest first</option>
            <option value="name-asc" ${sortKey === "name-asc" ? "selected" : ""}>Name A→Z</option>
            <option value="name-desc" ${sortKey === "name-desc" ? "selected" : ""}>Name Z→A</option>
            <option value="largest" ${sortKey === "largest" ? "selected" : ""}>Largest resolution</option>
            <option value="smallest" ${sortKey === "smallest" ? "selected" : ""}>Smallest resolution</option>
          </select>
        </label>
        <span class="content-library-toolbar-count">${visibleCount} of ${totalCount}</span>
        ${hasFilter ? `<button type="button" class="content-library-toolbar-reset" data-action="reset-content-library-filters">Reset</button>` : ""}
      </div>
    </div>
  `;
}

function createContentCollectionScopePanel() {
  const activeCollection = getActiveContentCollection();
  if (!activeCollection) {
    return "";
  }
  const visibleCount = getVisibleOutputImages().length;
  return `
    <section class="content-scope-panel">
      <div class="content-library-copy">
        <span class="device-summary-kicker">Collection</span>
        <strong>${activeCollection.name}</strong>
        <span>${visibleCount} image${visibleCount === 1 ? "" : "s"} in this collection. Browse here, then pick a poster and send it like normal.</span>
      </div>
      <div class="content-scope-actions">
        <button type="button" class="secondary" data-action="filter-content-library" data-filter="all">View All Posters</button>
      </div>
    </section>
  `;
}

function createContentManagePanel() {
  const summary = getContentCollectionSummaries();
  const selectedCount = state.ui.contentManageSelections.length;
  return `
    <section class="content-library-panel content-library-panel--manage">
      <div class="content-library-row">
        <div class="content-library-copy">
          <span class="device-summary-kicker">Manage Library</span>
          <strong>Organize posters into collections</strong>
          <span>Select posters below, create a collection if needed, then assign the selection. Collections are for browseable themes. Ordered sets stay reserved for multi-frame layouts.</span>
        </div>
        <div class="content-library-create-stack">
          <div class="spotify-search-row manage-search-row content-library-create-row">
            <input id="content-collection-name" type="text" placeholder="Create collection, like Movie Posters" />
            <button type="button" data-action="create-content-collection">Create Collection</button>
          </div>
          <div class="spotify-search-row manage-search-row content-library-create-row">
            <input id="content-set-name" type="text" placeholder="Create ordered set from selection, like Triptych" />
            <button type="button" data-action="create-content-set" ${selectedCount >= 2 ? "" : "disabled"}>Create Set${selectedCount >= 2 ? ` (${selectedCount})` : ""}</button>
          </div>
        </div>
      </div>
      <div class="content-manage-steps">
        <span class="content-step-chip">1. Select posters</span>
        <span class="content-step-chip">2. Create or choose a collection</span>
        <span class="content-step-chip">3. Exit Manage Library to browse and send</span>
      </div>
      <div class="content-filter-row">
        <button
          type="button"
          class="content-filter-chip ${state.ui.contentLibraryFilter === "all" ? "is-selected" : ""}"
          data-action="filter-content-library"
          data-filter="all"
        >
          <strong>All</strong>
          <span>${summary.total}</span>
        </button>
        <button
          type="button"
          class="content-filter-chip ${state.ui.contentLibraryFilter === "unassigned" ? "is-selected" : ""}"
          data-action="filter-content-library"
          data-filter="unassigned"
        >
          <strong>Unassigned</strong>
          <span>${summary.unassignedCount}</span>
        </button>
        ${summary.collections.map((collection) => `
          <button
            type="button"
            class="content-filter-chip ${state.ui.contentLibraryFilter === `collection:${collection.id}` ? "is-selected" : ""}"
            data-action="filter-content-library"
            data-filter="collection:${collection.id}"
          >
            <strong>${collection.name}</strong>
            <span>${collection.count}</span>
          </button>
        `).join("")}
      </div>
      <div class="content-assign-row">
        <div class="content-assign-copy">
          <span class="device-summary-kicker">Selected Posters</span>
          <strong>${selectedCount ? `${selectedCount} selected` : "Nothing selected yet"}</strong>
          <span>${selectedCount ? "Assign the current selection to a collection or clear its collection membership." : "Tap posters below to build a multi-select."}</span>
        </div>
        <div class="content-assign-actions">
          ${summary.collections.map((collection) => `
            <button
              type="button"
              class="secondary"
              data-action="assign-content-collection"
              data-collection-id="${collection.id}"
              ${selectedCount ? "" : "disabled"}
            >
              ${collection.name}
            </button>
          `).join("")}
          <button type="button" class="secondary" data-action="clear-content-collections" ${selectedCount ? "" : "disabled"}>Clear Collections</button>
        </div>
      </div>
    </section>
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
          <span class="device-summary-kicker">Manage Library</span>
          <strong>${count ? `${count} selected` : "No posters selected"}</strong>
          <span>${count ? "Assign the selection from the collection panel or delete it here." : "Tap posters to build a multi-select for collection management."}</span>
        </div>
        <div class="content-footer-actions">
          <button type="button" class="secondary" data-action="cancel-content">Done</button>
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

function sendStepIcon(type, stepState) {
  if (stepState === "complete") {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6L9 17l-5-5" /></svg>`;
  }
  if (stepState === "error") {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>`;
  }
  const icons = {
    wake: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2L6 14h5l-1 8 8-12h-5z" /></svg>`,
    connect: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20a8 8 0 1 0-8-8" /><path d="M12 8v4l2.5 2.5" /></svg>`,
    command: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h11" /><path d="M11 4l4 3-4 3" /><path d="M20 17H9" /><path d="m13 14-4 3 4 3" /></svg>`,
    download: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v11" /><path d="m8 13 4 4 4-4" /><path d="M5 19h14" /></svg>`,
    check: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6L9 17l-5-5" /></svg>`
  };
  return icons[type] || icons.check;
}

function formatTargetMilestones(target) {
  const m = target.milestones || {};
  const items = [];
  if (m.wakeSent) items.push({ label: "Wake sent", done: true });
  if (m.connected) items.push({ label: "Connected", done: true });
  if (m.contentSet) items.push({ label: "Command set", done: true });
  if (m.contentJsonFetched) items.push({ label: "Manifest fetched", done: true });
  if (m.imageFetched) items.push({ label: "Image delivered", done: true });
  if (target.status === "failed") items.push({ label: target.error || "Failed", done: false, error: true });
  return items;
}

function createSendFlowModal() {
  const flow = state.ui.sendFlow;
  if (!flow?.active) {
    return "";
  }

  const isRunning = flow.status === "running" || flow.status === "starting";
  const isComplete = flow.status === "completed";
  const isFailed = flow.status === "failed";

  const hasUnverified = flow.targets?.some((t) => t.status === "unverified");
  const statusLabel = isComplete ? "Delivered" : isFailed && hasUnverified ? "Unverified" : isFailed ? "Failed" : "Sending";
  const statusClass = isComplete ? "is-complete" : isFailed && hasUnverified ? "is-warning" : isFailed ? "is-error" : "is-running";

  return `
    <div class="modal-backdrop modal-backdrop--send"></div>
    <section class="modal-shell modal-shell--send" role="dialog" aria-modal="true" aria-label="Send progress">
      <div class="send-modal-status-bar ${statusClass}">
        <div class="send-modal-status-icon">
          ${isComplete
            ? `<svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5" /></svg>`
            : isFailed && hasUnverified
              ? `<svg viewBox="0 0 24 24"><path d="M12 9v4" /><circle cx="12" cy="16" r="1" /><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /></svg>`
              : isFailed
                ? `<svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12" /></svg>`
                : `<svg viewBox="0 0 24 24"><path d="M12 5v11" /><path d="m8 13 4 4 4-4" /><path d="M5 19h14" /></svg>`}
        </div>
        <div class="send-modal-status-copy">
          <strong>${statusLabel}</strong>
          <span>${flow.imageName}</span>
        </div>
        ${isRunning ? `<span class="send-modal-pulse"></span>` : ""}
      </div>
      <div class="modal-body modal-body--send">
        <div class="send-timeline">
          ${flow.steps
            .map(
              (step, index) => `
                <div class="send-timeline-step is-${step.state}">
                  <div class="send-timeline-rail">
                    <div class="send-timeline-node">
                      ${sendStepIcon(step.icon, step.state)}
                    </div>
                    ${index < flow.steps.length - 1 ? `<div class="send-timeline-line"></div>` : ""}
                  </div>
                  <div class="send-timeline-content">
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
              <div class="send-targets">
                <span class="device-summary-kicker">Target Devices</span>
                ${flow.targets
                  .map((target) => {
                    const milestones = formatTargetMilestones(target);
                    const targetFailed = target.status === "failed";
                    const targetUnverified = target.status === "unverified";
                    const targetDone = target.milestones?.imageFetched;
                    return `
                      <div class="send-target-card ${targetDone ? "is-done" : ""} ${targetUnverified ? "is-warning" : ""} ${targetFailed ? "is-error" : ""}">
                        <div class="send-target-header">
                          <div class="send-target-name">
                            <strong>${target.name}</strong>
                            <span>${target.host}</span>
                          </div>
                          <span class="send-target-badge ${targetDone ? "is-done" : targetUnverified ? "is-warning" : targetFailed ? "is-error" : "is-active"}">
                            ${targetDone ? "Delivered" : targetUnverified ? "Unverified" : targetFailed ? "Failed" : "Sending"}
                          </span>
                        </div>
                        ${milestones.length ? `
                          <div class="send-target-milestones">
                            ${milestones.map((m) => `
                              <span class="send-milestone ${m.error ? "is-error" : m.done ? "is-done" : ""}">
                                ${m.done && !m.error
                                  ? `<svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5" /></svg>`
                                  : m.error
                                    ? `<svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12" /></svg>`
                                    : `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4" /></svg>`}
                                ${m.label}
                              </span>
                            `).join("")}
                          </div>
                        ` : ""}
                      </div>
                    `;
                  })
                  .join("")}
              </div>
            `
            : ""
        }
        ${isFailed && hasUnverified
          ? `<div class="send-warning-banner">Sent but not confirmed — the frame may be asleep or unreachable. Try pressing the wake button on the frame and sending again.</div>`
          : isFailed
            ? `<div class="send-error-banner">${flow.error}</div>`
            : ""}
      </div>
      <div class="modal-footer">
        ${isRunning
          ? `<button type="button" class="secondary" disabled>Sending...</button>`
          : `<button type="button" data-action="close-send-flow">${isComplete ? "Done" : "Close"}</button>`}
      </div>
    </section>
  `;
}

function createSpotifyPanel() {
  const showingArtistAlbums = state.spotify.artistView === "albums" && state.spotify.artistAlbums.length;
  const spotifyReady = state.spotifySettings.configured;

    if (showingArtistAlbums) {
    const activeFilter = state.spotify.artistAlbumFilter;
      const filteredAlbums = state.spotify.artistAlbums;
      const allCount = state.spotify.artistAlbumsTotal || state.spotify.artistAlbums.length;

      return `
        <div class="wizard-artist-drilldown">
          <div class="wizard-drilldown-header">
            <button type="button" class="btn btn-secondary wizard-back-button" data-action="spotify-back-to-artists">
            ${iconSvg("down")}
            <span>Back to search</span>
          </button>
            <div>
              <span class="device-summary-kicker">Artist</span>
              <h3>${state.spotify.selectedArtistName}</h3>
            </div>
          </div>
          <div class="wizard-album-filters">
            <button type="button" class="btn ${activeFilter === "album" ? "btn-primary" : "btn-secondary"}" data-action="spotify-filter-albums" data-filter="album">Albums</button>
            <button type="button" class="btn ${activeFilter === "single" ? "btn-primary" : "btn-secondary"}" data-action="spotify-filter-albums" data-filter="single">Singles</button>
            <button type="button" class="btn ${activeFilter === "compilation" ? "btn-primary" : "btn-secondary"}" data-action="spotify-filter-albums" data-filter="compilation">Compilations</button>
            <button type="button" class="btn ${activeFilter === "all" ? "btn-primary" : "btn-secondary"}" data-action="spotify-filter-albums" data-filter="all">All</button>
          </div>
          <div class="wizard-album-list">
            ${filteredAlbums
              .map(
                (album) => {
                  const alreadySelected = state.studio.albumArt.selectedSlugs.some((slug) =>
                    state.catalog.find((entry) => entry.slug === slug && entry.spotifyId === album.id)
                  );
                return `
                  <button type="button" class="wizard-album-row ${alreadySelected ? "is-added" : ""}" data-action="spotify-import-album" data-album-id="${album.id}" ${alreadySelected ? "disabled" : ""}>
                    ${album.images?.[0]?.url
                      ? `<img class="wizard-album-thumb" src="${album.images[0].url}" alt="${album.name}" />`
                      : `<div class="wizard-album-thumb wizard-album-thumb--empty">${album.name.slice(0, 1)}</div>`}
                    <div class="wizard-album-row-copy">
                      <strong>${album.name}</strong>
                      <span>${String(album.release_date || "").slice(0, 4) || "Unknown year"} / ${album.album_type}</span>
                    </div>
                    <span class="wizard-album-row-badge ${alreadySelected ? "is-added" : ""}">${alreadySelected ? "Added" : "Add"}</span>
                  </button>
                `;
              },
              )
              .join("")}
          </div>
          ${state.spotify.artistAlbumsHasMore ? `
            <button type="button" class="btn btn-secondary wizard-show-more" data-action="spotify-albums-show-more">
              Show more (${Math.max(0, allCount - filteredAlbums.length)} remaining)
            </button>
          ` : ""}
        </div>
      `;
    }

  return `
    <div class="wizard-search-panel">
      ${!spotifyReady ? `
        <div class="spotify-settings-note is-missing">
          <strong>Spotify credentials required</strong>
          <span>Open the gear in the plugin header to add your Spotify client ID and secret.</span>
        </div>
      ` : ""}
        <div class="wizard-search-group">
          <span class="device-summary-kicker">Search by Artist</span>
          <div class="spotify-search-row">
            <input id="spotify-artist-query" type="text" placeholder="Search artist name..." value="${state.spotify.artistQuery}" />
            <button type="button" class="btn btn-primary" data-action="spotify-search-artists" ${spotifyReady ? "" : "disabled"}>Search</button>
          </div>
        </div>
        <div class="wizard-search-group">
          <span class="device-summary-kicker">Search by Album</span>
          <div class="spotify-search-row">
            <input id="spotify-album-query" type="text" placeholder="Search album name..." value="${state.spotify.albumQuery}" />
            <button type="button" class="btn btn-secondary" data-action="spotify-search-albums" ${spotifyReady ? "" : "disabled"}>Search</button>
          </div>
        </div>
        <div class="wizard-search-group">
          <span class="device-summary-kicker">Import from Playlist</span>
          <div class="spotify-search-row">
            <input id="spotify-playlist-query" type="text" placeholder="Paste playlist URL or ID..." value="${state.spotify.playlistQuery}" />
            <button type="button" class="btn btn-secondary" data-action="spotify-import-playlist" ${spotifyReady ? "" : "disabled"}>Import</button>
        </div>
      </div>
      ${
          state.spotify.artistResults.length
            ? `
              <div class="wizard-artist-results">
                <span class="device-summary-kicker">Artists</span>
              ${state.spotify.artistResults
                .map(
                  (artist) => `
                    <button type="button" class="wizard-artist-card" data-action="spotify-load-artist" data-artist-id="${artist.id}">
                      <div class="wizard-artist-card-copy">
                        <strong>${artist.name}</strong>
                        <span>${artist.genres?.slice(0, 2).join(", ") || "Artist"}</span>
                      </div>
                      <span class="wizard-artist-arrow">${iconSvg("down")}</span>
                    </button>
                  `,
                )
                .join("")}
              </div>
            `
            : ""
        }
        ${
          state.spotify.albumResults.length
            ? `
              <div class="wizard-artist-results">
                <span class="device-summary-kicker">Albums</span>
                ${state.spotify.albumResults
                  .map((album) => {
                    const alreadySelected = state.studio.albumArt.selectedSlugs.some((slug) =>
                      state.catalog.find((entry) => entry.slug === slug && entry.spotifyId === album.id)
                    );
                    return `
                      <button type="button" class="wizard-album-row ${alreadySelected ? "is-added" : ""}" data-action="spotify-import-album" data-album-id="${album.id}" ${alreadySelected ? "disabled" : ""}>
                        ${album.images?.[0]?.url
                          ? `<img class="wizard-album-thumb" src="${album.images[0].url}" alt="${album.name}" />`
                          : `<div class="wizard-album-thumb wizard-album-thumb--empty">${album.name.slice(0, 1)}</div>`}
                        <div class="wizard-album-row-copy">
                          <strong>${album.name}</strong>
                          <span>${album.artists?.map((artist) => artist.name).join(", ") || "Unknown artist"} / ${String(album.release_date || "").slice(0, 4) || "Unknown year"} / ${album.album_type}</span>
                        </div>
                        <span class="wizard-album-row-badge ${alreadySelected ? "is-added" : ""}">${alreadySelected ? "Added" : "Add"}</span>
                      </button>
                    `;
                  })
                  .join("")}
              </div>
            `
            : ""
        }
      </div>
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
        <span class="studio-plugin-mark">${plugin.icon ? iconSvg(plugin.icon) : plugin.mark}</span>
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

function createWizardStepIndicator() {
  const currentStep = state.studio.albumArt.step;
  const selectedCount = state.studio.albumArt.selectedSlugs.length;
  const steps = [
    { id: "pick", label: "Pick Albums", number: "1" },
    { id: "design", label: "Choose Design", number: "2" },
    { id: "generate", label: "Generate", number: "3" }
  ];

  const currentIndex = steps.findIndex((s) => s.id === currentStep);

  return `
    <div class="wizard-steps">
      ${steps
        .map((step, index) => {
          const isCurrent = step.id === currentStep;
          const isComplete = index < currentIndex;
          const isDisabled = step.id === "design" && selectedCount === 0;
          return `
            <button
              type="button"
              class="wizard-step-indicator ${isCurrent ? "is-current" : ""} ${isComplete ? "is-complete" : ""}"
              data-action="wizard-goto-step"
              data-step="${step.id}"
              ${isDisabled ? "disabled" : ""}
            >
              <span class="wizard-step-number">${isComplete ? `<svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5" /></svg>` : step.number}</span>
              <span>${step.label}</span>
            </button>
          `;
        })
        .join(`<span class="wizard-step-divider"></span>`)}
    </div>
  `;
}

function createWizardPickStep() {
  const selectedEntries = state.studio.albumArt.selectedSlugs
    .map((slug) => state.catalog.find((entry) => entry.slug === slug))
    .filter(Boolean);

  return `
    <div class="wizard-step-body">
      ${createSpotifyPanel()}
      ${selectedEntries.length ? `
        <div class="wizard-selection-tray">
          <div class="wizard-tray-header">
            <div>
              <span class="device-summary-kicker">Selected</span>
              <strong>${selectedEntries.length} album${selectedEntries.length === 1 ? "" : "s"} in batch</strong>
            </div>
            <button type="button" class="btn btn-secondary" data-action="clear-studio-album-selection">Clear All</button>
          </div>
          <div class="wizard-tray-chips">
            ${selectedEntries.map((entry) => {
              const album = getAlbum(entry.slug);
              return `
                <div class="wizard-tray-chip">
                  ${album?.cover
                    ? `<img src="${album.cover}" alt="${entry.artist}" />`
                    : `<span class="wizard-chip-letter">${entry.artist.slice(0, 1)}</span>`}
                  <div class="wizard-chip-copy">
                    <strong>${entry.album}</strong>
                    <span>${entry.artist}</span>
                  </div>
                  <button type="button" class="wizard-chip-remove" data-action="remove-studio-album" data-album-slug="${entry.slug}" aria-label="Remove ${entry.album}">
                    ${iconSvg("close")}
                  </button>
                </div>
              `;
            }).join("")}
          </div>
        </div>
      ` : ""}
      <div class="wizard-step-footer">
        <div></div>
        <button type="button" class="btn btn-primary" data-action="wizard-goto-step" data-step="design" ${selectedEntries.length ? "" : "disabled"}>
          Choose Design
        </button>
      </div>
    </div>
  `;
}

function createWizardDesignStep() {
  const selectedEntries = state.studio.albumArt.selectedSlugs
    .map((slug) => state.catalog.find((entry) => entry.slug === slug))
    .filter(Boolean);
  const previewAlbum = selectedEntries.length ? getAlbum(selectedEntries[0]?.slug) : null;

  return `
    <div class="wizard-step-body">
      <div class="wizard-context-bar">
        <span class="device-summary-kicker">Batch</span>
        <div class="wizard-context-chips">
          ${selectedEntries.map((entry) => `<span class="wizard-context-chip">${entry.artist} — ${entry.album}</span>`).join("")}
        </div>
      </div>
      <div class="studio-template-grid">
        ${TEMPLATE_REGISTRY.map((template) => createStudioTemplateCard(template, previewAlbum)).join("")}
      </div>
      <div class="wizard-step-footer">
        <button type="button" class="btn btn-secondary" data-action="wizard-goto-step" data-step="pick">Back</button>
        <button type="button" class="btn btn-primary" data-action="wizard-goto-step" data-step="generate">
          Review &amp; Generate
        </button>
      </div>
    </div>
  `;
}

function createWizardGenerateStep() {
  const selectedEntries = state.studio.albumArt.selectedSlugs
    .map((slug) => state.catalog.find((entry) => entry.slug === slug))
    .filter(Boolean);
  const selectedTemplate = getTemplateById(state.studio.albumArt.templateId);
  const previewAlbum = selectedEntries.length ? getAlbum(selectedEntries[0]?.slug) : null;

  return `
    <div class="wizard-step-body">
      <div class="wizard-summary">
        <div class="wizard-summary-section">
          <span class="device-summary-kicker">Albums (${selectedEntries.length})</span>
          <div class="wizard-summary-album-list">
            ${selectedEntries.map((entry) => {
              const album = getAlbum(entry.slug);
              return `
                <div class="wizard-summary-album">
                  ${album?.cover
                    ? `<img src="${album.cover}" alt="${entry.artist}" />`
                    : `<span class="wizard-chip-letter">${entry.artist.slice(0, 1)}</span>`}
                  <div>
                    <strong>${entry.album}</strong>
                    <span>${entry.artist}${entry.year ? ` (${entry.year})` : ""}</span>
                  </div>
                </div>
              `;
            }).join("")}
          </div>
        </div>
        <div class="wizard-summary-section">
          <span class="device-summary-kicker">Design</span>
          <div class="wizard-summary-template">
            <strong>${selectedTemplate?.name || "Unknown template"}</strong>
            ${previewAlbum && selectedTemplate
              ? `
                <div class="wizard-summary-preview">
                  ${(() => {
                    const baseScreen = state.project.screens[0] ? cloneScreen(state.project.screens[0]) : structuredClone(DEFAULT_PROJECT.screens[0]);
                    const previewWidth = 180;
                    const previewScale = previewWidth / baseScreen.size.width;
                    const previewHeight = Math.round((baseScreen.size.height / baseScreen.size.width) * previewWidth);
                    const previewScreen = { ...baseScreen, template: selectedTemplate.id, albumSlug: previewAlbum.slug };
                    return `
                      <div class="studio-template-preview" style="--studio-preview-width:${previewWidth}px;--studio-preview-height:${previewHeight}px;min-height:auto;">
                        <div class="studio-template-preview-scale" style="--studio-preview-scale:${previewScale};">
                          <div class="studio-template-preview-inner">
                            ${selectedTemplate.render({ screen: previewScreen, album: previewAlbum })}
                          </div>
                        </div>
                      </div>
                    `;
                  })()}
                </div>
              `
              : ""}
          </div>
        </div>
      </div>
      <div class="wizard-generate-note">
        <p>Posters will be rendered as PNG files into the shared Content library. Re-running the same album/design pair replaces existing outputs.</p>
      </div>
      ${createGeneratedStudioResultCards()}
      <div class="wizard-step-footer">
        <button type="button" class="btn btn-secondary" data-action="wizard-goto-step" data-step="design">Back</button>
        <button type="button" class="btn btn-primary" ${selectedEntries.length ? "" : "disabled"} data-action="generate-album-art-posters">
          Add ${selectedEntries.length} Poster${selectedEntries.length === 1 ? "" : "s"} to Content
        </button>
      </div>
    </div>
  `;
}

function renderAlbumArtWorkspace() {
  const step = state.studio.albumArt.step || "pick";

  let stepContent = "";
  if (step === "pick") {
    stepContent = createWizardPickStep();
  } else if (step === "design") {
    stepContent = createWizardDesignStep();
  } else if (step === "generate") {
    stepContent = createWizardGenerateStep();
  }

  return `
    <section class="studio-plugin-body wizard-body">
      ${createWizardStepIndicator()}
      ${stepContent}
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
        </div>
        <section class="studio-plugin-detail" style="--plugin-accent:${selectedPlugin.accent}">
          <div class="studio-plugin-detail-header">
            <div class="studio-plugin-detail-title">
              <span class="studio-plugin-mark">${selectedPlugin.icon ? iconSvg(selectedPlugin.icon) : selectedPlugin.mark}</span>
              <div>
                <p class="modal-kicker">${selectedPlugin.category}</p>
                <h3>${selectedPlugin.name}</h3>
                <p>${selectedPlugin.summary}</p>
              </div>
            </div>
            <div class="studio-plugin-detail-meta">
              <span class="studio-plugin-badge studio-plugin-badge--status is-${selectedPlugin.status}">${getStudioPluginStatusLabel(selectedPlugin.status)}</span>
              <span class="studio-plugin-badge">v${selectedPlugin.version}</span>
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
  if (state.ui.section === "devices") {
    return createDeviceManagementModal();
  }

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

function createDeviceManagementModal() {
  const groups = getGroupedScreens();
  return `
    <div class="modal-backdrop" data-action="close-modal"></div>
    <section class="modal-shell modal-shell--settings" role="dialog" aria-modal="true" aria-label="Rooms and walls">
      <div class="modal-header">
        <div>
          <p class="modal-kicker">Devices</p>
          <h2>Rooms & Walls</h2>
          <p class="send-flow-copy">Manage the grouping structure for your frames without opening each device one at a time.</p>
        </div>
        <button type="button" class="icon-button icon-button--ghost" data-action="close-modal" aria-label="Close rooms and walls">
          ${iconSvg("close")}
        </button>
      </div>
      <div class="modal-body modal-body--settings">
        <section class="modal-section modal-section--stacked">
          ${groups.length
            ? `<div class="manage-structure-list">${groups.map(createManagedRoomCard).join("")}</div>`
            : `<div class="empty-state empty-state--compact"><div><h2>No rooms yet</h2><p>Add a device to start organizing frames into rooms and walls.</p></div></div>`}
        </section>
      </div>
    </section>
  `;
}

function createManagedRoomCard(room) {
  return `
    <article class="manage-room-card">
      <div class="manage-entity-header">
        <div>
          <span class="device-summary-kicker">Room</span>
          <strong>${room.name}</strong>
        </div>
      </div>
      <div class="manage-search-group">
        <span class="device-summary-kicker">Room Name</span>
        <div class="spotify-search-row manage-search-row">
          <input id="manage-room-${room.id}" type="text" value="${room.name}" />
          <button type="button" class="btn btn-secondary" data-action="rename-room" data-room-id="${room.id}">Rename Room</button>
        </div>
      </div>
      <div class="manage-wall-list">
        ${room.walls.map((wall) => createManagedWallCard(room, wall)).join("")}
      </div>
    </article>
  `;
}

function createManagedWallCard(room, wall) {
  const occupancy = getWallSlotOccupancy(wall);
  const warnings = getWallSlotWarnings(occupancy);
  return `
    <article class="manage-wall-card">
      <div class="manage-entity-header">
        <div class="wall-group-breadcrumb" aria-label="${room.name} / ${wall.name}">
          <span class="wall-group-crumb">${room.name}</span>
          <span class="wall-group-separator">/</span>
          <span class="wall-group-crumb wall-group-crumb--current">${wall.name}</span>
        </div>
        <span class="wall-group-count">${wall.screens.length} ${wall.screens.length === 1 ? "frame" : "frames"}</span>
      </div>
      <div class="manage-search-group">
        <span class="device-summary-kicker">Wall Name</span>
        <div class="spotify-search-row manage-search-row">
          <input id="manage-wall-${wall.id}" type="text" value="${wall.name}" />
          <button type="button" class="btn btn-secondary" data-action="rename-wall" data-wall-id="${wall.id}" data-room-id="${room.id}">Rename Wall</button>
        </div>
      </div>
      ${warnings.length ? `
        <div class="manage-wall-warning">
          ${warnings.map((warning) => `<span>${warning}</span>`).join("")}
        </div>
      ` : ""}
      <div class="manage-slot-list">
        ${occupancy.map((slot) => `
          <div class="manage-slot-card ${slot.screens.length > 1 ? "is-collision" : slot.screens.length === 0 ? "is-empty" : ""}">
            <span class="device-summary-kicker">${slot.label}</span>
            <div class="manage-slot-devices">
              ${slot.screens.length
                ? slot.screens.map((screen) => `
                    <button type="button" class="manage-screen-pill" data-action="open-screen-modal" data-screen-id="${screen.id}">
                      ${screen.name}
                    </button>
                  `).join("")
                : `<span class="manage-slot-empty">No frame assigned</span>`}
            </div>
          </div>
        `).join("")}
      </div>
    </article>
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
          <button type="button" class="btn btn-secondary" data-action="refresh-discovery" ${state.discovery.loading ? "disabled" : ""}>
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
                                ? `<button type="button" class="btn btn-secondary" disabled>Added as ${existing.name}</button>`
                                : `<button type="button" class="btn btn-primary" data-action="add-discovered-device" data-device-host="${result.host}">Add Device</button>`
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
  const image = getEnrichedOutputImages().find((entry) => entry.name === state.ui.previewImageName)
    || state.outputImages.find((entry) => entry.name === state.ui.previewImageName);
  if (!image) {
    return "";
  }
  const dimensionsLine = formatImageDimensions(image);
  const hasEdits = Boolean(image.editRecipe);
  const fitCheck = evaluateImageFit(image, getFitCheckTargetScreens());
  const fitWarning = fitCheck.status.startsWith("warn")
    ? `<p class="content-preview-warning" title="${fitCheck.title}"><strong>${fitCheck.label}.</strong> ${fitCheck.title}</p>`
    : "";

  return `
    <div class="modal-backdrop" data-action="close-content-preview"></div>
    <section class="modal-shell modal-shell--preview" role="dialog" aria-modal="true" aria-label="Content preview">
      <div class="modal-header">
        <div>
          <p class="modal-kicker">Content Preview${hasEdits ? ` · <span class="content-meta-chip content-meta-chip--edited">Edited</span>` : ""}</p>
          <h2>${image.name}</h2>
          <p class="send-flow-copy">${dimensionsLine ? `${dimensionsLine} · ` : ""}${formatBytes(image.size)} · ${formatDateTime(image.modifiedAt)}</p>
          ${fitWarning}
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
      <div class="modal-footer modal-footer--preview">
        ${hasEdits ? `<button type="button" class="secondary" data-action="reset-content-edit" data-image-name="${image.name}">Reset edits</button>` : ""}
        <button type="button" data-action="open-content-edit" data-image-name="${image.name}">Edit image</button>
        <button type="button" class="secondary" data-action="close-content-preview">Close</button>
      </div>
    </section>
  `;
}

function buildEditPreviewFilter(draft) {
  const filters = [];
  if (draft.brightness !== 1) filters.push(`brightness(${draft.brightness})`);
  if (draft.contrast !== 1) filters.push(`contrast(${draft.contrast})`);
  if (draft.grayscale) filters.push("grayscale(1)");
  if (draft.invert) filters.push("invert(1)");
  if (draft.blur > 0) filters.push(`blur(${(draft.blur * 0.8).toFixed(1)}px)`);
  return filters.length ? filters.join(" ") : "none";
}

function createContentEditModal() {
  const editState = state.ui.contentEdit;
  if (!editState?.imageName) {
    return "";
  }
  const image = state.outputImages.find((entry) => entry.name === editState.imageName);
  if (!image) {
    return "";
  }
  const draft = editState.draft;
  const filterString = buildEditPreviewFilter(draft);
  const transformString = `rotate(${draft.rotate}deg)`;
  const dimensionsLine = formatImageDimensions(image);
  const screens = state.project.screens.filter((screen) => screen.enabled);
  const targetScreen = draft.targetScreenId
    ? screens.find((screen) => screen.id === draft.targetScreenId)
    : null;
  const targetDims = targetScreen?.size
    ? `Will render to ${targetScreen.size.width}×${targetScreen.size.height}`
    : "No target screen — renders at source dimensions";
  const anchors = ["center", "top", "bottom", "left", "right"];
  const saving = Boolean(editState.saving);

  return `
    <div class="modal-backdrop" data-action="cancel-content-edit"></div>
    <section class="modal-shell modal-shell--edit" role="dialog" aria-modal="true" aria-label="Edit image">
      <div class="modal-header">
        <div>
          <p class="modal-kicker">Edit Image</p>
          <h2>${image.name}</h2>
          <p class="send-flow-copy">${dimensionsLine || ""}</p>
        </div>
        <button type="button" class="icon-button icon-button--ghost" data-action="cancel-content-edit" aria-label="Close">
          ${iconSvg("close")}
        </button>
      </div>
      <div class="modal-body modal-body--edit">
        <div class="content-edit-preview">
          <img
            id="content-edit-preview-img"
            src="${image.url}?t=${encodeURIComponent(image.modifiedAt)}"
            alt="${image.name}"
            style="filter: ${filterString}; transform: ${transformString};"
          />
          <p class="send-flow-copy content-edit-target-note">${targetDims}</p>
        </div>
        <form id="content-edit-form" class="content-edit-form" onsubmit="return false;">
          <fieldset class="content-edit-group">
            <legend>Frame fit</legend>
            <label>
              <span>Fit mode</span>
              <select name="fit">
                <option value="contain" ${draft.fit === "contain" ? "selected" : ""}>Contain</option>
                <option value="cover" ${draft.fit === "cover" ? "selected" : ""}>Cover</option>
              </select>
            </label>
            <label>
              <span>Crop anchor</span>
              <select name="cropAnchor">
                ${anchors.map((a) => `<option value="${a}" ${draft.cropAnchor === a ? "selected" : ""}>${a}</option>`).join("")}
              </select>
            </label>
            <div class="content-edit-rotate">
              <span>Rotate</span>
              <div class="content-edit-rotate-buttons">
                ${[0, 90, 180, 270].map((deg) => `
                  <button
                    type="button"
                    class="content-edit-rotate-button ${draft.rotate === deg ? "is-selected" : ""}"
                    data-action="update-content-edit"
                    data-field="rotate"
                    data-value="${deg}"
                  >${deg}°</button>
                `).join("")}
              </div>
            </div>
          </fieldset>

          <fieldset class="content-edit-group">
            <legend>Tone</legend>
            <label class="content-edit-toggle">
              <input type="checkbox" name="grayscale" ${draft.grayscale ? "checked" : ""} />
              <span>Grayscale</span>
            </label>
            <label class="content-edit-toggle">
              <input type="checkbox" name="invert" ${draft.invert ? "checked" : ""} />
              <span>Invert</span>
            </label>
            <label class="content-edit-slider">
              <span>Brightness <em data-value-for="brightness">${draft.brightness.toFixed(2)}</em></span>
              <input type="range" name="brightness" min="0.5" max="1.5" step="0.05" value="${draft.brightness}" />
            </label>
            <label class="content-edit-slider">
              <span>Contrast <em data-value-for="contrast">${draft.contrast.toFixed(2)}</em></span>
              <input type="range" name="contrast" min="0.5" max="1.5" step="0.05" value="${draft.contrast}" />
            </label>
            <label class="content-edit-slider">
              <span>Gamma <em data-value-for="gamma">${draft.gamma.toFixed(2)}</em></span>
              <input type="range" name="gamma" min="1" max="3" step="0.1" value="${draft.gamma}" />
            </label>
            <label class="content-edit-slider">
              <span>Black point <em data-value-for="blackPoint">${draft.blackPoint.toFixed(2)}</em></span>
              <input type="range" name="blackPoint" min="0" max="0.4" step="0.02" value="${draft.blackPoint}" />
            </label>
            <label class="content-edit-slider">
              <span>White point <em data-value-for="whitePoint">${draft.whitePoint.toFixed(2)}</em></span>
              <input type="range" name="whitePoint" min="0.6" max="1" step="0.02" value="${draft.whitePoint}" />
            </label>
          </fieldset>

          <fieldset class="content-edit-group">
            <legend>Detail</legend>
            <label class="content-edit-slider">
              <span>Sharpen <em data-value-for="sharpen">${draft.sharpen.toFixed(1)}</em></span>
              <input type="range" name="sharpen" min="0" max="5" step="0.1" value="${draft.sharpen}" />
            </label>
            <label class="content-edit-slider">
              <span>Blur <em data-value-for="blur">${draft.blur.toFixed(1)}</em></span>
              <input type="range" name="blur" min="0" max="5" step="0.1" value="${draft.blur}" />
            </label>
          </fieldset>

          <fieldset class="content-edit-group">
            <legend>Target</legend>
            <label>
              <span>Render for screen</span>
              <select name="targetScreenId">
                <option value="">None</option>
                ${screens.map((screen) => `
                  <option value="${screen.id}" ${draft.targetScreenId === screen.id ? "selected" : ""}>
                    ${screen.name} (${screen.size.width}×${screen.size.height})
                  </option>
                `).join("")}
              </select>
            </label>
          </fieldset>
        </form>
      </div>
      <div class="modal-footer modal-footer--edit">
        <button type="button" class="secondary" data-action="reset-content-edit-draft">Reset</button>
        <button type="button" class="secondary" data-action="cancel-content-edit">Cancel</button>
        <button type="button" class="secondary" data-action="save-content-edit-copy" ${saving ? "disabled" : ""}>Save as copy</button>
        <button type="button" data-action="save-content-edit" ${saving ? "disabled" : ""}>${saving ? "Saving..." : "Save"}</button>
      </div>
    </section>
  `;
}

function createSectionPanel() {
  if (state.ui.section === "content") {
    const selectedScreen = state.project.screens.find((screen) => screen.id === state.ui.contentScreenId);
    const visibleImages = getVisibleOutputImages();
    const isManageMode = state.ui.contentManageMode;
    return `
      <section class="content-panel">
        <div class="content-header">
          <div class="content-header-copy">
            <h2>Content</h2>
            <p>${
              isManageMode
                ? "Organize the content library. Collection tools are only visible here so browsing and sending stay simple."
                : selectedScreen
                  ? `Choose imagery for ${selectedScreen.name}.`
                  : "Browse the library, open a collection if you want a themed view, and send something quickly."
            }</p>
          </div>
          <div class="content-header-actions">
            <button type="button" class="content-upload-button" data-action="toggle-content-manage">
              ${iconSvg("manage")}
              <span>${isManageMode ? "Done" : "Manage Library"}</span>
            </button>
            <button type="button" class="content-upload-button" data-action="open-upload">
              ${iconSvg("upload")}
              <span>Upload Image</span>
            </button>
          </div>
        </div>
        ${isManageMode ? createContentManagePanel() : ""}
        ${
          !isManageMode
            ? `
              <div class="broadcast-row">
                <span class="device-summary-kicker">Target Devices</span>
                <div class="broadcast-grid">
                  ${state.project.screens.filter((screen) => screen.enabled).map(createTargetDeviceButton).join("")}
                </div>
              </div>
              ${createContentBrowseCollectionsPanel()}
              ${createContentSetsPanel()}
              ${createContentCollectionScopePanel()}
              ${createContentBrowseToolbar()}
            `
            : ""
        }
        ${
          visibleImages.length
            ? `<div class="output-grid">${visibleImages.map(createOutputImageCard).join("")}</div>`
            : `<div class="empty-state empty-state--compact"><div><h2>${state.outputImages.length ? "No images match this view" : "No output images yet"}</h2><p>${state.outputImages.length ? (isManageMode ? "Try another collection focus or go back to All." : "Try another collection or go back to All Posters.") : "Rendered or uploaded images from the app will appear here."}</p></div></div>`
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
        <div class="device-groups">${getGroupedScreens().map(createRoomGroup).join("")}</div>
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

function createRoomGroup(room) {
  return `
    <section class="room-group">
      <div class="wall-group-list">
        ${room.walls.map((wall) => createWallGroup(room, wall)).join("")}
      </div>
    </section>
  `;
}

function createWallGroup(room, wall) {
  return `
    <section class="wall-group">
      <div class="wall-group-header">
        <div class="wall-group-breadcrumb" aria-label="${room.name} / ${wall.name}">
          <span class="wall-group-crumb">${room.name}</span>
          <span class="wall-group-separator">/</span>
          <span class="wall-group-crumb wall-group-crumb--current">${wall.name}</span>
        </div>
        <span class="wall-group-count">${wall.screens.length} ${wall.screens.length === 1 ? "frame" : "frames"}</span>
      </div>
      <div class="preview-grid">${wall.screens.map(createPreviewCard).join("")}</div>
    </section>
  `;
}

function createActiveModal() {
  if (state.ui.sendFlow?.active) {
    return createSendFlowModal();
  }
  if (state.ui.modal === "content-preview") {
    return createContentPreviewModal();
  }
  if (state.ui.modal === "content-edit") {
    return createContentEditModal();
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
  flushActionToasts();
  flushSpotifyToasts();
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
        <input id="content-upload-input" type="file" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" multiple hidden />
      </section>
      ${createActiveModal()}
      ${createToastLayer()}
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

  document.getElementById("spotify-album-query")?.addEventListener("input", (event) => {
      state.spotify.albumQuery = event.target.value;
    });
  document.getElementById("spotify-album-query")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        const trigger = app.querySelector('[data-action="spotify-search-albums"]');
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

  document.getElementById("content-library-search")?.addEventListener("input", (event) => {
    state.ui.contentLibrarySearch = event.target.value;
    renderWorkspace();
    const restored = document.getElementById("content-library-search");
    if (restored) {
      restored.focus();
      const len = restored.value.length;
      try { restored.setSelectionRange(len, len); } catch {}
    }
  });

  document.getElementById("content-library-sort")?.addEventListener("change", (event) => {
    state.ui.contentLibrarySort = event.target.value;
    renderWorkspace();
  });

  document.getElementById("content-upload-input")?.addEventListener("change", (event) => {
    handleContentUpload(event).catch((error) => {
      state.actions.error = error.message;
      renderWorkspace();
    });
  });

  bindContentDropZone();
  bindContentEditForm();

  app.querySelectorAll("[data-path]").forEach((element) => {
    element.addEventListener("change", handleFieldChange);
  });

  app.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => {
      handleAction(button).catch((error) => {
        state.actions.error = error.message;
        if (String(button.dataset.action || "").startsWith("spotify-")) {
          state.spotify.error = error.message;
          state.spotify.notice = "";
        }
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
  if (path === "roomName") {
    screen.roomId = createLocationId(value || "ungrouped");
    if (!screen.wallName) {
      screen.wallName = inferWallName(screen.name, screen.roomName);
    }
    screen.wallId = createLocationId(`${screen.roomId}-${screen.wallName || "wall"}`);
  }
  if (path === "wallName") {
    screen.wallId = createLocationId(`${screen.roomId || createLocationId(screen.roomName || "ungrouped")}-${value || "wall"}`);
  }
  if (path === "name") {
    if (!screen.roomName) {
      screen.roomName = inferRoomName(value);
      screen.roomId = createLocationId(screen.roomName || "ungrouped");
    }
    if (!screen.wallName) {
      screen.wallName = inferWallName(value, screen.roomName);
      screen.wallId = createLocationId(`${screen.roomId}-${screen.wallName || "wall"}`);
    }
    if (!screen.wallSlot) {
      screen.wallSlot = inferWallSlot(value) || "";
    }
  }
}

function renameRoom(roomId, nextName) {
  const trimmedName = String(nextName || "").trim();
  if (!trimmedName) {
    throw new Error("Room name cannot be empty.");
  }

  const nextRoomId = createLocationId(trimmedName);
  const wallIdMap = new Map();

  state.project.screens = state.project.screens.map((screen) => {
    if (screen.roomId !== roomId) {
      return screen;
    }

    const wallName = screen.wallName || humanizeLocationId(screen.wallId);
    const nextWallId = createLocationId(`${nextRoomId}-${wallName || "wall"}`);
    wallIdMap.set(screen.wallId, nextWallId);

    return {
      ...screen,
      roomId: nextRoomId,
      roomName: trimmedName,
      wallId: nextWallId
    };
  });

  state.project.rooms = (state.project.rooms || []).map((room) =>
    room.id === roomId ? { ...room, id: nextRoomId, name: trimmedName } : room,
  );
  state.project.walls = (state.project.walls || []).map((wall) => {
    if (wall.roomId !== roomId) {
      return wall;
    }
    return {
      ...wall,
      id: wallIdMap.get(wall.id) || createLocationId(`${nextRoomId}-${wall.name || "wall"}`),
      roomId: nextRoomId
    };
  });
}

function renameWall(wallId, roomId, nextName) {
  const trimmedName = String(nextName || "").trim();
  if (!trimmedName) {
    throw new Error("Wall name cannot be empty.");
  }

  const effectiveRoomId = roomId || state.project.walls?.find((wall) => wall.id === wallId)?.roomId || "ungrouped";
  const nextWallId = createLocationId(`${effectiveRoomId}-${trimmedName}`);

  state.project.screens = state.project.screens.map((screen) =>
    screen.wallId === wallId
      ? {
          ...screen,
          wallId: nextWallId,
          wallName: trimmedName
        }
      : screen,
  );

  state.project.walls = (state.project.walls || []).map((wall) =>
    wall.id === wallId
      ? { ...wall, id: nextWallId, roomId: effectiveRoomId, name: trimmedName }
      : wall,
  );
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

  if (action === "rename-room") {
    const roomId = button.dataset.roomId || "";
    const nextName = document.getElementById(`manage-room-${roomId}`)?.value || "";
    renameRoom(roomId, nextName);
    persistProject();
    state.actions.notice = `Renamed room to ${String(nextName).trim()}.`;
    renderWorkspace();
    return;
  }

  if (action === "rename-wall") {
    const wallId = button.dataset.wallId || "";
    const roomId = button.dataset.roomId || "";
    const nextName = document.getElementById(`manage-wall-${wallId}`)?.value || "";
    renameWall(wallId, roomId, nextName);
    persistProject();
    state.actions.notice = `Renamed wall to ${String(nextName).trim()}.`;
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
    const roomName = inferRoomName(discovered.deviceName) || "";
    const roomId = createLocationId(roomName || "ungrouped");
    const wallName = inferWallName(discovered.deviceName, roomName);
    const wallId = createLocationId(`${roomId}-${wallName || "wall"}`);
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
      },
      roomId,
      roomName: roomName || humanizeLocationId(roomId),
      wallId,
      wallName: wallName || humanizeLocationId(wallId),
      wallSlot: inferWallSlot(discovered.deviceName) || ""
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

  if (action === "filter-content-library") {
    state.ui.contentLibraryFilter = button.dataset.filter || "all";
    if (!state.ui.contentManageMode) {
      const visibleNames = new Set(getVisibleOutputImages().map((image) => image.name));
      if (!visibleNames.has(state.ui.contentSelectedImage)) {
        state.ui.contentSelectedImage = getVisibleOutputImages()[0]?.name || "";
      }
    }
    renderWorkspace();
    return;
  }

  if (action === "clear-content-library-search") {
    state.ui.contentLibrarySearch = "";
    renderWorkspace();
    return;
  }

  if (action === "reset-content-library-filters") {
    state.ui.contentLibraryFilter = "all";
    state.ui.contentLibrarySearch = "";
    state.ui.contentLibrarySort = "recent";
    renderWorkspace();
    return;
  }

  if (action === "create-content-collection") {
    const input = document.getElementById("content-collection-name");
    const collectionName = input?.value?.trim() || "";
    const collection = ensureContentCollection(collectionName);
    if (!collection) {
      state.actions.error = "Enter a collection name first.";
      renderWorkspace();
      return;
    }
    let assignedCount = 0;
    if (state.ui.contentManageMode && state.ui.contentManageSelections.length) {
      assignedCount = assignImagesToCollection(state.ui.contentManageSelections, collection.id);
    }
    persistProject();
    state.ui.contentLibraryFilter = `collection:${collection.id}`;
    state.actions.notice = assignedCount
      ? `Created ${collection.name} and added ${assignedCount} poster${assignedCount === 1 ? "" : "s"}.`
      : `Saved collection ${collection.name}.`;
    state.actions.error = "";
    if (input) {
      input.value = "";
    }
    renderWorkspace();
    return;
  }

  if (action === "assign-content-collection") {
    const collectionId = button.dataset.collectionId || "";
    const collection = getCollectionById(collectionId);
    const imageNames = [...state.ui.contentManageSelections];
    if (!collection || !imageNames.length) {
      state.actions.error = "Select posters and a valid collection.";
      renderWorkspace();
      return;
    }
    const changed = assignImagesToCollection(imageNames, collectionId);
    persistProject();
    state.ui.contentLibraryFilter = `collection:${collection.id}`;
    state.actions.notice = changed
      ? `Added ${changed} poster${changed === 1 ? "" : "s"} to ${collection.name}.`
      : `${collection.name} already contains those images.`;
    state.actions.error = "";
    renderWorkspace();
    return;
  }

  if (action === "create-content-set") {
    const input = document.getElementById("content-set-name");
    const rawName = input?.value?.trim() || "";
    if (!rawName) {
      state.actions.error = "Enter a set name first.";
      renderWorkspace();
      return;
    }
    const selection = [...state.ui.contentManageSelections];
    if (selection.length < 2) {
      state.actions.error = "Select at least 2 images in the order you want them assigned to frames.";
      renderWorkspace();
      return;
    }
    const set = createContentSet(rawName, selection);
    if (!set) {
      state.actions.error = "Could not create set.";
      renderWorkspace();
      return;
    }
    persistProject();
    if (input) input.value = "";
    state.ui.contentManageSelections = [];
    state.actions.notice = `Created set ${set.name} with ${set.items.length} position${set.items.length === 1 ? "" : "s"}.`;
    state.actions.error = "";
    renderWorkspace();
    return;
  }

  if (action === "delete-content-set") {
    const setId = button.dataset.setId || "";
    const set = getContentSetById(setId);
    if (!set) {
      renderWorkspace();
      return;
    }
    deleteContentSet(setId);
    persistProject();
    state.actions.notice = `Deleted set ${set.name}.`;
    state.actions.error = "";
    renderWorkspace();
    return;
  }

  if (action === "send-content-set") {
    const setId = button.dataset.setId || "";
    const set = getContentSetById(setId);
    if (!set) {
      state.actions.error = "Set not found.";
      renderWorkspace();
      return;
    }
    const enabledScreens = state.project.screens.filter((screen) => screen.enabled);
    const positions = set.items || [];
    if (enabledScreens.length < positions.length) {
      state.actions.error = `Enable at least ${positions.length} frame${positions.length === 1 ? "" : "s"} before sending this set.`;
      renderWorkspace();
      return;
    }
    const mappedScreenIds = positions.map((_, index) => enabledScreens[index].id);
    const targetNames = positions.map((_, index) => enabledScreens[index].name);
    state.ui.sendFlow = createPendingSendFlow({
      imageName: `Set: ${set.name}`,
      targetNames
    });
    renderWorkspace();
    try {
      const payload = await apiPostJson("/api/content/send-set", {
        setId,
        screenIds: mappedScreenIds
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

  if (action === "clear-content-collections") {
    const imageNames = [...state.ui.contentManageSelections];
    if (!imageNames.length) {
      state.actions.error = "Select images first.";
      renderWorkspace();
      return;
    }
    const changed = clearImagesFromCollections(imageNames);
    persistProject();
    state.ui.contentLibraryFilter = "unassigned";
    state.actions.notice = changed
      ? `Cleared collections on ${changed} poster${changed === 1 ? "" : "s"}.`
      : "Those images were already unassigned.";
    state.actions.error = "";
    renderWorkspace();
    return;
  }

  if (action === "wizard-goto-step") {
    const step = button.dataset.step || "pick";
    if (["pick", "design", "generate"].includes(step)) {
      state.studio.albumArt.step = step;
      renderWorkspace();
      scrollToElement(".wizard-steps", { block: "start" });
    }
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
    if (!state.ui.contentManageMode && state.ui.contentLibraryFilter === "unassigned") {
      state.ui.contentLibraryFilter = "all";
    }
    if (!state.ui.contentManageMode) {
      const visibleNames = new Set(getVisibleOutputImages().map((image) => image.name));
      if (!visibleNames.has(state.ui.contentSelectedImage)) {
        state.ui.contentSelectedImage = getVisibleOutputImages()[0]?.name || "";
      }
    }
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

  if (action === "open-content-edit") {
    const imageName = button.dataset.imageName || state.ui.previewImageName || "";
    if (!imageName) {
      return;
    }
    const existing = getContentImageMeta(imageName).editRecipe;
    state.ui.contentEdit = {
      imageName,
      draft: existing ? { ...getDefaultEditRecipe(), ...existing } : getDefaultEditRecipe(),
      dirty: false,
      saving: false
    };
    state.ui.modal = "content-edit";
    renderWorkspace();
    return;
  }

  if (action === "update-content-edit") {
    if (!state.ui.contentEdit) return;
    const field = button.dataset.field;
    const rawValue = button.dataset.value;
    if (!field) return;
    const draft = state.ui.contentEdit.draft;
    if (field === "rotate") {
      draft.rotate = Number(rawValue) || 0;
    } else {
      draft[field] = rawValue;
    }
    state.ui.contentEdit.dirty = true;
    renderWorkspace();
    return;
  }

  if (action === "reset-content-edit-draft") {
    if (!state.ui.contentEdit) return;
    state.ui.contentEdit.draft = getDefaultEditRecipe();
    state.ui.contentEdit.dirty = true;
    renderWorkspace();
    return;
  }

  if (action === "cancel-content-edit") {
    if (state.ui.contentEdit?.dirty) {
      const confirmed = window.confirm("Discard your unsaved edits?");
      if (!confirmed) {
        return;
      }
    }
    state.ui.contentEdit = null;
    state.ui.modal = null;
    renderWorkspace();
    return;
  }

  if (action === "save-content-edit" || action === "save-content-edit-copy") {
    if (!state.ui.contentEdit?.imageName) return;
    const saveAsCopy = action === "save-content-edit-copy";
    state.ui.contentEdit.saving = true;
    renderWorkspace();
    try {
      const encodedName = encodeURIComponent(state.ui.contentEdit.imageName);
      const payload = await apiPutJson(`/api/content/items/${encodedName}/edit`, {
        editRecipe: state.ui.contentEdit.draft,
        saveAsCopy
      });
      const outputPayload = await loadOutputImages();
      state.outputImages = outputPayload.images || [];
      if (!saveAsCopy) {
        const project = await loadProject();
        state.project = normalizeProject(project);
      }
      state.ui.contentEdit = null;
      state.ui.modal = null;
      state.actions.notice = saveAsCopy
        ? `Saved copy as ${payload?.image?.name || "new image"}.`
        : `Edits saved${payload?.editRecipe ? "" : " (no changes)"}.`;
      state.actions.error = "";
    } catch (error) {
      state.actions.error = error.message;
      if (state.ui.contentEdit) {
        state.ui.contentEdit.saving = false;
      }
    }
    renderWorkspace();
    return;
  }

  if (action === "reset-content-edit") {
    const imageName = button.dataset.imageName || state.ui.previewImageName || "";
    if (!imageName) return;
    try {
      const encodedName = encodeURIComponent(imageName);
      await apiDeleteJson(`/api/content/items/${encodedName}/edit`);
      const outputPayload = await loadOutputImages();
      state.outputImages = outputPayload.images || [];
      const project = await loadProject();
      state.project = normalizeProject(project);
      state.actions.notice = "Edits cleared.";
      state.actions.error = "";
    } catch (error) {
      state.actions.error = error.message;
    }
    renderWorkspace();
    return;
  }

  if (action === "cancel-content") {
    if (state.ui.contentManageMode) {
      state.ui.contentManageMode = false;
      state.ui.contentManageSelections = [];
      if (state.ui.contentLibraryFilter === "unassigned") {
        state.ui.contentLibraryFilter = "all";
      }
      const visibleNames = new Set(getVisibleOutputImages().map((image) => image.name));
      if (!visibleNames.has(state.ui.contentSelectedImage)) {
        state.ui.contentSelectedImage = getVisibleOutputImages()[0]?.name || "";
      }
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
    pruneContentLibraryForImages(payload.deleted || names);
    persistProject();
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

  if (action === "dismiss-toast") {
    const toastId = button.dataset.toastId || "";
    state.ui.toasts = state.ui.toasts.filter((toast) => toast.id !== toastId);
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
      state.spotify.albumResults = [];
      state.spotify.artistView = "results";
      state.spotify.artistAlbums = [];
      state.spotify.artistAlbumsPage = 1;
      state.spotify.artistAlbumsTotal = 0;
      state.spotify.artistAlbumsHasMore = false;
      state.spotify.artistAlbumFilter = "album";
      state.spotify.selectedArtistId = "";
      state.spotify.selectedArtistName = "";
      state.spotify.notice = state.spotify.artistResults.length ? "" : "No artist matches found.";
      renderWorkspace();
      return;
    }

  if (action === "spotify-search-albums") {
      const query = document.getElementById("spotify-album-query")?.value?.trim() || "";
      state.spotify.albumQuery = query;
      state.spotify.albumResults = query ? await apiGetJson(`/api/spotify/search/albums?q=${encodeURIComponent(query)}`) : [];
      state.spotify.artistResults = [];
      state.spotify.artistView = "results";
      state.spotify.artistAlbums = [];
      state.spotify.artistAlbumsPage = 1;
      state.spotify.artistAlbumsTotal = 0;
      state.spotify.artistAlbumsHasMore = false;
      state.spotify.artistAlbumFilter = "album";
      state.spotify.selectedArtistId = "";
      state.spotify.selectedArtistName = "";
      state.spotify.notice = state.spotify.albumResults.length ? "" : "No album matches found.";
      renderWorkspace();
      return;
    }

  if (action === "spotify-load-artist") {
      const artistId = button.dataset.artistId;
      const artist = state.spotify.artistResults.find((entry) => entry.id === artistId);
      state.spotify.artistView = "albums";
      state.spotify.artistAlbumsPage = 1;
      state.spotify.artistAlbumFilter = "album";
      state.spotify.selectedArtistId = artistId;
      await loadSpotifyArtistAlbumsPage({ artistId, filter: "album", offset: 0, append: false });
      state.spotify.selectedArtistName = artist?.name || "Artist";
      state.spotify.notice = `Loaded ${state.spotify.artistAlbumsTotal || state.spotify.artistAlbums.length} album releases for ${state.spotify.selectedArtistName}.`;
      renderWorkspace();
      scrollToElement(".spotify-results--albums", { block: "nearest" });
      return;
    }

  if (action === "spotify-filter-albums") {
      const filter = button.dataset.filter || "album";
      state.spotify.artistAlbumFilter = filter;
      await loadSpotifyArtistAlbumsPage({
        artistId: state.spotify.selectedArtistId,
        filter,
        offset: 0,
        append: false
      });
      state.spotify.notice = state.spotify.artistAlbumsTotal
        ? `Loaded ${state.spotify.artistAlbumsTotal} ${filter === "all" ? "releases" : `${filter} releases`} for ${state.spotify.selectedArtistName}.`
        : `No ${filter === "all" ? "releases" : filter} releases found for ${state.spotify.selectedArtistName}.`;
      renderWorkspace();
      return;
    }

  if (action === "spotify-albums-show-more") {
      await loadSpotifyArtistAlbumsPage({
        artistId: state.spotify.selectedArtistId,
        filter: state.spotify.artistAlbumFilter,
        offset: state.spotify.artistAlbums.length,
        append: true
      });
      renderWorkspace();
      return;
    }

  if (action === "spotify-back-to-artists") {
      state.spotify.artistView = "results";
      state.spotify.artistAlbums = [];
      state.spotify.artistAlbumsPage = 1;
      state.spotify.artistAlbumsTotal = 0;
      state.spotify.artistAlbumsHasMore = false;
      state.spotify.artistAlbumFilter = "album";
      state.spotify.selectedArtistId = "";
      state.spotify.selectedArtistName = "";
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
    state.spotify.notice = `Added ${imported.artist} — ${imported.album} to batch.`;
    renderWorkspace();
    scrollToElement(".wizard-selection-tray", { block: "nearest" });
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
    state.spotify.notice = `Added ${imported.length} albums from playlist to batch.`;
    renderWorkspace();
    scrollToElement(".wizard-selection-tray", { block: "nearest" });
  }
}

async function handleContentUpload(event) {
  const files = event.target?.files ? Array.from(event.target.files) : Array.from(event);
  if (!files.length) {
    return;
  }

  const replaceName = state.ui.contentReplaceImage || "";
  let lastUploaded = null;
  let count = 0;

  for (const file of files) {
    const options = count === 0 && replaceName ? { replaceName } : {};
    lastUploaded = await apiUploadImage("/api/output-images/upload", file, options);
    count++;
  }

  const outputPayload = await loadOutputImages();
  state.outputImages = outputPayload.images || [];
  state.outputDirectory = outputPayload.directory || "";
  if (lastUploaded?.replaced && lastUploaded.image?.name && lastUploaded.image.name !== lastUploaded.replaced) {
    migrateContentImageMeta(lastUploaded.replaced, lastUploaded.image.name);
    persistProject();
  }
  state.ui.contentSelectedImage = lastUploaded?.image?.name || "";
  state.ui.contentReplaceImage = "";
  state.ui.contentManageMode = false;
  state.ui.contentManageSelections = [];
  state.actions.notice = count === 1
    ? (lastUploaded?.replaced
        ? `Replaced ${lastUploaded.replaced}${lastUploaded.image?.name && lastUploaded.image.name !== lastUploaded.replaced ? ` with ${lastUploaded.image.name}` : ""}.`
        : `Uploaded ${lastUploaded?.image?.name || files[0].name}.`)
    : `Uploaded ${count} images.`;
  state.actions.error = "";
  if (event.target?.value !== undefined) {
    event.target.value = "";
  }
  renderWorkspace();
}

function bindContentDropZone() {
  const zone = app.querySelector(".content-panel");
  if (!zone) {
    return;
  }

  zone.addEventListener("dragover", (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    zone.classList.add("is-dragover");
  });

  zone.addEventListener("dragleave", (event) => {
    if (!zone.contains(event.relatedTarget)) {
      zone.classList.remove("is-dragover");
    }
  });

  zone.addEventListener("drop", (event) => {
    event.preventDefault();
    zone.classList.remove("is-dragover");
    const files = Array.from(event.dataTransfer.files).filter((file) => file.type.startsWith("image/"));
    if (!files.length) {
      return;
    }
    state.ui.contentReplaceImage = "";
    handleContentUpload(files).catch((error) => {
      state.actions.error = error.message;
      renderWorkspace();
    });
  });
}

function bindContentEditForm() {
  const form = document.getElementById("content-edit-form");
  if (!form || !state.ui.contentEdit) {
    return;
  }
  const previewImg = document.getElementById("content-edit-preview-img");

  const applyLiveUpdate = () => {
    if (!state.ui.contentEdit) return;
    const draft = state.ui.contentEdit.draft;
    if (previewImg) {
      previewImg.style.filter = buildEditPreviewFilter(draft);
      previewImg.style.transform = `rotate(${draft.rotate}deg)`;
    }
    form.querySelectorAll("[data-value-for]").forEach((el) => {
      const field = el.dataset.valueFor;
      if (field in draft) {
        const value = draft[field];
        const digits = ["sharpen", "blur"].includes(field) ? 1 : 2;
        el.textContent = Number(value).toFixed(digits);
      }
    });
  };

  form.addEventListener("input", (event) => {
    if (!state.ui.contentEdit) return;
    const target = event.target;
    const name = target?.name;
    if (!name) return;
    const draft = state.ui.contentEdit.draft;
    if (target.type === "checkbox") {
      draft[name] = target.checked;
    } else if (target.type === "range") {
      draft[name] = Number(target.value);
    } else if (target.tagName === "SELECT") {
      if (name === "targetScreenId") {
        draft[name] = target.value || null;
      } else {
        draft[name] = target.value;
      }
    } else {
      draft[name] = target.value;
    }
    state.ui.contentEdit.dirty = true;
    applyLiveUpdate();
  });

  form.addEventListener("change", (event) => {
    if (event.target?.tagName === "SELECT" && event.target.name === "targetScreenId") {
      renderWorkspace();
    }
  });
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
  const defaultRoomName = state.project.rooms?.[0]?.name || "";
  const defaultRoomId = state.project.rooms?.[0]?.id || createLocationId(defaultRoomName || "ungrouped");
  const defaultWall = state.project.walls?.find((wall) => wall.roomId === defaultRoomId) || state.project.walls?.[0];
  const defaultWallName = defaultWall?.name || inferWallName("", defaultRoomName);
  const defaultWallId = defaultWall?.id || createLocationId(`${defaultRoomId}-${defaultWallName || "wall"}`);
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
    },
    roomId: defaultRoomId,
    roomName: defaultRoomName || humanizeLocationId(defaultRoomId),
    wallId: defaultWallId,
    wallName: defaultWallName || humanizeLocationId(defaultWallId),
    wallSlot: ""
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

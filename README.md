# Samsung EMDX Control App

A local control app for Samsung EMDX e-ink displays. Manages a content library of images, organizes them into collections and ordered wall layouts, edits images for e-ink display, and delivers them to Samsung frames over the local network with scheduling support.

## Product Surfaces

### Devices

Configure Samsung displays grouped by room and wall. Each screen has a name, resolution, Samsung EMDX connection details (host, pin, MAC), and a wall slot assignment (left, center, right) for ordered layouts. Rooms and walls give structure to multi-frame arrangements.

### Content

Browse, organize, edit, and send images to frames.

- **Browse mode**: search, sort, preview, favorite, and send individual posters. Filter by collection, favorites, or search query. Sort by name, date, resolution, recently edited, or recently sent.
- **Manage mode**: multi-select images to create collections (browseable themes) or ordered sets (multi-frame wall layouts like triptychs). Create and manage schedules for timed sends.
- **Edit mode**: non-destructive image preparation for e-ink display. Frame crop (quick-fit presets or manual zoom/pan), color (grayscale, vibrance), levels (brightness, contrast, gamma, black/white point), detail (sharpen, blur), and rotation. All edits are recipe-based: the original is never modified.
- **Ordered sets**: assign images to wall positions (left/center/right), map them to a physical wall, and send or schedule the entire layout as one action.
- **Scheduling**: one-time, daily, or weekly automated sends for both single posters and wall layouts. Schedules are polled server-side every 30 seconds.

### Studio

Spotify-driven album discovery and poster generation.

- Search for artists, browse their discography, or import albums from playlists.
- Imported albums include cached cover art and extracted color palettes.
- Generate posters from templates (`music-editorial-v1`, `music-minimal-v1`) into the shared Content library.

### Delivery

Wake-on-LAN, device status polling, and send-job tracking with real-time progress. Send jobs report per-target milestones: wake sent, content set, content JSON fetched, image fetched.

## Architecture

### Server

| File | Purpose |
|---|---|
| `server/app.mjs` | Express API server, static hosting, schedule polling |
| `server/env.mjs` | Environment loading with defaults |
| `server/db.mjs` | SQLite connection and schema (WAL mode) |
| `server/project-store.mjs` | Project config persistence |
| `server/album-store.mjs` | Album catalog (fixtures + imports) |
| `server/device-state-store.mjs` | Per-screen last-sent state and preview snapshots |
| `server/content-schedule-store.mjs` | Schedule persistence |
| `server/send-job-store.mjs` | In-memory send job tracking |
| `server/spotify-client.mjs` | Spotify Web API client |
| `server/spotify-importer.mjs` | Album normalization, cover download, palette extraction |
| `server/device-diagnostics.mjs` | Device wake and status via Samsung MDC |
| `server/device-discovery.mjs` | Network scan for Samsung displays |

### Client

| File | Purpose |
|---|---|
| `src/app.js` | Single-page app with state management and DOM rendering |
| `src/api.js` | Fetch helpers (GET, POST, PUT, DELETE JSON) |
| `src/styles.css` | Full stylesheet |
| `src/default-project.js` | Seed project with sample screens |
| `src/templates/` | Poster template implementations |

### Scripts

| File | Purpose |
|---|---|
| `scripts/server-dev.mjs` | Dev server launcher |
| `scripts/export.mjs` | Headless render of all enabled screens to PNG/JPG |
| `scripts/send.mjs` | CLI send to Samsung displays |
| `scripts/render-and-send.mjs` | Render then send in one step |
| `scripts/lib/image-edit-service.mjs` | Sharp-based edit recipe pipeline (rotate, resize, crop, tone, detail) |
| `scripts/lib/send-service.mjs` | Samsung EMDX delivery with per-screen image path resolution |
| `scripts/lib/samsung-emdx.mjs` | Low-level Samsung EMDX binary wrapper |

## Setup

```bash
npm install
cp .env.example .env   # fill in Spotify credentials and device IPs
npm run dev             # starts at http://localhost:4173
```

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `SPOTIFY_CLIENT_ID` | For Studio | Spotify app client ID |
| `SPOTIFY_CLIENT_SECRET` | For Studio | Spotify app client secret |
| `DATABASE_PATH` | No | SQLite path (default: `./data/poster-wall.db`) |
| `DEFAULT_LOCAL_IP` | No | Local IP for Samsung EMDX content serving |
| `SAMSUNG_EMDX_BIN` | No | Path to samsung-emdx binary |
| `APP_PORT` | No | Server port (default: 4173) |
| `OUTPUT_DIR` | No | Image output directory (default: `./output`) |

## Commands

```bash
npm run dev             # start dev server
npm run export          # headless render all enabled screens
npm run send:dry        # dry-run send (shows commands without executing)
npm run send            # send rendered images to displays
npm run render-send:dry # render + dry-run send
npm run render-send     # render + send
npm test                # run Playwright e2e tests
npm run test:headed     # run tests with visible browser
```

Target a single screen by name:

```bash
node scripts/send.mjs living-room-1 --dry-run
node scripts/render-and-send.mjs living-room-1
```

## Testing

Playwright e2e tests cover the Content library flow: image metadata, preview modal, fit-check warnings, edit recipe round-trip, dirty-edit discard, manual crop mode, search/sort, favorites, ordered set creation, wall layout management, collection assignment, and scheduling.

```bash
npm test
```

Tests use a dedicated SQLite database and fixture images generated via Sharp. Each run gets a unique timestamped DB path so stale Windows file locks never block the suite.

## Notes

- Project state is persisted to SQLite. `data/project.json` is a seed/example only.
- Imported cover art is cached under `assets/covers/imported/`.
- Edit recipes are non-destructive: the original image is never modified. Derived outputs are cached at `output/.edit-cache/`.
- The schedule runner polls every 30 seconds. It tracks `lastRunKey` per schedule to avoid duplicate runs within the same time window.
- Do not commit `.env` or share Spotify credentials. Rotate secrets before sharing the project.

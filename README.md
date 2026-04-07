# Poster Wall Control

Local poster-wall system for Samsung EMDX displays with:

- a modular web UI for screen configuration and preview
- a local backend for persistence and API integrations
- SQLite-backed project storage
- Spotify import for artist and playlist-driven album discovery
- exact-size `PNG` and `JPG` export
- Samsung EMDX delivery scripts driven by the same screen model

## Architecture

- `server/env.mjs`: environment loading
- `server/db.mjs`: SQLite connection and schema
- `server/project-store.mjs`: saved project config
- `server/album-store.mjs`: fixture + imported album catalog
- `server/spotify-client.mjs`: Spotify API client
- `server/spotify-importer.mjs`: album normalization, cover download, palette extraction
- `server/app.mjs`: API server + static app hosting
- `src/template-registry.js`: poster template registry
- `src/templates/`: poster implementations
- `scripts/export.mjs`: render all enabled screens from config
- `scripts/send.mjs`: send rendered images to Samsung screens
- `scripts/render-and-send.mjs`: render first, then send

## Configuration

Use `.env` for local secrets and machine-specific settings. `.env.example` shows the shape.

Important values:

- `SPOTIFY_CLIENT_ID`
- `SPOTIFY_CLIENT_SECRET`
- `DATABASE_PATH`
- `DEFAULT_LOCAL_IP`
- `SAMSUNG_EMDX_BIN`

SQLite runs as a normal local file. Docker is not required for it.

## Screen Model

The live project is stored in SQLite. `data/project.json` is now just a seed/example config.

Each screen has:

```json
{
  "id": "living-room-1",
  "name": "Living Room 1",
  "enabled": true,
  "profile": "music",
  "template": "music-editorial-v1",
  "albumSlug": "ten",
  "size": { "width": 1440, "height": 2560 },
  "frame": {
    "paddingTop": 60,
    "paddingRight": 60,
    "paddingBottom": 60,
    "paddingLeft": 60,
    "swatchCount": 5,
    "imageFit": "cover"
  },
  "device": {
    "host": "192.168.1.201",
    "pin": "123456",
    "mac": "",
    "localIp": ""
  }
}
```

The output contract is consistent across screens, but each template can interpret the frame settings differently.

## Commands

```bash
npm install
npm run dev
npm run export
npm run send:dry
npm run send
npm run render-send:dry
npm run render-send
```

Target a single screen:

```bash
node scripts/send.mjs living-room-1 --dry-run
node scripts/render-and-send.mjs living-room-1
```

Use a file config instead of the saved SQLite project:

```bash
node scripts/export.mjs data/project.json
node scripts/send.mjs data/project.json living-room-1 --dry-run
```

## Workflow

1. Start the app with `npm run dev`.
2. Edit screens and templates in the web UI.
3. Search Spotify artists or import playlist albums into the local catalog.
4. Assign imported albums to screens.
5. Use the web UI or CLI to render one screen or the whole wall.
6. Use dry-run send to inspect Samsung delivery commands.
7. Send to displays when the device fields are correct.

## Current Scope

- portrait `9:16` screen defaults
- `music-editorial-v1`
- `music-minimal-v1`
- per-screen output size, frame padding, swatch count, image fit, and Samsung device fields
- imported Spotify albums stored locally with cached cover art and extracted palettes
- web UI actions for render, dry-run send, and confirmed send flows

## Notes

- The dev UI persists project changes to SQLite and also keeps a browser fallback copy.
- Imported cover art is stored under `assets/covers/imported/`.
- If you share this project later, do not share your current Spotify secret as-is. Rotate it first.

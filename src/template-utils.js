export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function scaleByLength(length, base, floor, step = 2, trigger = 12) {
  if (length <= trigger) {
    return base;
  }
  return Math.max(floor, base - (length - trigger) * step);
}

export function formatTrackCount(tracks) {
  return `${tracks.length} ${tracks.length === 1 ? "track" : "tracks"}`;
}

export function formatRuntime(tracks) {
  const seconds = tracks.reduce((sum, track) => {
    const [minutes, remainder] = track.length.split(":").map(Number);
    return sum + minutes * 60 + remainder;
  }, 0);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")} total`;
}

export function splitTracks(tracks) {
  const midpoint = Math.ceil(tracks.length / 2);
  return [tracks.slice(0, midpoint), tracks.slice(midpoint)];
}

export function normalizeMusicAlbum(raw) {
  return {
    kind: "music",
    slug: raw.slug,
    artist: raw.artist,
    album: raw.album,
    year: raw.year,
    label: raw.label,
    format: raw.format || "LP / Digital",
    cover: raw.cover,
    palette: raw.palette || ["#111111", "#ffffff"],
    footer: raw.footer || "",
    tracks: raw.tracks || []
  };
}

export function posterStyle(screen, extra = {}) {
  const {
    size: { width, height },
    frame
  } = screen;

  const style = {
    "--poster-width": `${width}px`,
    "--poster-height": `${height}px`,
    "--frame-top": `${frame.paddingTop}px`,
    "--frame-right": `${frame.paddingRight}px`,
    "--frame-bottom": `${frame.paddingBottom}px`,
    "--frame-left": `${frame.paddingLeft}px`,
    "--frame-fit": frame.imageFit || "cover",
    ...extra
  };

  return Object.entries(style)
    .map(([key, value]) => `${key}:${value}`)
    .join(";");
}

export function renderSwatches(colors, count = 5) {
  return colors
    .slice(0, count)
    .map(
      (color) =>
        `<span class="poster-swatch" style="background:${color}" aria-hidden="true"></span>`,
    )
    .join("");
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

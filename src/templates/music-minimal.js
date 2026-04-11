import {
  clamp,
  escapeHtml,
  posterStyle,
  renderSwatches,
  scaleByLength,
  splitTracks
} from "../template-utils.js";

function formatReleaseDate(releaseDate, year) {
  const hasFullDate = releaseDate && releaseDate.length >= 10;
  if (hasFullDate) {
    try {
      const date = new Date(releaseDate + "T00:00:00");
      return {
        label: "Released on",
        value: date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }).toUpperCase()
      };
    } catch { /* fall through */ }
  }
  return {
    label: "Released",
    value: String(year || "Unknown")
  };
}

export const musicMinimalTemplate = {
  id: "music-minimal-v1",
  profile: "music",
  name: "Music Minimal",
  description: "Large art block with a restrained type system and open space.",
  render({ screen, album }) {
    const isPortrait = screen.size.height > screen.size.width;
    const trackCount = album.tracks.length;
    const useTwoColumns = trackCount > 28;
    const [firstColumn, secondColumn] = useTwoColumns ? splitTracks(album.tracks) : [album.tracks, []];

    // Scale relative to canvas height for consistent sizing across resolutions
    const h = screen.size.height;
    const scale = h / 2560;

    const artistSize = Math.round(clamp(scaleByLength(album.artist.length, 72, 42, 1.8, 16) * scale, 36 * scale, 72 * scale));
    const albumSize = Math.round(clamp(scaleByLength(album.album.length, 96, 52, 2.2, 14) * scale, 44 * scale, 96 * scale));
    const metaSize = Math.round(clamp(scaleByLength((album.label || "").length, 40, 28, 0.5, 18) * scale, 28 * scale, 40 * scale));
    const metaLabelSize = Math.round(24 * scale);
    const trackSize = Math.round(clamp(42 - Math.max(0, trackCount - 12) * 1.2, 28, 42) * scale);
    const trackGap = Math.round((trackCount <= 14 ? 18 : trackCount <= 20 ? 14 : 8) * scale);
    const trackLeading = trackCount <= 14 ? 1.35 : trackCount <= 20 ? 1.25 : 1.15;
    const swatchSize = Math.round((useTwoColumns ? 72 : 100) * scale);
    const swatchCount = screen.frame.swatchCount || 5;
    const hasLabel = album.label && album.label !== "Spotify" && album.label !== "Unknown Label";
    const release = formatReleaseDate(album.releaseDate, album.year);

    return `
      <article
        class="poster poster--minimal ${isPortrait ? "is-portrait" : "is-landscape"}"
        data-template="${this.id}"
        style="${posterStyle(screen, {
          "--accent": album.palette[0] || "#222222",
          "--accent-soft": album.palette[1] || "#e2dfd6",
          "--muted": album.palette[3] || "#5d5d58",
          "--artist-size": `${artistSize}px`,
          "--album-size": `${albumSize}px`,
          "--minimal-meta-size": `${metaSize}px`,
          "--minimal-meta-label-size": `${metaLabelSize}px`,
          "--minimal-track-size": `${trackSize}px`,
          "--minimal-track-gap": `${trackGap}px`,
          "--minimal-track-leading": `${trackLeading}`,
          "--minimal-swatch-size": `${swatchSize}px`
        })}"
      >
        <div class="minimal-shell">
          <div class="minimal-art-panel">
            <div class="minimal-art-frame">
              <img src="${escapeHtml(album.cover)}" alt="${escapeHtml(`${album.album} cover art`)}" />
            </div>
          </div>
          <div class="minimal-copy-panel ${useTwoColumns ? "is-two-column-list" : ""}">
            <div class="minimal-track-panel">
              <ol class="minimal-track-list">
                ${firstColumn
                  .map(
                    (track, index) => `
                      <li>
                        <span class="minimal-track-index">${index + 1}.</span>
                        <span class="minimal-track-title">${escapeHtml(track.title)}</span>
                      </li>
                    `,
                  )
                  .join("")}
              </ol>
              ${
                useTwoColumns
                  ? `
                    <ol class="minimal-track-list" start="${firstColumn.length + 1}">
                      ${secondColumn
                        .map(
                          (track, index) => `
                            <li>
                              <span class="minimal-track-index">${firstColumn.length + index + 1}.</span>
                              <span class="minimal-track-title">${escapeHtml(track.title)}</span>
                            </li>
                          `,
                        )
                        .join("")}
                    </ol>
                  `
                  : ""
              }
            </div>
            <div class="minimal-info-panel">
              <div class="minimal-meta-panel">
                <div class="minimal-meta-block">
                  <span>${release.label}</span>
                  <strong>${escapeHtml(release.value)}</strong>
                </div>
                ${hasLabel ? `
                  <div class="minimal-meta-block minimal-meta-block--label">
                    <span>Released by</span>
                    <strong>${escapeHtml(album.label)}</strong>
                  </div>
                ` : ""}
              </div>
              <div class="poster-swatches poster-swatches--minimal">${renderSwatches(album.palette, swatchCount)}</div>
              <div class="minimal-title-lockup">
                <p class="minimal-title-artist">${escapeHtml(album.artist)}</p>
                <h1 class="minimal-title-album">${escapeHtml(album.album)}</h1>
              </div>
            </div>
          </div>
        </div>
      </article>
    `;
  }
};

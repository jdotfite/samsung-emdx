import {
  escapeHtml,
  posterStyle,
  renderSwatches,
  scaleByLength
} from "../template-utils.js";

export const musicMinimalTemplate = {
  id: "music-minimal-v1",
  profile: "music",
  name: "Music Minimal",
  description: "Large art block with a restrained type system and open space.",
  render({ screen, album }) {
    const isPortrait = screen.size.height > screen.size.width;
    const artistSize = scaleByLength(album.artist.length, isPortrait ? 98 : 86, isPortrait ? 60 : 52, 2.2, 12);
    const albumSize = scaleByLength(album.album.length, isPortrait ? 138 : 118, isPortrait ? 76 : 70, 2.6, 10);

    return `
      <article
        class="poster poster--minimal ${isPortrait ? "is-portrait" : "is-landscape"}"
        data-template="${this.id}"
        style="${posterStyle(screen, {
          "--accent": album.palette[0] || "#222222",
          "--accent-soft": album.palette[1] || "#e2dfd6",
          "--muted": album.palette[3] || "#5d5d58",
          "--artist-size": `${artistSize}px`,
          "--album-size": `${albumSize}px`
        })}"
      >
        <div class="minimal-shell">
          <div class="minimal-art-panel">
            <div class="minimal-art-frame">
              <img src="${escapeHtml(album.cover)}" alt="${escapeHtml(`${album.album} cover art`)}" />
            </div>
          </div>
          <div class="minimal-copy-panel">
            <h1 class="poster-album poster-album--serif">${escapeHtml(album.album)}</h1>
            <h2 class="poster-artist">${escapeHtml(album.artist)}</h2>
            <div class="minimal-rule"></div>
            <div class="poster-swatches poster-swatches--minimal">${renderSwatches(album.palette, screen.frame.swatchCount || 5)}</div>
            <ol class="minimal-track-list">
              ${album.tracks
                .slice(0, isPortrait ? 11 : 8)
                .map(
                  (track, index) => `
                    <li>
                      <span>${String(index + 1).padStart(2, "0")}.</span>
                      <span>${escapeHtml(track.title)}</span>
                      <span>${escapeHtml(track.length)}</span>
                    </li>
                  `,
                )
                .join("")}
            </ol>
          </div>
        </div>
      </article>
    `;
  }
};

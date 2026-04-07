import {
  escapeHtml,
  posterStyle,
  renderSwatches,
  scaleByLength,
  splitTracks
} from "../template-utils.js";

export const musicEditorialTemplate = {
  id: "music-editorial-v1",
  profile: "music",
  name: "Music Editorial",
  description: "Framed art with dense metadata and a print-poster rhythm.",
  render({ screen, album }) {
    const isPortrait = screen.size.height > screen.size.width;
    const artistSize = scaleByLength(album.artist.length, isPortrait ? 132 : 118, isPortrait ? 74 : 68, 2.4, 12);
    const albumSize = scaleByLength(album.album.length, isPortrait ? 124 : 108, isPortrait ? 74 : 64, 2.5, 10);
    const trackSize = scaleByLength(
      Math.max(...album.tracks.map((track) => track.title.length)),
      isPortrait ? 34 : 28,
      isPortrait ? 24 : 21,
      0.55,
      20,
    );
    const [firstColumn, secondColumn] = splitTracks(album.tracks);

    return `
      <article
        class="poster poster--editorial ${isPortrait ? "is-portrait" : "is-landscape"}"
        data-template="${this.id}"
        style="${posterStyle(screen, {
          "--accent": album.palette[0] || "#191919",
          "--accent-soft": album.palette[2] || "#d8d3c6",
          "--muted": album.palette[3] || "#5f5c53",
          "--artist-size": `${artistSize}px`,
          "--album-size": `${albumSize}px`,
          "--track-size": `${trackSize}px`
        })}"
      >
        <div class="editorial-shell">
          <div class="editorial-art">
            <img src="${escapeHtml(album.cover)}" alt="${escapeHtml(`${album.album} cover art`)}" />
          </div>
          <div class="editorial-copy">
            <div class="poster-kicker-row">
              <p class="poster-kicker poster-kicker--solo">${escapeHtml(album.year)}</p>
            </div>
            <h1 class="poster-artist">${escapeHtml(album.artist)}</h1>
            <h2 class="poster-album poster-album--serif">${escapeHtml(album.album)}</h2>
            <div class="poster-swatches poster-swatches--editorial">${renderSwatches(album.palette, screen.frame.swatchCount || 5)}</div>
            <div class="editorial-tracks">
              <ol class="poster-track-column">
                ${firstColumn
                  .map(
                    (track, index) => `
                      <li class="poster-track">
                        <span class="poster-track-index">${String(index + 1).padStart(2, "0")}</span>
                        <span class="poster-track-title">${escapeHtml(track.title)}</span>
                        <span class="poster-track-length">${escapeHtml(track.length)}</span>
                      </li>
                    `,
                  )
                  .join("")}
              </ol>
              <ol class="poster-track-column" start="${firstColumn.length + 1}">
                ${secondColumn
                  .map(
                    (track, index) => `
                      <li class="poster-track">
                        <span class="poster-track-index">${String(firstColumn.length + index + 1).padStart(2, "0")}</span>
                        <span class="poster-track-title">${escapeHtml(track.title)}</span>
                        <span class="poster-track-length">${escapeHtml(track.length)}</span>
                      </li>
                    `,
                  )
                  .join("")}
              </ol>
            </div>
          </div>
        </div>
      </article>
    `;
  }
};

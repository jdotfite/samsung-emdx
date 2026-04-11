import {
  clamp,
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
    const trackCount = album.tracks.length;
    const useTwoColumns = trackCount > 16;
    const [firstColumn, secondColumn] = useTwoColumns ? splitTracks(album.tracks) : [album.tracks, []];
    const longestTrackTitle = Math.max(...album.tracks.map((track) => track.title.length));
    // For sizing, treat single-column as if it were split across two columns
    const effectiveColumnTracks = useTwoColumns ? Math.max(firstColumn.length, secondColumn.length) : Math.ceil(trackCount / 2);
    const artistSize = scaleByLength(album.artist.length, isPortrait ? 124 : 112, isPortrait ? 72 : 66, 2.3, 12);
    const albumSize = scaleByLength(album.album.length, isPortrait ? 132 : 116, isPortrait ? 76 : 66, 2.5, 10);
    const trackDensityScore = longestTrackTitle + effectiveColumnTracks * 3;
    const trackSize = clamp(
      scaleByLength(trackDensityScore, isPortrait ? 42 : 34, isPortrait ? 22 : 19, 0.85, 34),
      isPortrait ? 22 : 19,
      isPortrait ? 44 : 35,
    );
    const copyGap = clamp((isPortrait ? 28 : 24) - Math.max(0, effectiveColumnTracks - 5) * 2, 14, isPortrait ? 28 : 24);
    const titleGap = effectiveColumnTracks <= 6 ? 10 : 6;
    const trackRowGap = effectiveColumnTracks <= 6 ? 8 : effectiveColumnTracks <= 8 ? 7 : 5;
    const trackPadding = effectiveColumnTracks <= 6 ? 9 : effectiveColumnTracks <= 8 ? 8 : 6;
    const tracksTop = effectiveColumnTracks <= 6 ? 22 : effectiveColumnTracks <= 8 ? 18 : 14;

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
          "--track-size": `${trackSize}px`,
          "--editorial-copy-gap": `${copyGap}px`,
          "--editorial-title-gap": `${titleGap}px`,
          "--track-column-gap": `${trackRowGap}px`,
          "--track-padding-bottom": `${trackPadding}px`,
          "--editorial-tracks-top": `${tracksTop}px`
        })}"
      >
        <div class="editorial-shell">
          <div class="editorial-art">
            <img src="${escapeHtml(album.cover)}" alt="${escapeHtml(`${album.album} cover art`)}" />
          </div>
          <div class="editorial-copy">
            <div class="poster-kicker-row">
              <p class="poster-kicker poster-kicker--solo poster-kicker--year">${escapeHtml(album.year)}</p>
            </div>
            <div class="editorial-title-stack">
              <h1 class="poster-album poster-album--serif">${escapeHtml(album.album)}</h1>
              <h2 class="poster-artist">${escapeHtml(album.artist)}</h2>
            </div>
            <div class="poster-swatches poster-swatches--editorial">${renderSwatches(album.palette, screen.frame.swatchCount || 5)}</div>
            <div class="editorial-tracks ${useTwoColumns ? "is-two-columns" : "is-single-column"}">
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
              ${useTwoColumns ? `
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
              ` : ""}
            </div>
          </div>
        </div>
      </article>
    `;
  }
};

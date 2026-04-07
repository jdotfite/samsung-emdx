const albumArtGeneratorPlugin = {
  id: "album-art-generator",
  name: "Album Art Dynamic Image Creator",
  shortName: "Album Art",
  category: "Music Posters",
  status: "installed",
  version: "0.1.0",
  mark: "AA",
  accent: "#d1b78c",
  summary: "Generate e-ink-ready album posters from Spotify imports, playlists, and local cover art.",
  capabilities: ["Spotify artist search", "Playlist album import", "Exact portrait poster outputs"],
  detailSections: [
    {
      title: "Overview",
      body: "Turns album metadata, cover art, and layout rules into display-ready posters for your Samsung EMDX wall."
    }
  ],
  renderWorkspace({ helpers }) {
    return helpers.renderAlbumArtWorkspace();
  }
};

export default albumArtGeneratorPlugin;

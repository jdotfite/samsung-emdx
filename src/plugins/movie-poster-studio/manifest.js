const moviePosterStudioPlugin = {
  id: "movie-poster-studio",
  name: "Movie Poster Studio",
  shortName: "Movie Posters",
  category: "Cinema",
  status: "planned",
  version: "0.0.1",
  mark: "MV",
  accent: "#b65a42",
  summary: "Create film-focused poster layouts with title treatment, credits, release year, and theatrical imagery.",
  capabilities: ["Movie metadata adapters", "Cast and credits blocks", "Landscape or portrait poster layouts"],
  detailSections: [
    {
      title: "Planned inputs",
      body: "TMDb-style search, manual poster uploads, curated collections, and alternate layouts for minimalist or theatrical treatments."
    },
    {
      title: "Planned outputs",
      body: "Three-across film walls, director retrospectives, and rotating movie display schedules for the same Samsung device fleet."
    }
  ],
  renderWorkspace({ helpers, plugin }) {
    return helpers.renderPlaceholderPluginWorkspace(plugin, {
      kicker: "Placeholder",
      title: "Movie poster generation is not wired yet.",
      body: "When implemented, this workspace will expose title search, poster variants, credits metadata, and render presets."
    });
  }
};

export default moviePosterStudioPlugin;

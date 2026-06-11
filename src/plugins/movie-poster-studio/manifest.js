const moviePosterStudioPlugin = {
  id: "movie-poster-studio",
  name: "Movie Poster Studio",
  shortName: "Movie Posters",
  category: "Cinema",
  status: "installed",
  version: "1.0.0",
  mark: "MV",
  accent: "#b65a42",
  summary: "Search movies by keyword, genre, or studio. Import posters at 1440×2560 and rotate them across your frames automatically.",
  capabilities: ["Keyword & studio search via TMDB", "Auto-rotation across selected frames", "Manual browse & import by title"],
  detailSections: [],
  renderWorkspace({ helpers }) {
    return helpers.renderTmdbWorkspace();
  }
};

export default moviePosterStudioPlugin;

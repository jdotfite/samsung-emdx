const cityPulsePlugin = {
  id: "city-pulse",
  name: "City Pulse Boards",
  shortName: "City Pulse",
  category: "Ambient Data",
  status: "concept",
  version: "0.0.1",
  mark: "CP",
  accent: "#5d7f92",
  summary: "Generate quiet daily boards with weather, time blocks, transit notes, and neighborhood-specific ambient data.",
  capabilities: ["Daily scheduled refreshes", "Location-driven layouts", "Low-noise dashboard posters"],
  detailSections: [
    {
      title: "Concept direction",
      body: "This is a placeholder for a non-poster plugin that still fits the wall-display system: calm information graphics instead of media art."
    },
    {
      title: "Why it matters",
      body: "It proves the plugin model is broader than music and movies and keeps the architecture reusable for other display experiences."
    }
  ],
  renderWorkspace({ helpers, plugin }) {
    return helpers.renderPlaceholderPluginWorkspace(plugin, {
      kicker: "Concept",
      title: "City Pulse Boards are still a concept.",
      body: "This workspace will eventually hold calm daily information boards driven by location, weather, and local context."
    });
  }
};

export default cityPulsePlugin;

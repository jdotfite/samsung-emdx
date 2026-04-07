import albumArtGeneratorPlugin from "./plugins/album-art-generator/manifest.js";
import moviePosterStudioPlugin from "./plugins/movie-poster-studio/manifest.js";
import cityPulsePlugin from "./plugins/city-pulse/manifest.js";

export const STUDIO_PLUGINS = [albumArtGeneratorPlugin, moviePosterStudioPlugin, cityPulsePlugin];

export function getStudioPluginById(pluginId) {
  return STUDIO_PLUGINS.find((plugin) => plugin.id === pluginId) || STUDIO_PLUGINS[0] || null;
}

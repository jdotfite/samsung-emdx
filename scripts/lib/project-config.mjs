import path from "node:path";
import { readFile } from "node:fs/promises";
import { loadProjectFromStore } from "../../server/project-store.mjs";

export async function loadProjectConfig(configArg, cwd = process.cwd()) {
  if (!configArg || configArg === "db" || configArg === "--db") {
    return {
      config: loadProjectFromStore(),
      configPath: "sqlite://project-config"
    };
  }

  const configPath = path.isAbsolute(configArg) ? configArg : path.join(cwd, configArg);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  return {
    config,
    configPath
  };
}

export function getEnabledScreens(config) {
  return config.screens.filter((screen) => screen.enabled);
}

export function selectScreens(config, ids) {
  const enabled = getEnabledScreens(config);
  if (!ids.length) {
    return {
      selected: enabled,
      missing: []
    };
  }

  const selected = enabled.filter((screen) => ids.includes(screen.id));
  const missing = ids.filter((id) => !selected.some((screen) => screen.id === id));
  return {
    selected,
    missing
  };
}

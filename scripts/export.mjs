import path from "node:path";
import { startAppServer } from "./server.mjs";
import { renderScreens } from "./lib/render-service.mjs";

const rootDir = process.cwd();
const outputDir = path.join(rootDir, "output");
const configArg = process.argv[2] || "db";

const { config } = await import("./lib/project-config.mjs").then((module) => module.loadProjectConfig(configArg, rootDir));
const screens = config.screens.filter((screen) => screen.enabled);
const server = await startAppServer({ host: "127.0.0.1", port: 0 });

try {
  const results = await renderScreens({
    config,
    screens,
    baseUrl: `http://${server.host}:${server.port}`,
    outputDir
  });

  for (const result of results) {
    console.log(`Exported ${result.screenId} -> ${result.pngPath}`);
    console.log(`Exported ${result.screenId} -> ${result.jpgPath}`);
  }
} finally {
  await server.close();
}

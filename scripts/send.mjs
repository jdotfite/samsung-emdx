import { loadProjectConfig, selectScreens } from "./lib/project-config.mjs";
import { sendScreens } from "./lib/send-service.mjs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const filteredArgs = args.filter((arg) => arg !== "--dry-run");
const looksLikeConfigPath = filteredArgs[0] && (filteredArgs[0] === "db" || filteredArgs[0].includes("/") || filteredArgs[0].includes("\\") || filteredArgs[0].endsWith(".json"));
const configArg = looksLikeConfigPath ? filteredArgs[0] : "db";
const requestedScreenIds = looksLikeConfigPath ? filteredArgs.slice(1) : filteredArgs;

const { config } = await loadProjectConfig(configArg);
const { selected, missing } = selectScreens(config, requestedScreenIds);

if (missing.length) {
  console.error(`Unknown or disabled screen ids: ${missing.join(", ")}`);
  process.exit(1);
}

if (!selected.length) {
  console.error("No enabled screens matched the request.");
  process.exit(1);
}

const results = await sendScreens({
  screens: selected,
  dryRun
});

for (const result of results) {
  if (dryRun) {
    console.log(`[dry-run] ${result.screenId}`);
    console.log(result.command);
  } else {
    console.log(`Sent ${result.screenId} -> ${result.host}`);
  }
}

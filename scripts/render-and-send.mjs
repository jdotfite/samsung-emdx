import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const looksLikeConfigPath = args[0] && (args[0] === "db" || args[0].includes("/") || args[0].includes("\\") || args[0].endsWith(".json"));
const configArg = looksLikeConfigPath ? args[0] : "db";
const passthroughArgs = looksLikeConfigPath ? args.slice(1) : args;

await runNodeScript("scripts/export.mjs", [configArg]);
await runNodeScript("scripts/send.mjs", [configArg, ...passthroughArgs]);

function runNodeScript(scriptPath, scriptArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...scriptArgs], {
      cwd: process.cwd(),
      stdio: "inherit"
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${scriptPath} exited with code ${code}`));
    });
  });
}

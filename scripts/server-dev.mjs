import { startAppServer } from "./server.mjs";

const server = await startAppServer();
console.log(`Poster wall UI available at http://${server.host}:${server.port}/`);
console.log("Press Ctrl+C to stop.");

process.on("SIGINT", async () => {
  await server.close();
  process.exit(0);
});

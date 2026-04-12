import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.TEST_APP_PORT || 4273);
const TEST_DB_PATH = process.env.TEST_DB_PATH || `./data/poster-wall-test-${Date.now()}.db`;
process.env.TEST_DB_PATH = TEST_DB_PATH;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure"
  },
  webServer: {
    command: "node scripts/server-dev.mjs",
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      APP_PORT: String(PORT),
      DATABASE_PATH: TEST_DB_PATH,
      OUTPUT_DIR: "./tests/fixtures/output"
    }
  },
  globalSetup: "./tests/e2e/global-setup.js",
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" }
    }
  ]
});

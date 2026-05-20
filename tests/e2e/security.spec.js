import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

async function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForHealth(baseUrl) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling while the isolated server starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for isolated test server.");
}

async function withAuthServer(callback, envOverrides = {}) {
  const port = await getAvailablePort();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "poster-auth-test-"));
  await fs.mkdir(path.join(tempDir, "output"), { recursive: true });
  await fs.writeFile(path.join(tempDir, "output", "fixture-portrait.png"), await createTinyPngBuffer());
  const child = spawn(process.execPath, ["scripts/server-dev.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      APP_HOST: "127.0.0.1",
      APP_PORT: String(port),
      APP_AUTH_TOKEN: "test-token",
      DATABASE_PATH: path.join(tempDir, "app.db"),
      OUTPUT_DIR: path.join(tempDir, "output"),
      ...envOverrides
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(baseUrl);
    await callback(baseUrl);
  } finally {
    child.kill("SIGINT");
    await new Promise((resolve) => child.once("exit", resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function createTinyPngBuffer() {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l9DfaQAAAABJRU5ErkJggg==",
    "base64",
  );
}

test.describe("API hardening", () => {
  test("project-controlled names render as text instead of executable HTML", async ({ page, request }) => {
    const originalProject = await (await request.get("/api/project")).json();
    const hostile = `\"><img src=x onerror="window.__posterXss=(window.__posterXss||0)+1">`;
    const hostileProject = {
      ...originalProject,
      rooms: [{ id: "evil-room", name: hostile }],
      walls: [{ id: "evil-wall", roomId: "evil-room", name: hostile }],
      screens: (originalProject.screens || []).map((screen, index) => ({
        ...screen,
        name: index === 0 ? hostile : screen.name,
        roomId: "evil-room",
        roomName: hostile,
        wallId: "evil-wall",
        wallName: hostile,
        wallSlot: index === 0 ? "left" : screen.wallSlot
      })),
      contentLibrary: {
        ...(originalProject.contentLibrary || {}),
        collections: [{ id: "evil-collection", name: hostile, imageNames: ["fixture-portrait.png"] }],
        sets: [{
          id: "evil-set",
          name: hostile,
          wallId: "evil-wall",
          items: [{ imageName: "fixture-portrait.png", position: 1, slot: "left" }]
        }],
        favorites: ["fixture-portrait.png"]
      }
    };

    try {
      const saved = await request.put("/api/project", { data: hostileProject });
      expect(saved.ok()).toBeTruthy();

      await page.addInitScript(() => {
        window.__posterXss = 0;
      });
      await page.goto("/");
      await expect(page.getByRole("heading", { name: "Samsung EMDX" })).toBeVisible();
      await page.getByRole("button", { name: "Content", exact: true }).click();
      await page.getByRole("button", { name: /Manage Wall Layouts/ }).click();
      await page.locator('[data-action="open-content-set-editor"]').first().click();
      await expect(page.locator(".modal-shell--set-editor")).toBeVisible();

      expect(await page.evaluate(() => window.__posterXss)).toBe(0);
      expect(await page.locator("img[onerror]").count()).toBe(0);
    } finally {
      await request.put("/api/project", { data: originalProject });
    }
  });

  test("quick-send progress renders remote and device text without executing HTML", async ({ page, request }) => {
    const originalProject = await (await request.get("/api/project")).json();
    const hostile = `\"><img src=x onerror="window.__posterQuickXss=(window.__posterQuickXss||0)+1">`;
    const hostileProject = {
      ...originalProject,
      screens: (originalProject.screens || []).map((screen, index) => ({
        ...screen,
        enabled: index === 0,
        name: index === 0 ? hostile : screen.name
      }))
    };

    await page.route("**/api/spotify/search/artists**", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify([{ id: "evil-artist", name: hostile }])
      });
    });
    await page.route("**/api/spotify/artists/evil-artist/albums**", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ items: [{ id: "album-1" }], total: 1, hasMore: false })
      });
    });
    await page.route("**/api/import/spotify/album", async (route) => {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ slug: "evil-album" }) });
    });
    await page.route("**/api/studio/plugins/album-art/generate", async (route) => {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ generated: [{ name: "fixture-portrait.png" }] }) });
    });
    await page.route("**/api/content/send", async (route) => {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ jobId: "job-1" }) });
    });
    await page.route("**/api/send-jobs/job-1", async (route) => {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "completed", targets: [] }) });
    });

    try {
      const saved = await request.put("/api/project", { data: hostileProject });
      expect(saved.ok()).toBeTruthy();

      await page.addInitScript(() => {
        window.__posterQuickXss = 0;
      });
      await page.goto("/");
      await page.getByRole("button", { name: "Studio" }).click();
      await page.locator('[data-action="open-studio-plugin"][data-plugin-id="album-art-generator"]').click();
      await page.getByRole("button", { name: "Quick Send" }).click();
      await page.locator("#quick-send-artist-query").fill("evil");
      await page.locator('[data-action="album-art-quick-run"]').click();
      await expect(page.locator(".quick-send-result")).toBeVisible();

      expect(await page.evaluate(() => window.__posterQuickXss)).toBe(0);
      expect(await page.locator("img[onerror]").count()).toBe(0);
    } finally {
      await request.put("/api/project", { data: originalProject });
    }
  });

  test("quick-send partial failures report the frames that actually succeeded", async ({ page, request }) => {
    const originalProject = await (await request.get("/api/project")).json();
    expect((originalProject.screens || []).length).toBeGreaterThanOrEqual(2);
    const failedFrameName = "Failed Frame";
    const successfulFrameName = "Successful Frame";
    const testProject = {
      ...originalProject,
      screens: (originalProject.screens || []).map((screen, index) => ({
        ...screen,
        enabled: index < 2,
        name: index === 0 ? failedFrameName : index === 1 ? successfulFrameName : screen.name
      }))
    };

    await page.route("**/api/spotify/search/artists**", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify([{ id: "artist-1", name: "Test Artist" }])
      });
    });
    await page.route("**/api/spotify/artists/artist-1/albums**", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          items: [{ id: "album-1" }, { id: "album-2" }],
          total: 2,
          hasMore: false
        })
      });
    });
    await page.route("**/api/import/spotify/album", async (route) => {
      const payload = route.request().postDataJSON();
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ slug: payload.albumId }) });
    });
    await page.route("**/api/studio/plugins/album-art/generate", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ generated: [{ name: "first-poster.png" }, { name: "second-poster.png" }] })
      });
    });
    await page.route("**/api/content/send", async (route) => {
      const payload = route.request().postDataJSON();
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ jobId: payload.imageName === "first-poster.png" ? "job-failed" : "job-success" })
      });
    });
    await page.route("**/api/send-jobs/job-failed", async (route) => {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "failed", error: "Frame offline", targets: [] }) });
    });
    await page.route("**/api/send-jobs/job-success", async (route) => {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "completed", targets: [] }) });
    });

    try {
      const saved = await request.put("/api/project", { data: testProject });
      expect(saved.ok()).toBeTruthy();

      await page.goto("/");
      await page.getByRole("button", { name: "Studio" }).click();
      await page.locator('[data-action="open-studio-plugin"][data-plugin-id="album-art-generator"]').click();
      await page.getByRole("button", { name: "Quick Send" }).click();
      await page.locator("#quick-send-artist-query").fill("Test Artist");
      await page.locator('[data-action="album-art-quick-run"]').click();

      await expect(page.locator(".quick-send-result")).toBeVisible();
      const deliveryStep = page.locator(".quick-step", { hasText: "Send to frames" });
      await expect(deliveryStep).toContainText(successfulFrameName);
      await expect(deliveryStep).not.toContainText(failedFrameName);
      await expect(page.locator(".quick-send-result")).toContainText("1 of 2 posters delivered");
    } finally {
      await request.put("/api/project", { data: originalProject });
    }
  });

  test("Spotify settings response does not expose the saved client secret", async ({ request }) => {
    const saved = await request.put("/api/studio/plugins/album-art/settings", {
      data: {
        clientId: "test-client-id",
        clientSecret: "super-secret-value",
        market: "US",
      },
    });
    expect(saved.ok()).toBeTruthy();

    const response = await request.get("/api/studio/plugins/album-art/settings");
    expect(response.ok()).toBeTruthy();
    const settings = await response.json();
    expect(settings.configured).toBe(true);
    expect(settings.clientId).toBe("test-client-id");
    expect(settings.clientSecret).toBeUndefined();
    expect(JSON.stringify(settings)).not.toContain("super-secret-value");
  });

  test("data directory is not exposed as a static route", async ({ request }) => {
    const response = await request.get("/data/project.json");
    expect(response.status()).toBe(404);
    expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  });

  test("image upload validates file bytes, not only the declared content type", async ({ request }) => {
    const invalid = await request.post("/api/output-images/upload", {
      headers: {
        "Content-Type": "image/png",
        "X-Filename": "not-really-an-image.png",
      },
      data: Buffer.from("not image bytes"),
    });
    expect(invalid.status()).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ error: expect.stringMatching(/invalid|unsupported/i) });

    const mismatch = await request.post("/api/output-images/upload", {
      headers: {
        "Content-Type": "image/webp",
        "X-Filename": "not-really-webp.webp",
      },
      data: await createTinyPngBuffer(),
    });
    expect(mismatch.status()).toBe(400);
    await expect(mismatch.json()).resolves.toMatchObject({ error: expect.stringMatching(/match.*content type/i) });

    const valid = await request.post("/api/output-images/upload", {
      headers: {
        "Content-Type": "image/png",
        "X-Filename": "tiny-valid.png",
      },
      data: await createTinyPngBuffer(),
    });
    expect(valid.ok()).toBeTruthy();
    const payload = await valid.json();
    expect(payload.image.name).toMatch(/tiny-valid\.png$/);

    await request.post("/api/output-images/delete", {
      data: { names: [payload.image.name] },
    });
  });

  test("failed due schedules are marked once and do not requeue every poll", async () => {
    await withAuthServer(async (baseUrl) => {
      const headers = { Authorization: "Bearer test-token", "Content-Type": "application/json" };
      const runAt = new Date(Date.now() - 2000).toISOString();
      const created = await fetch(`${baseUrl}/api/content/schedules`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "Failing one-time send",
          kind: "image",
          recurrence: "once",
          enabled: true,
          imageName: "fixture-portrait.png",
          screenIds: ["living-room-1"],
          runAt
        })
      });
      expect(created.ok).toBeTruthy();
      const schedule = await created.json();

      const waitForStatus = async (status) => {
        const deadline = Date.now() + 18000;
        while (Date.now() < deadline) {
          const response = await fetch(`${baseUrl}/api/content/schedules`, { headers });
          const schedules = await response.json();
          const current = schedules.find((entry) => entry.id === schedule.id);
          if (current?.lastStatus === status) {
            return current;
          }
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        throw new Error(`Timed out waiting for schedule status ${status}`);
      };

      const failed = await waitForStatus("failed");
      const failedJobId = failed.lastJobId;
      expect(failedJobId).toBeTruthy();

      await new Promise((resolve) => setTimeout(resolve, 900));

      const response = await fetch(`${baseUrl}/api/content/schedules`, { headers });
      const schedules = await response.json();
      const after = schedules.find((entry) => entry.id === schedule.id);
      expect(after.lastStatus).toBe("failed");
      expect(after.lastJobId).toBe(failedJobId);
    }, { CONTENT_SCHEDULE_POLL_MS: "200" });
  });

  test("APP_AUTH_TOKEN protects APIs and the browser can submit the token", async ({ page }) => {
    await withAuthServer(async (baseUrl) => {
      const unauthorized = await fetch(`${baseUrl}/api/project`);
      expect(unauthorized.status).toBe(401);

      const authorized = await fetch(`${baseUrl}/api/project`, {
        headers: { Authorization: "Bearer test-token" }
      });
      expect(authorized.ok).toBeTruthy();

      await page.goto(baseUrl);
      await expect(page.getByText("Authentication required")).toBeVisible();
      await page.locator("#app-auth-token").fill("test-token");
      await page.locator("#save-app-auth-token").click();
      await expect(page.getByRole("heading", { name: "Samsung EMDX" })).toBeVisible();
    });
  });
});

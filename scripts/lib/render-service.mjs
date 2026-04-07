import path from "node:path";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

export async function renderScreens({
  config,
  screens,
  baseUrl,
  outputDir = path.join(process.cwd(), "output"),
  includeJpg = true
}) {
  const encodedState = Buffer.from(JSON.stringify(config), "utf8").toString("base64url");
  await mkdir(outputDir, { recursive: true });

  const browser = await chromium.launch();
  const results = [];

  try {
    for (const screen of screens) {
      const context = await browser.newContext({
        viewport: { width: screen.size.width, height: screen.size.height },
        deviceScaleFactor: 1,
        colorScheme: "light"
      });

      try {
        const page = await context.newPage();
        const url = `${baseUrl}/?view=render&screen=${encodeURIComponent(screen.id)}&state=${encodedState}`;
        await page.goto(url, { waitUntil: "networkidle" });
        await page.evaluate(async () => {
          if (document.fonts?.ready) {
            await document.fonts.ready;
          }
        });

        const poster = page.locator(".poster");
        const outputBaseName = screen.outputBaseName || screen.id;
        const pngPath = path.join(outputDir, `${outputBaseName}.png`);
        const jpgPath = includeJpg ? path.join(outputDir, `${outputBaseName}.jpg`) : null;

        await poster.screenshot({ path: pngPath, type: "png" });
        if (includeJpg && jpgPath) {
          await poster.screenshot({ path: jpgPath, type: "jpeg", quality: 92 });
        }

        results.push({
          screenId: screen.id,
          outputBaseName,
          pngPath,
          jpgPath,
          width: screen.size.width,
          height: screen.size.height
        });

        await page.close();
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }

  return results;
}

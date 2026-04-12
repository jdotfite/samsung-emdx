import { test, expect } from "@playwright/test";

async function goToContent(page) {
  await page.goto("/");
  await page.waitForSelector(".section-tab", { state: "visible" });
  await page.locator('.section-tab[data-section="content"]').click();
  await page.waitForSelector(".output-card", { state: "visible" });
}

test.describe("Content library", () => {
  test("lists seeded fixture images with dimensions", async ({ page }) => {
    await goToContent(page);
    const cards = page.locator(".output-card");
    await expect(cards).toHaveCount(2);
    const dimensionsText = await cards.first().locator(".output-card-copy span").first().innerText();
    expect(dimensionsText).toMatch(/\d+×\d+/);
    expect(dimensionsText.toLowerCase()).toMatch(/portrait|landscape/);
  });

  test("clicking a card opens the preview modal", async ({ page }) => {
    await goToContent(page);
    await page.locator(".output-card-preview").first().click();
    await expect(page.locator(".modal-shell--preview")).toBeVisible();
    await expect(page.locator(".modal-shell--preview h2")).toContainText(/fixture-/);
    await page.locator('.modal-shell--preview [data-action="close-content-preview"]').first().click();
    await expect(page.locator(".modal-shell--preview")).toHaveCount(0);
  });

  test("fit-check warning surfaces on mismatched orientation", async ({ page }) => {
    await goToContent(page);
    const warnChip = page.locator(".output-card", { hasText: "fixture-landscape" }).locator(".content-meta-chip--warn");
    await expect(warnChip).toBeVisible();
    await expect(warnChip).toContainText(/orientation|aspect/i);
  });

  test("edit recipe round-trips through save and reset", async ({ page }) => {
    await goToContent(page);
    const portraitCard = page.locator(".output-card", { hasText: "fixture-portrait" });
    await portraitCard.locator('[data-action="open-content-edit"]').click();

    await expect(page.locator(".modal-shell--edit")).toBeVisible();
    const brightness = page.locator('input[name="brightness"]');
    await brightness.fill("1.3");
    await page.locator('input[name="grayscale"]').check();
    await page.locator('[data-action="save-content-edit"]').click();

    await expect(page.locator(".modal-shell--edit")).toHaveCount(0);
    await expect(portraitCard.locator(".content-meta-chip--edited")).toBeVisible();

    await page.locator(".output-card", { hasText: "fixture-portrait" }).locator(".output-card-preview").click();
    await expect(page.locator(".modal-shell--preview")).toBeVisible();
    await page.locator('[data-action="reset-content-edit"]').click();
    await expect(page.locator(".output-card", { hasText: "fixture-portrait" }).locator(".content-meta-chip--edited")).toHaveCount(0);
  });

  test("search filters cards by filename", async ({ page }) => {
    await goToContent(page);
    const cards = page.locator(".output-card");
    await expect(cards).toHaveCount(2);

    const searchInput = page.locator("#content-library-search");
    await searchInput.fill("portrait");
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText("fixture-portrait");

    await page.locator('[data-action="clear-content-library-search"]').click();
    await expect(page.locator(".output-card")).toHaveCount(2);
  });

  test("sort control reorders the grid", async ({ page }) => {
    await goToContent(page);
    await page.locator("#content-library-sort").selectOption("name-asc");
    const names = await page.locator(".output-card strong").allInnerTexts();
    expect(names[0]).toContain("fixture-landscape");
    expect(names[1]).toContain("fixture-portrait");

    await page.locator("#content-library-sort").selectOption("name-desc");
    const namesDesc = await page.locator(".output-card strong").allInnerTexts();
    expect(namesDesc[0]).toContain("fixture-portrait");
    expect(namesDesc[1]).toContain("fixture-landscape");
  });

  test("manage mode creates an ordered set from selection", async ({ page }) => {
    await goToContent(page);
    await page.locator('[data-action="toggle-content-manage"]').click();
    await expect(page.locator(".content-library-panel--manage")).toBeVisible();

    await page.locator(".output-card", { hasText: "fixture-portrait" }).locator(".output-card-preview").click();
    await page.locator(".output-card", { hasText: "fixture-landscape" }).locator(".output-card-preview").click();

    await page.locator("#content-set-name").fill("Test Triptych");
    await page.locator('[data-action="create-content-set"]').click();

    await page.locator('[data-action="toggle-content-manage"]').click();

    const setCard = page.locator(".content-set-card", { hasText: "Test Triptych" });
    await expect(setCard).toBeVisible();
    await expect(setCard.locator(".content-set-position-badge")).toHaveCount(2);
    await expect(setCard.locator(".content-set-position-badge").first()).toContainText("1");
    await expect(setCard.locator(".content-set-position-badge").nth(1)).toContainText("2");
  });

  test("manage mode creates and assigns a collection", async ({ page }) => {
    await goToContent(page);
    await page.locator('[data-action="toggle-content-manage"]').click();
    await expect(page.locator(".content-library-panel--manage")).toBeVisible();

    await page.locator(".output-card", { hasText: "fixture-portrait" }).locator(".output-card-preview").click();
    await expect(page.locator(".output-card.is-selected", { hasText: "fixture-portrait" })).toBeVisible();

    await page.locator("#content-collection-name").fill("Test Set");
    await page.locator('[data-action="create-content-collection"]').click();

    const chip = page.locator(".content-filter-chip", { hasText: "Test Set" });
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("1");
  });
});

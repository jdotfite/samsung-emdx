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

  test("clicking a card selects it and the zoom action opens preview", async ({ page }) => {
    await goToContent(page);
    const firstCard = page.locator(".output-card").first();

    await firstCard.locator(".output-card-preview").click();
    await expect(firstCard).toHaveClass(/is-selected/);
    await expect(page.locator(".modal-shell--preview")).toHaveCount(0);

    await firstCard.locator('[data-action="open-content-preview"]').click();
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

    await page.locator(".output-card", { hasText: "fixture-portrait" }).locator('[data-action="open-content-preview"]').click();
    await expect(page.locator(".modal-shell--preview")).toBeVisible();
    await expect(page.locator(".modal-shell--preview .content-preview-frame img")).toHaveAttribute("src", /\/api\/content\/items\/.*\/preview\?/);
    await page.locator('[data-action="reset-content-edit"]').click();
    await expect(page.locator(".output-card", { hasText: "fixture-portrait" }).locator(".content-meta-chip--edited")).toHaveCount(0);
  });

  test("canceling dirty edits uses the in-app discard prompt", async ({ page }) => {
    await goToContent(page);
    await page.locator(".output-card", { hasText: "fixture-portrait" }).locator('[data-action="open-content-edit"]').click();

    await expect(page.locator(".modal-shell--edit")).toBeVisible();
    await page.locator('input[name="brightness"]').fill("1.25");
    await page.locator(".modal-shell--edit").getByRole("button", { name: "Cancel" }).click();

    await expect(page.locator(".content-edit-discard")).toBeVisible();
    await expect(page.locator(".content-edit-discard")).toContainText("Discard unsaved edits?");
    await expect(page.locator("#content-edit-preview-frame")).toBeVisible();

    await page.locator('[data-action="dismiss-content-edit-discard"]').click();
    await expect(page.locator(".content-edit-discard")).toHaveCount(0);
    await expect(page.locator(".modal-shell--edit")).toBeVisible();

    await page.locator(".modal-shell--edit").getByRole("button", { name: "Cancel" }).click();
    await page.locator('[data-action="confirm-content-edit-discard"]').click();
    await expect(page.locator(".modal-shell--edit")).toHaveCount(0);
  });

  test("edit modal separates quick fit from manual crop", async ({ page }) => {
    await goToContent(page);
    await page.locator(".output-card", { hasText: "fixture-portrait" }).locator('[data-action="open-content-edit"]').click();

    const editModal = page.locator(".modal-shell--edit");
    await expect(editModal).toBeVisible();
    await expect(editModal.locator("[data-content-edit-mode-label]")).toContainText("Quick fit");
    await expect(editModal.getByRole("button", { name: "Quick fit" })).toBeVisible();
    await expect(editModal.getByRole("button", { name: "Manual crop" })).toBeVisible();
    await expect(editModal.locator('select[name="cropAnchor"]')).toBeVisible();
    await expect(editModal.locator('input[name="zoom"]')).toHaveCount(0);

    await editModal.getByRole("button", { name: "Manual crop" }).click();
    await expect(editModal.locator("[data-content-edit-mode-label]")).toContainText("Manual crop");
    await expect(editModal.locator('input[name="zoom"]')).toBeVisible();
    await expect(editModal.getByRole("button", { name: "Reset framing" })).toBeVisible();
    await expect(editModal.locator('select[name="cropAnchor"]')).toHaveCount(0);
  });

  test("manual crop preview supports drag and wheel framing", async ({ page }) => {
    await goToContent(page);
    await page.locator(".output-card", { hasText: "fixture-portrait" }).locator('[data-action="open-content-edit"]').click();

    const editModal = page.locator(".modal-shell--edit");
    await editModal.getByRole("button", { name: "Manual crop" }).click();

    const frame = page.locator("#content-edit-preview-frame");
    const zoom = editModal.locator('input[name="zoom"]');
    const panX = editModal.locator('input[name="panX"]');
    const panY = editModal.locator('input[name="panY"]');
    const startZoom = Number(await zoom.inputValue());
    const box = await frame.boundingBox();
    expect(box).toBeTruthy();

    await page.mouse.move(box.x + (box.width / 2), box.y + (box.height / 2));
    await page.mouse.wheel(0, -120);
    await expect.poll(async () => Number(await zoom.inputValue())).toBeGreaterThan(startZoom);

    await page.mouse.down();
    await page.mouse.move(box.x + (box.width / 2) + 40, box.y + (box.height / 2) + 20);
    await page.mouse.up();

    await expect.poll(async () => {
      const nextPanX = Math.abs(Number(await panX.inputValue()));
      const nextPanY = Math.abs(Number(await panY.inputValue()));
      return nextPanX + nextPanY;
    }).toBeGreaterThan(0);
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
    const setEditor = page.locator(".modal-shell--set-editor");
    await expect(setEditor).toBeVisible();
    await expect(setEditor.locator("h2")).toContainText("Test Triptych");
    await expect(page.locator("#content-set-editor-wall")).toHaveValue("living-room-living-room-wall");
    await expect(page.locator('[data-set-slot-input]').first()).toHaveValue("left");
    await setEditor.getByRole("button", { name: "Close", exact: true }).click();

    const setCard = page.locator(".content-set-card", { hasText: "Test Triptych" });
    await expect(setCard).toBeVisible();
    await expect(setCard.locator(".content-set-position-badge")).toHaveCount(2);
    await expect(setCard).toContainText("Living Room / Living Room Wall");
    await expect(setCard.locator(".content-set-position-badge").first()).toContainText("Left");
    await expect(setCard.locator(".content-set-position-badge").nth(1)).toContainText("Right");
  });

  test("browse mode keeps wall layouts behind the manage entry point", async ({ page }) => {
    await goToContent(page);
    await page.locator('[data-action="toggle-content-manage"]').click();
    await page.locator(".output-card", { hasText: "fixture-portrait" }).locator(".output-card-preview").click();
    await page.locator(".output-card", { hasText: "fixture-landscape" }).locator(".output-card-preview").click();
    await page.locator("#content-set-name").fill("Browse Hint Layout");
    await page.locator('[data-action="create-content-set"]').click();
    await page.locator(".modal-shell--set-editor").getByRole("button", { name: "Close", exact: true }).click();

    await page.locator('[data-action="toggle-content-manage"]').click();
    await expect(page.locator(".content-set-card", { hasText: "Browse Hint Layout" })).toHaveCount(0);
    await expect(page.locator(".content-library-panel--browse-summary")).toBeVisible();
    await expect(page.getByRole("button", { name: "Manage Wall Layouts" })).toBeVisible();
  });

  test("favorite toggle persists and filters", async ({ page }) => {
    await goToContent(page);

    const portraitCard = page.locator(".output-card", { hasText: "fixture-portrait" });
    await expect(portraitCard.locator(".content-meta-chip--favorite")).toHaveCount(0);

    await portraitCard.locator('[data-action="toggle-content-favorite"]').click();
    await expect(portraitCard.locator(".content-meta-chip--favorite")).toBeVisible();

    const favChip = page.locator(".content-library-toolbar-filter-chip");
    await expect(favChip).toBeVisible();
    await expect(favChip).toContainText("1");
    await favChip.click();

    await expect(page.locator(".output-card")).toHaveCount(1);
    await expect(page.locator(".output-card").first()).toContainText("fixture-portrait");

    await page.locator('[data-action="reset-content-library-filters"]').click();
    await expect(page.locator(".output-card")).toHaveCount(2);

    await portraitCard.locator('[data-action="toggle-content-favorite"]').click();
    await expect(portraitCard.locator(".content-meta-chip--favorite")).toHaveCount(0);
  });

  test("edit modal shows Color and Levels fieldsets", async ({ page }) => {
    await goToContent(page);
    await page.locator(".output-card", { hasText: "fixture-portrait" }).locator('[data-action="open-content-edit"]').click();
    const modal = page.locator(".modal-shell--edit");
    await expect(modal).toBeVisible();
    await expect(modal.locator("legend", { hasText: "Color" })).toBeVisible();
    await expect(modal.locator("legend", { hasText: "Levels" })).toBeVisible();
    await expect(modal.locator("legend", { hasText: "Detail" })).toBeVisible();
    await expect(modal.locator('input[name="vibrance"]')).toBeVisible();
    await modal.getByRole("button", { name: "Cancel" }).click();
    await expect(modal).toHaveCount(0);
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

  test("browse mode schedules a poster for the selected frames", async ({ page }) => {
    await goToContent(page);

    await page.locator('.broadcast-chip:has-text("Living Room 1")').click();
    await page.locator(".output-card", { hasText: "fixture-portrait" }).locator(".output-card-copy").click();
    await page.locator('[data-action="open-selected-content-schedule"]').click();

    const scheduleModal = page.locator('[aria-label="Create schedule"]');
    await expect(scheduleModal).toBeVisible();
    await expect(scheduleModal.locator("#content-schedule-name")).toHaveValue("fixture-portrait.png");
    await scheduleModal.getByRole("button", { name: "Create Schedule" }).click();

    await expect(page.locator('[aria-label="Create schedule"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Manage Schedules" })).toBeVisible();

    await page.getByRole("button", { name: "Manage Schedules" }).click();
    const scheduleCard = page.locator(".content-schedule-card", { hasText: "fixture-portrait.png" });
    await expect(scheduleCard).toBeVisible();
    await expect(scheduleCard).toContainText("Poster");
    await expect(scheduleCard).toContainText("Living Room 1");
  });

  test("manage mode schedules an ordered wall layout and can pause it", async ({ page }) => {
    await goToContent(page);
    await page.locator('[data-action="toggle-content-manage"]').click();

    await page.locator(".output-card", { hasText: "fixture-portrait" }).locator(".output-card-preview").click();
    await page.locator(".output-card", { hasText: "fixture-landscape" }).locator(".output-card-preview").click();
    await page.locator("#content-set-name").fill("Scheduled Layout");
    await page.locator('[data-action="create-content-set"]').click();

    const setEditor = page.locator(".modal-shell--set-editor");
    await expect(setEditor).toBeVisible();
    await setEditor.locator('[data-action="open-content-set-schedule"]').click();

    const scheduleModal = page.locator('[aria-label="Create schedule"]');
    await expect(scheduleModal).toBeVisible();
    await expect(scheduleModal.locator("#content-schedule-name")).toHaveValue("Scheduled Layout");
    await scheduleModal.getByRole("button", { name: "Create Schedule" }).click();

    const scheduleCard = page.locator(".content-schedule-card", { hasText: "Scheduled Layout" });
    await expect(scheduleCard).toBeVisible();
    await expect(scheduleCard).toContainText("Wall layout");

    await scheduleCard.getByRole("button", { name: "Pause" }).click();
    await expect(scheduleCard).toContainText("Paused");

    await scheduleCard.getByRole("button", { name: "Resume" }).click();
    await expect(scheduleCard).toContainText("Active");
  });
});

import { expect, test, type Page } from "@playwright/test";

const PASSWORD = "correct horse battery";

/** The read-only hook the map exposes for tests (apps/client/src/map/CityScene.ts). */
interface MapHook {
  mode(): "districts" | "territories";
  relativeZoom(): number;
  selected(): string | null;
  steps(): number;
  markerScreenPosition(slug: string): { x: number; y: number };
}

declare global {
  interface Window {
    __lagosMap?: MapHook;
  }
}
const run = Date.now().toString(36).slice(-5);




async function registerAndWaitForMap(page: Page, handle: string) {
  await page.goto("/");
  await page.getByRole("button", { name: "Register" }).click();
  await page.getByLabel("Email").fill(`${handle}@example.test`);
  await page.getByLabel("Handle").fill(handle);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByTestId("handle")).toHaveText(handle);
  await page.waitForFunction(() => window.__lagosMap !== undefined);
}

test("the map opens at city view; jumping to a district shows territory markers; clicking one opens its panel", async ({ page }) => {
  await registerAndWaitForMap(page, `map_${run}`);
  expect(await page.evaluate(() => window.__lagosMap!.mode())).toBe("districts");
  await page.screenshot({ path: "test-results/e2e/map-city.png" });

  await page.getByRole("button", { name: "Districts" }).click();
  await page.getByRole("button", { name: "Lagos Island" }).click();
  await expect.poll(() => page.evaluate(() => window.__lagosMap!.mode())).toBe("territories");
  await page.waitForTimeout(800); // camera pan/zoom animation

  const pos = await page.evaluate(() => window.__lagosMap!.markerScreenPosition("balogun"));
  expect(pos).not.toBeNull();
  await page.mouse.click(pos.x, pos.y);
  const panel = page.getByTestId("territory-panel");
  await expect(panel.getByRole("heading", { name: "Balogun Market" })).toBeVisible();
  await expect(panel).toContainText("Lagos Island");
  await expect(page.getByTestId("territory-owner")).toHaveText("Neutral");
  await expect(page).toHaveURL(/#t=balogun$/);
  await page.waitForTimeout(400);
  await page.screenshot({ path: "test-results/e2e/map-district.png" });

  await panel.getByRole("button", { name: "Close" }).click();
  await expect(panel).toHaveCount(0);
  expect(await page.evaluate(() => window.__lagosMap!.selected())).toBeNull();
});

test("the wheel zooms in around the pointer; dragging then pans without selecting", async ({ page }) => {
  await registerAndWaitForMap(page, `pan_${run}`);
  const z0 = await page.evaluate(() => window.__lagosMap!.relativeZoom());
  await page.mouse.move(640, 360);
  for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -200);
  await expect.poll(() => page.evaluate(() => window.__lagosMap!.relativeZoom())).toBeGreaterThan(z0 * 1.5);
  await page.waitForTimeout(300);

  // At city zoom the whole map fits, so there is nothing to pan; zoomed in, a drag moves the map with the pointer.
  const before = await page.evaluate(() => window.__lagosMap!.markerScreenPosition("idumota"));
  await page.mouse.move(700, 400);
  await page.mouse.down();
  await page.mouse.move(600, 350, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  const after = await page.evaluate(() => window.__lagosMap!.markerScreenPosition("idumota"));
  expect(Math.round(after.x - before.x)).toBe(-100);
  expect(Math.round(after.y - before.y)).toBe(-50);
  await expect(page.getByTestId("territory-panel")).toHaveCount(0);

  // Once idle, the map throttles to ~12 updates a second, and never runs more than one game loop.
  await page.waitForTimeout(2500);
  const s0 = await page.evaluate(() => window.__lagosMap!.steps());
  await page.waitForTimeout(2000);
  const idleRate = ((await page.evaluate(() => window.__lagosMap!.steps())) - s0) / 2;
  expect(idleRate).toBeGreaterThan(3);
  expect(idleRate).toBeLessThanOrEqual(14);
});

test("a #t= link opens the map focused on that territory", async ({ page }) => {
  await registerAndWaitForMap(page, `link_${run}`);
  await page.goto("/#t=apapa-wharf");
  await page.waitForFunction(() => window.__lagosMap?.selected() === "apapa-wharf");
  await expect(page.getByTestId("territory-panel").getByRole("heading", { name: "Apapa Wharf" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__lagosMap!.mode())).toBe("territories");
});

test("marker filters hide a kind of territory", async ({ page }) => {
  await registerAndWaitForMap(page, `filter_${run}`);
  await page.getByRole("button", { name: "Districts" }).click();
  await page.getByRole("button", { name: "Apapa" }).click();
  await expect.poll(() => page.evaluate(() => window.__lagosMap!.mode())).toBe("territories");
  await page.getByLabel("Logistics").uncheck();
  await page.waitForTimeout(800);
  // With logistics markers hidden, clicking where the wharf marker was selects the ground (still the wharf).
  const pos = await page.evaluate(() => window.__lagosMap!.markerScreenPosition("apapa-wharf"));
  await page.mouse.click(pos.x, pos.y);
  await expect(page.getByTestId("territory-panel").getByRole("heading", { name: "Apapa Wharf" })).toBeVisible();
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("panels become bottom sheets and the map stays usable", async ({ page }) => {
    await registerAndWaitForMap(page, `phone_${run}`);
    await page.screenshot({ path: "test-results/e2e/map-phone-city.png" });
    await page.getByRole("button", { name: "Districts" }).click();
    await page.getByRole("button", { name: "Yaba & Ebute Metta" }).click();
    await expect.poll(() => page.evaluate(() => window.__lagosMap!.mode())).toBe("territories");
    await page.waitForTimeout(800);
    const pos = await page.evaluate(() => window.__lagosMap!.markerScreenPosition("sabo"));
    await page.touchscreen.tap(pos.x, pos.y);
    const panel = page.getByTestId("territory-panel");
    await expect(panel.getByRole("heading", { name: "Sabo" })).toBeVisible();
    const box = (await panel.boundingBox())!;
    expect(box.y + box.height).toBeCloseTo(844, -1);
    await page.screenshot({ path: "test-results/e2e/map-phone-territory.png" });
  });
});

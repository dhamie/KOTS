import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";

const PASSWORD = "correct horse battery";
const run = Date.now().toString(36).slice(-5);
const bell = (page: import("@playwright/test").Page) => page.getByRole("button", { name: /^Notifications, / });

test("an operator triggers a street festival: the news, the treasury, the history and the territory update without a reload", async ({ page }) => {
  // The worker's event sweep runs once a minute.
  test.setTimeout(240_000);
  const handle = `fest_${run}`;
  const name = `Isale Crew ${run}`;
  await page.goto("/");
  await page.getByRole("button", { name: "Register" }).click();
  await page.getByLabel("Email").fill(`${handle}@example.test`);
  await page.getByLabel("Handle").fill(handle);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForFunction(() => "__lagosMap" in window);
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Tag").fill("ISLE");
  await page.getByRole("button", { name: "Create family" }).click();
  await expect(page.getByTestId("treasury-balance")).toHaveText("₦20,000");

  await page.evaluate(() => (window.location.hash = "#t=isale-eko"));
  const panel = page.getByTestId("territory-panel");
  await expect(panel.getByRole("heading", { name: "Isale Eko" })).toBeVisible();
  await panel.getByRole("button", { name: "Claim for ₦250" }).click();
  await expect(page.getByTestId("treasury-balance")).toHaveText("₦19,750");
  await expect(page.getByTestId("territory-event")).toHaveCount(0);

  // The news is open and quiet before the event.
  await page.getByRole("button", { name: "Districts" }).click();
  const districts = page.getByRole("region", { name: "Districts" });
  await expect(districts).toContainText("All quiet.");

  const out = execFileSync("node", ["apps/server/dist/event.cjs", "street_festival", "lagos-island"], {
    env: { ...process.env, DATABASE_URL: process.env.E2E_DATABASE_URL },
    encoding: "utf8",
  });
  expect(out).toContain("Scheduled street_festival in lagos-island");

  // Within a minute or so the worker starts it and every view catches up live.
  const news = page.getByTestId("news");
  await expect(news).toContainText("Street festival in Lagos Island", { timeout: 120_000 });
  await expect(news).toContainText("Now · until");
  await expect(page.getByTestId("territory-event")).toContainText("Street festival in Lagos Island");
  await expect(bell(page)).toHaveAccessibleName("Notifications, 1 unread");

  await page.getByRole("button", { name: "Family", exact: true }).click();
  await expect(page.getByTestId("treasury-balance")).toHaveText("₦20,350");
  await expect(page.getByText("A street festival in Lagos Island paid ₦600 (one territory)")).toBeVisible();
});

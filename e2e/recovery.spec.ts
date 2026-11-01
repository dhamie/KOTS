import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";

const PASSWORD = "correct horse battery";
const run = Date.now().toString(36).slice(-5);
const bell = (page: import("@playwright/test").Page) => page.getByRole("button", { name: /^Notifications, / });

test("the api restarts under an open page: it shows it's reconnecting, then carries on live without a reload", async ({ page }) => {
  test.setTimeout(120_000);
  const handle = `restart_${run}`;
  await page.goto("/");
  await page.getByRole("button", { name: "Register" }).click();
  await page.getByLabel("Email").fill(`${handle}@example.test`);
  await page.getByLabel("Handle").fill(handle);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForFunction(() => "__lagosMap" in window);
  await page.getByLabel("Name").fill(`Restart Crew ${run}`);
  await page.getByLabel("Tag").fill(`R${run.slice(0, 4).toUpperCase()}`);
  await page.getByRole("button", { name: "Create family" }).click();
  await expect(page.getByTestId("treasury-balance")).toHaveText("₦20,000");
  const notice = page.getByRole("status").filter({ hasText: "Reconnecting" });
  await expect(notice).toHaveCount(0);

  // e2e/run.sh restarts the api when this file appears (it stays down for a few seconds).
  writeFileSync("test-results/restart-api", "");
  await expect(notice).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => existsSync("test-results/restart-api"), { timeout: 20_000 }).toBe(false);
  await expect(notice).toHaveCount(0, { timeout: 30_000 });
  // Still signed in, on the same page.
  await expect(page.getByTestId("treasury-balance")).toHaveText("₦20,000");

  // A change made elsewhere reaches the page live again: the new api process delivers it.
  const tag = `R${run.slice(0, 4).toUpperCase()}`;
  const out = execFileSync("node", ["apps/server/dist/admin.cjs", "adjust", tag, "500", "after the restart"], {
    env: { ...process.env, DATABASE_URL: process.env.E2E_DATABASE_URL },
    encoding: "utf8",
  });
  expect(out).toContain("treasury holds ₦20,500");
  await expect(bell(page)).toHaveAccessibleName("Notifications, 1 unread");
  await expect(page.getByTestId("treasury-balance")).toHaveText("₦20,500");
});

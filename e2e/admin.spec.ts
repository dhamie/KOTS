import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";

const PASSWORD = "correct horse battery";
const run = Date.now().toString(36).slice(-5);
const admin = (...args: string[]) =>
  execFileSync("node", ["apps/server/dist/admin.cjs", ...args], { env: { ...process.env, DATABASE_URL: process.env.E2E_DATABASE_URL }, encoding: "utf8" });

test("an operator bans a signed-in player: their open page returns to the login screen, which refuses them until unbanned", async ({ page }) => {
  const handle = `banned_${run}`;
  await page.goto("/");
  await page.getByRole("button", { name: "Register" }).click();
  await page.getByLabel("Email").fill(`${handle}@example.test`);
  await page.getByLabel("Handle").fill(handle);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForFunction(() => "__lagosMap" in window);
  const account = page.getByRole("region", { name: "Account" });
  await expect(account).toHaveCount(0);

  expect(admin("ban", handle, "test ban")).toContain(`${handle} is banned; 1 session ended.`);

  // No reload: the server drops the live connection and the page finds the session gone.
  await expect(account).toBeVisible();
  const logIn = async () => {
    await account.getByLabel("Email").fill(`${handle}@example.test`);
    await account.getByLabel("Password").fill(PASSWORD);
    await account.locator("form").getByRole("button", { name: "Log in" }).click();
  };
  await logIn();
  await expect(account.locator(".error")).toHaveText("This account is banned.");

  expect(admin("unban", handle)).toContain(`${handle} can log in again.`);
  await logIn();
  await expect(account).toHaveCount(0);
});

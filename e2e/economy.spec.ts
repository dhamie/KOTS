import { expect, test } from "@playwright/test";

const PASSWORD = "correct horse battery";
const run = Date.now().toString(36).slice(-5);

test("claim a territory from its panel: the owner changes and the treasury pays; a far territory explains why it can't be claimed", async ({ page }) => {
  const handle = `claim_${run}`;
  const name = `Yaba Crew ${run}`;
  await page.goto("/");
  await page.getByRole("button", { name: "Register" }).click();
  await page.getByLabel("Email").fill(`${handle}@example.test`);
  await page.getByLabel("Handle").fill(handle);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForFunction(() => "__lagosMap" in window);

  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Tag").fill("YABA");
  await page.getByRole("button", { name: "Create family" }).click();
  await expect(page.getByTestId("treasury-balance")).toHaveText("₦20,000");

  await page.evaluate(() => (window.location.hash = "#t=tejuosho"));
  const panel = page.getByTestId("territory-panel");
  await expect(panel.getByRole("heading", { name: "Tejuosho Market" })).toBeVisible();
  await expect(panel).toContainText("No fee for your first territory");
  await panel.getByRole("button", { name: "Claim for ₦400" }).click();
  await expect(page.getByTestId("territory-owner")).toHaveText(`${name} [YABA]`);
  await expect(page.getByTestId("paid-until")).toBeVisible();
  await expect(page.getByTestId("treasury-balance")).toHaveText("₦19,600");
  await expect(page.getByTestId("holdings")).toContainText("Tejuosho Market");
  await page.waitForTimeout(600); // camera animation
  await page.screenshot({ path: "test-results/e2e/claim-owned.png" });

  await page.evaluate(() => (window.location.hash = "#t=marina"));
  await expect(panel.getByRole("heading", { name: "Marina" })).toBeVisible();
  await expect(page.getByTestId("claim-refusal")).toContainText("next to land your family holds");
  await expect(panel.getByRole("button", { name: /^Claim for/ })).toBeDisabled();

  await page.evaluate(() => (window.location.hash = "#t=akoka"));
  await expect(panel.getByRole("heading", { name: "Akoka" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Claim for ₦1,220" })).toBeEnabled();
});

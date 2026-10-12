import { expect, test } from "@playwright/test";

const PASSWORD = "correct horse battery";
const run = Date.now().toString(36).slice(-5);

test("hire a henchman from today's board and post them to a territory the family holds", async ({ page }) => {
  const handle = `crew_${run}`;
  await page.goto("/");
  await page.getByRole("button", { name: "Register" }).click();
  await page.getByLabel("Email").fill(`${handle}@example.test`);
  await page.getByLabel("Handle").fill(handle);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForFunction(() => "__lagosMap" in window);
  await page.getByLabel("Name").fill(`Apapa Crew ${run}`);
  await page.getByLabel("Tag").fill("APA");
  await page.getByRole("button", { name: "Create family" }).click();
  await expect(page.getByTestId("treasury-balance")).toHaveText("₦20,000");

  // Hold a territory first, so there's somewhere to post the henchman.
  await page.evaluate(() => (window.location.hash = "#t=ajegunle"));
  await page.getByTestId("territory-panel").getByRole("button", { name: /^Claim for/ }).click();
  await expect(page.getByTestId("territory-owner")).toContainText("Apapa Crew");
  await page.getByTestId("territory-panel").getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: "Henchmen" }).click();
  const candidates = page.getByTestId("candidates").locator("li");
  await expect(candidates).toHaveCount(4);
  const first = candidates.first();
  const name = (await first.locator("strong").textContent())!;
  await first.getByRole("button", { name: /^Hire for/ }).click();
  await expect(first).toContainText("Hired");
  const crew = page.getByTestId("crew");
  await expect(crew).toContainText(name);
  await expect(crew).toContainText("morale 70");

  await page.getByLabel(`Post for ${name}`).selectOption("ajegunle");
  await expect(page.getByLabel(`Post for ${name}`)).toHaveValue("ajegunle");
  await page.screenshot({ path: "test-results/e2e/henchmen.png" });

  // The family panel's treasury reflects both purchases.
  await page.getByRole("button", { name: "Family" }).click();
  await expect(page.getByTestId("treasury-balance")).not.toHaveText("₦19,800");
  await expect(page.getByTestId("activity")).toContainText(`hired ${name}`);
});

import { expect, test } from "@playwright/test";

const PASSWORD = "correct horse battery";
const run = Date.now().toString(36).slice(-5);

test("buy goods at the wharf, sell them on the Island at a profit, and see it in the family's history", async ({ page }) => {
  const handle = `trader_${run}`;
  await page.goto("/");
  await page.getByRole("button", { name: "Register" }).click();
  await page.getByLabel("Email").fill(`${handle}@example.test`);
  await page.getByLabel("Handle").fill(handle);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForFunction(() => "__lagosMap" in window);
  await page.getByLabel("Name").fill(`Wharf Traders ${run}`);
  await page.getByLabel("Tag").fill("WHF");
  await page.getByRole("button", { name: "Create family" }).click();
  await expect(page.getByTestId("treasury-balance")).toHaveText("₦20,000");

  // The wharf's territory panel opens its market.
  await page.evaluate(() => (window.location.hash = "#t=apapa-wharf"));
  await page.getByTestId("territory-panel").getByRole("button", { name: "Open the market" }).click();
  const panel = page.getByTestId("market-panel");
  await expect(panel.getByRole("button", { name: "Apapa Wharf" })).toHaveAttribute("aria-pressed", "true");

  await panel.getByLabel("Good").selectOption("imported_goods");
  await panel.getByLabel("Quantity").fill("20");
  await panel.getByRole("button", { name: /^Buy 20 for/ }).click();
  await expect(page.getByTestId("order-done")).toContainText("Bought 20 imported goods");
  await expect(panel).toContainText("storage 20/50");

  await panel.getByRole("button", { name: "Balogun Market" }).click();
  await panel.getByLabel("Good").selectOption("imported_goods");
  await panel.getByLabel("Quantity").fill("20");
  await panel.getByRole("button", { name: /^Sell 20 for/ }).click();
  await expect(page.getByTestId("order-done")).toContainText("Sold 20 imported goods");
  await expect(panel).toContainText("storage 0/50");
  await page.screenshot({ path: "test-results/e2e/market.png" });

  await page.getByRole("button", { name: "Family" }).click();
  await expect(page.getByTestId("activity")).toContainText("sold 20 imported goods at Balogun Market");
  await expect(page.getByTestId("activity")).toContainText("bought 20 imported goods at Apapa Wharf");
  const balance = Number((await page.getByTestId("treasury-balance").textContent())!.replace(/[^\d]/g, ""));
  expect(balance).toBeGreaterThan(20_000);
});

import { expect, test, type Browser, type Page } from "@playwright/test";
import { Client } from "pg";

const PASSWORD = "correct horse battery";
const run = Date.now().toString(36).slice(-5);

async function founder(browser: Browser, handle: string, family: string, tag: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/");
  await page.getByRole("button", { name: "Register" }).click();
  await page.getByLabel("Email").fill(`${handle}@example.test`);
  await page.getByLabel("Handle").fill(handle);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForFunction(() => "__lagosMap" in window);
  await page.getByLabel("Name").fill(family);
  await page.getByLabel("Tag").fill(tag);
  await page.getByRole("button", { name: "Create family" }).click();
  await expect(page.getByTestId("treasury-balance")).toHaveText("₦20,000");
  return page;
}

/** Families must be 3 days old to trade; the test backdates them directly in the test database. */
async function ageFamilies(tags: string[]): Promise<void> {
  const db = new Client({ connectionString: process.env.E2E_DATABASE_URL });
  await db.connect();
  try {
    await db.query("update families set founded_at = founded_at - interval '4 days' where tag = any($1) and disbanded_at is null", [tags]);
  } finally {
    await db.end();
  }
}

test("one family offers goods for cash, the other accepts, and both see the result", async ({ browser }) => {
  const tagA = `S${run.slice(-4)}`.toUpperCase();
  const tagB = `B${run.slice(-4)}`.toUpperCase();
  const seller = await founder(browser, `seller_${run}`, `Sellers ${run}`, tagA);
  const buyer = await founder(browser, `buyer_${run}`, `Buyers ${run}`, tagB);
  await ageFamilies([tagA, tagB]);

  // The seller stocks up at the market, then offers 5 fuel for ₦1,000.
  await seller.getByRole("button", { name: "Market" }).click();
  const market = seller.getByTestId("market-panel");
  await market.getByLabel("Good").selectOption("fuel");
  await market.getByLabel("Quantity").fill("5");
  await market.getByRole("button", { name: /^Buy 5 for/ }).click();
  await expect(seller.getByTestId("order-done")).toContainText("Bought 5 fuel");

  await seller.getByRole("button", { name: "Trades" }).click();
  await seller.getByLabel("Family tag").fill(tagB);
  await seller.getByLabel("You give item 1", { exact: true }).selectOption("fuel");
  await seller.getByLabel("You give amount 1", { exact: true }).fill("5");
  await seller.getByRole("group", { name: "You want" }).getByRole("button", { name: "+ Add item" }).click();
  await seller.getByLabel("You want amount 1", { exact: true }).fill("1000");
  await seller.getByRole("button", { name: "Send offer" }).click();
  await expect(seller.getByTestId("outgoing")).toContainText(`To Buyers ${run} [${tagB}]`);

  // The buyer finds it under Trades and accepts.
  await buyer.getByRole("button", { name: "Market" }).click();
  await buyer.getByRole("button", { name: "Trades" }).click();
  const incoming = buyer.getByTestId("incoming");
  await expect(incoming).toContainText("You get 5 fuel");
  await expect(incoming).toContainText("You give ₦1,000");
  await incoming.getByRole("button", { name: "Accept" }).click();
  await expect(incoming).not.toContainText("5 fuel");
  await buyer.screenshot({ path: "test-results/e2e/trades.png" });

  await buyer.getByRole("button", { name: "Family" }).click();
  await expect(buyer.getByTestId("treasury-balance")).toHaveText("₦19,000");
  await expect(buyer.getByTestId("inventory")).toContainText("Fuel");
  await expect(buyer.getByTestId("activity")).toContainText(`Traded ₦1,000 for 5 fuel with [${tagA}]`);

  await seller.getByRole("button", { name: "Family" }).click();
  await expect(seller.getByTestId("activity")).toContainText(`Traded 5 fuel for ₦1,000 with [${tagB}]`);
  await expect(seller.getByTestId("storage")).toContainText("Storage 0/50");

  await seller.context().close();
  await buyer.context().close();
});

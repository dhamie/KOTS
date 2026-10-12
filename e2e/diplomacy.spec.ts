import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { Client } from "pg";

const PASSWORD = "correct horse battery";
const run = Date.now().toString(36).slice(-5);

// Closed even when the test fails: a leftover context keeps its map rendering and slows every later test.
const contexts: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close();
});

async function founder(browser: Browser, handle: string, family: string, tag: string): Promise<Page> {
  const context = await browser.newContext();
  contexts.push(context);
  const page = await context.newPage();
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

test("two families agree a territory transfer in a diplomacy room; both see it without reloading", async ({ browser }) => {
  const tagA = `G${run.slice(-4)}`.toUpperCase();
  const tagB = `H${run.slice(-4)}`.toUpperCase();
  const giver = await founder(browser, `giver_${run}`, `Givers ${run}`, tagA);
  const taker = await founder(browser, `taker_${run}`, `Takers ${run}`, tagB);

  // Agreements need families 3 days old: backdate both in the test database. The giver claims a territory first.
  const db = new Client({ connectionString: process.env.E2E_DATABASE_URL });
  await db.connect();
  try {
    await db.query("update families set founded_at = founded_at - interval '4 days' where tag = any($1) and disbanded_at is null", [[tagA, tagB]]);
  } finally {
    await db.end();
  }
  expect((await giver.request.post("/api/territories/ebute-metta/claim")).status()).toBe(200);

  // The giver opens a room and proposes: Ebute Metta for ₦1,000. Their Don's proposal is their signature.
  await giver.getByRole("button", { name: /^Chat(\s*\d+\+?)?$/ }).click();
  await giver.getByRole("button", { name: "Diplomacy" }).click();
  await giver.getByLabel("Family tag to talk to").fill(tagB);
  await giver.getByRole("button", { name: "Open room" }).click();
  await giver.getByRole("combobox", { name: /^Territory/ }).selectOption("ebute-metta");
  await giver.getByLabel("Price (₦)").fill("1000");
  await giver.getByRole("button", { name: "Propose" }).click();
  await expect(giver.getByTestId("open-proposals")).toContainText(`[${tagA}] hands Ebute Metta to [${tagB}] for ₦1,000`);
  await expect(giver.getByTestId("open-proposals")).toContainText(`[${tagA}] signed`);
  await giver.getByLabel("Message", { exact: true }).fill("Yours for a thousand. Sign when ready.");
  await giver.getByRole("button", { name: "Send" }).click();

  // The taker hears about it, follows the notification to the room, reads the message and signs.
  await expect(taker.getByRole("button", { name: /^Notifications, / })).toHaveAccessibleName("Notifications, 1 unread");
  await taker.getByRole("button", { name: /^Notifications, / }).click();
  await taker.getByRole("button", { name: new RegExp(`^\\[${tagA}\\] proposed Ebute Metta`) }).click();
  await taker.getByRole("button", { name: `Givers ${run} [${tagA}]` }).click();
  await expect(taker.getByTestId("messages")).toContainText("Yours for a thousand.");
  await taker.getByTestId("open-proposals").getByRole("button", { name: "Sign" }).click();
  await expect(taker.getByTestId("proposals")).toContainText("None open.");
  await taker.screenshot({ path: "test-results/e2e/diplomacy.png" });

  // Both sides see the result live.
  await expect(giver.getByTestId("proposals")).toContainText("None open.");
  await taker.getByRole("navigation", { name: "Panels" }).getByRole("button", { name: "Family" }).click();
  await expect(taker.getByTestId("treasury-balance")).toHaveText("₦19,000");
  await expect(taker.getByTestId("activity")).toContainText(`Received Ebute Metta from [${tagA}] for ₦1,000`);
  expect((await (await taker.request.get("/api/territories/ebute-metta")).json()).owner.tag).toBe(tagB);
});

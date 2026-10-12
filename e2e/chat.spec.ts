import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { Client } from "pg";

const PASSWORD = "correct horse battery";
const run = Date.now().toString(36).slice(-5);

// Closed even when a test fails: a leftover context keeps its map rendering (in software here) and slows every later test.
const contexts: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close();
});

async function register(browser: Browser, handle: string): Promise<Page> {
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
  return page;
}

async function found(page: Page, family: string, tag: string): Promise<void> {
  await page.getByLabel("Name").fill(family);
  await page.getByLabel("Tag").fill(tag);
  await page.getByRole("button", { name: "Create family" }).click();
  await expect(page.getByTestId("treasury-balance")).toHaveText("₦20,000");
}

const bell = (page: Page) => page.getByRole("button", { name: /^Notifications, / });

test("an invitation arrives live; once in, two members chat in real time", async ({ browser }) => {
  const tag = `C${run.slice(-4)}`.toUpperCase();
  const donHandle = `don_${run}`;
  const memberHandle = `mem_${run}`;
  const don = await register(browser, donHandle);
  await found(don, `Chatters ${run}`, tag);
  const member = await register(browser, memberHandle);

  // The invitation raises the bell without a reload, and the notification leads to it.
  await expect(bell(member)).toHaveAccessibleName("Notifications, 0 unread");
  await don.getByLabel("Handle to invite").fill(memberHandle);
  await don.getByRole("button", { name: "Invite", exact: true }).click();
  await expect(bell(member)).toHaveAccessibleName("Notifications, 1 unread");
  await bell(member).click();
  await member.getByRole("button", { name: `Chatters ${run} [${tag}] invited you to join.` }).click();
  await expect(bell(member)).toHaveAccessibleName("Notifications, 0 unread");
  await member.getByRole("button", { name: "Accept" }).click();
  await expect(member.getByTestId("treasury-balance")).toBeVisible();

  // Family chat, live in both directions.
  await don.getByRole("button", { name: /^Chat(\s*\d+\+?)?$/ }).click();
  await member.getByRole("button", { name: /^Chat(\s*\d+\+?)?$/ }).click();
  await expect(member.getByRole("button", { name: "Family", pressed: true })).toBeVisible();
  await don.getByLabel("Message", { exact: true }).fill("Meet at Balogun at noon.");
  await don.getByRole("button", { name: "Send" }).click();
  await expect(member.getByTestId("messages")).toContainText("Meet at Balogun at noon.");
  await member.getByLabel("Message", { exact: true }).fill("On my way.");
  await member.getByLabel("Message", { exact: true }).press("Enter");
  await expect(don.getByTestId("messages")).toContainText("On my way.");
  await expect(don.getByTestId("messages")).toContainText(memberHandle);
  await member.screenshot({ path: "test-results/e2e/chat.png" });

  // A message in the city channel while the member looks at family chat shows as unread on the Lagos tab.
  await don.getByRole("button", { name: "Lagos" }).click();
  await don.getByLabel("Message", { exact: true }).fill(`Hello Lagos from ${donHandle}`);
  await don.getByRole("button", { name: "Send" }).click();
  await expect(member.getByRole("button", { name: /^Lagos/ })).toContainText("1");
  await member.getByRole("button", { name: /^Lagos/ }).click();
  await expect(member.getByTestId("messages")).toContainText(`Hello Lagos from ${donHandle}`);
  await expect(member.getByRole("button", { name: /^Lagos/ })).not.toContainText("1");

});

test("a trade offer raises the other family's bell without a reload and leads to the offer", async ({ browser }) => {
  const tagA = `O${run.slice(-4)}`.toUpperCase();
  const tagB = `R${run.slice(-4)}`.toUpperCase();
  const offerer = await register(browser, `offer_${run}`);
  await found(offerer, `Offerers ${run}`, tagA);
  const receiver = await register(browser, `recv_${run}`);
  await found(receiver, `Receivers ${run}`, tagB);

  // Families must be 3 days old to trade; backdate them in the test database.
  const db = new Client({ connectionString: process.env.E2E_DATABASE_URL });
  await db.connect();
  try {
    await db.query("update families set founded_at = founded_at - interval '4 days' where tag = any($1) and disbanded_at is null", [[tagA, tagB]]);
  } finally {
    await db.end();
  }

  await offerer.getByRole("button", { name: "Market" }).click();
  await offerer.getByRole("button", { name: "Trades" }).click();
  await offerer.getByLabel("Family tag").fill(tagB);
  await offerer.getByLabel("You give amount 1", { exact: true }).fill("500");
  await offerer.getByRole("button", { name: "Send offer" }).click();
  await expect(offerer.getByTestId("outgoing")).toContainText(`To Receivers ${run} [${tagB}]`);

  await expect(bell(receiver)).toHaveAccessibleName("Notifications, 1 unread");
  await bell(receiver).click();
  await receiver.getByRole("button", { name: `[${tagA}] sent your family a trade offer.` }).click();
  await expect(receiver.getByTestId("incoming")).toContainText("You get ₦500");

});

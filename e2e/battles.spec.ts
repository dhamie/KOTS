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

async function sql(text: string, params: unknown[]): Promise<void> {
  const db = new Client({ connectionString: process.env.E2E_DATABASE_URL });
  await db.connect();
  try {
    await db.query(text, params);
  } finally {
    await db.end();
  }
}

const contested = (page: Page, slug: string) => page.evaluate((s) => (window as unknown as { __lagosMap: { contested: (s: string) => boolean } }).__lagosMap.contested(s), slug);

test("a family declares a battle from the map, commits a henchman and picks a tactic; the worker fights the round and both sides see it live", async ({ browser }) => {
  // Waits for the real worker, whose sweep runs once a minute.
  test.setTimeout(300_000);
  const tagA = `W${run.slice(-4)}`.toUpperCase();
  const tagD = `V${run.slice(-4)}`.toUpperCase();
  const attacker = await founder(browser, `atk_${run}`, `Raiders ${run}`, tagA);
  const defender = await founder(browser, `def_${run}`, `Holders ${run}`, tagD);

  // Battles need families 3 days old. The defender holds Otto and Oyingbo, with no guards; the attacker holds Iddo,
  // next to Otto, and hires one henchman.
  await sql("update families set founded_at = founded_at - interval '4 days' where tag = any($1) and disbanded_at is null", [[tagA, tagD]]);
  for (const slug of ["otto", "oyingbo"]) expect((await defender.request.post(`/api/territories/${slug}/claim`)).status()).toBe(200);
  expect((await attacker.request.post("/api/territories/iddo/claim")).status()).toBe(200);
  const familyId = (await (await attacker.request.get("/api/me")).json()).family.id;
  const hired = await attacker.request.post(`/api/families/${familyId}/recruits`, { data: { slot: 0 } });
  expect(hired.status()).toBe(201);
  const fighter: string = (await hired.json()).name;

  // The attacker opens Otto on the map and declares.
  await attacker.evaluate(() => (window.location.hash = "#t=otto"));
  await expect(attacker.getByTestId("territory-owner")).toHaveText(`Holders ${run} [${tagD}]`);
  attacker.once("dialog", (d) => void d.accept());
  await attacker.getByRole("button", { name: /^Declare battle for ₦/ }).click();
  const panel = attacker.getByTestId("battle-panel");
  await expect(panel.getByTestId("battle-status")).toContainText("Preparing · round 1 in 5h");
  await expect(panel.getByTestId("enemy-committed")).toHaveText(`[${tagD}]: 0 henchmen committed`);
  await expect.poll(() => contested(attacker, "otto")).toBe(true);

  // Commit the henchman and order a flank.
  await panel.getByTestId("available").getByRole("button", { name: "Commit" }).click();
  await expect(panel.getByTestId("committed")).toContainText(fighter);
  await panel.getByRole("button", { name: "Flank" }).click();
  await expect(panel.getByRole("button", { name: "Flank" })).toHaveAttribute("aria-pressed", "true");

  // The defender is warned, follows the notification to the family panel and opens the battle.
  await expect(defender.getByRole("button", { name: /^Notifications, / })).toHaveAccessibleName("Notifications, 1 unread");
  await defender.getByRole("button", { name: /^Notifications, / }).click();
  await defender.getByRole("button", { name: new RegExp(`^\\[${tagA}\\] declared a battle for Otto`) }).click();
  await defender.getByTestId("battles").getByRole("button", { name: "Open" }).click();
  const theirs = defender.getByTestId("battle-panel");
  await expect(theirs.getByTestId("enemy-committed")).toHaveText(`[${tagA}]: 1 henchman committed`);
  await expect.poll(() => contested(defender, "otto")).toBe(true);

  // Skip the six hours of preparation: round 1 is due now. The worker's next sweep fights it.
  await sql("update battles set next_round_at = now() where status = 'preparing' and attacker_family_id = $1", [familyId]);

  // Both panels update live: nobody defended, so the attacker wins in one round and takes Otto.
  await expect(panel.getByTestId("battle-status")).toHaveText(`Victory: [${tagA}] won`, { timeout: 150_000 });
  await expect(panel.getByTestId("battle-score")).toContainText(`[${tagA}] 1 – 0 [${tagD}]`);
  await expect(panel.getByTestId("report")).toContainText("Round 1: Flank vs Hold");
  await expect(panel.getByTestId("narration")).toContainText(`[${tagA}] won the round.`);
  await expect(theirs.getByTestId("battle-status")).toHaveText(`Defeat: [${tagA}] won`);
  await expect(theirs.getByTestId("report")).toContainText("lost");
  await attacker.screenshot({ path: "test-results/e2e/battle.png" });

  await expect.poll(() => contested(attacker, "otto")).toBe(false);
  expect((await (await attacker.request.get("/api/territories/otto")).json()).owner.tag).toBe(tagA);
  await theirs.getByRole("button", { name: "Close" }).click();
  await defender.getByRole("navigation", { name: "Panels" }).getByRole("button", { name: "Family" }).click();
  await expect(defender.getByTestId("activity")).toContainText(`Lost Otto to [${tagA}]`);
  await expect(defender.getByTestId("battles")).toContainText("lost");

  // On a phone, the battle panel is a bottom sheet like the other drawers.
  await defender.setViewportSize({ width: 390, height: 844 });
  await defender.getByTestId("battles").getByRole("button", { name: "Open" }).click();
  await expect(theirs.getByTestId("replay")).toBeVisible();
  const box = (await theirs.boundingBox())!;
  expect([box.x, box.width, Math.round(box.y + box.height)]).toEqual([0, 390, 844]);
  await defender.screenshot({ path: "test-results/e2e/battle-phone.png" });
});

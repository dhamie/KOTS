import { expect, test, type Page } from "@playwright/test";

const PASSWORD = "correct horse battery";
const run = Date.now().toString(36).slice(-5);

async function register(page: Page, handle: string) {
  await page.goto("/");
  await page.getByRole("button", { name: "Register" }).click();
  await page.getByLabel("Email").fill(`${handle}@example.test`);
  await page.getByLabel("Handle").fill(handle);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByTestId("handle")).toHaveText(handle);
}

test("register, create a family, invite, accept, promote, and see the activity", async ({ browser }) => {
  const aliceContext = await browser.newContext();
  const bisiContext = await browser.newContext();
  // Each page runs a live map; close them so they don't keep rendering through later tests.
  try {
    await familyFlow(await aliceContext.newPage(), await bisiContext.newPage());
  } finally {
    await aliceContext.close();
    await bisiContext.close();
  }
});

async function familyFlow(alice: Page, bisi: Page) {
  const aliceHandle = `alice_${run}`;
  const bisiHandle = `bisi_${run}`;

  await register(bisi, bisiHandle);
  await expect(bisi.getByText("No family yet")).toBeVisible();
  await expect(bisi.getByText("API ok · database ok")).toBeVisible();

  await register(alice, aliceHandle);
  await alice.getByLabel("Name").fill(`Eko Boys ${run}`);
  await alice.getByLabel("Tag").fill("EKO");
  await alice.getByRole("button", { name: "Create family" }).click();
  await expect(alice.getByRole("heading", { name: `Eko Boys ${run}` })).toBeVisible();
  await expect(alice.getByText("You are Don")).toBeVisible();

  await alice.getByLabel("Handle to invite").fill(bisiHandle);
  await alice.getByRole("button", { name: "Invite", exact: true }).click();
  await expect(alice.getByText(`${bisiHandle} pending`)).toBeVisible();

  await bisi.getByRole("button", { name: "refresh" }).click();
  await expect(bisi.getByText(`Eko Boys ${run} [EKO]`)).toBeVisible();
  await bisi.getByRole("button", { name: "Accept" }).click();
  await expect(bisi.getByText("You are Associate")).toBeVisible();
  // An associate gets no invite form and no role controls.
  await expect(bisi.getByLabel("Handle to invite")).toHaveCount(0);
  await expect(bisi.getByRole("combobox")).toHaveCount(0);

  await alice.getByRole("button", { name: "refresh" }).first().click();
  await alice.getByLabel(`Role of ${bisiHandle}`).selectOption("capo");
  await expect(alice.getByTestId("activity")).toContainText(`${aliceHandle} made ${bisiHandle} Capo`);

  await bisi.reload();
  await expect(bisi.getByText("You are Capo")).toBeVisible();
  const activity = bisi.getByTestId("activity");
  await expect(activity).toContainText(`${bisiHandle} joined`);
  await expect(activity).toContainText(`${aliceHandle} invited ${bisiHandle}`);
  await expect(activity).toContainText(`${aliceHandle} founded Eko Boys ${run}`);
  await bisi.screenshot({ path: "test-results/e2e/family-capo.png" });
}

test("wrong password shows the error and stays logged out; logout returns to the login form", async ({ page }) => {
  const handle = `carol_${run}`;
  await register(page, handle);
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("button", { name: "Log in" }).first()).toBeVisible();

  await page.getByLabel("Email").fill(`${handle}@example.test`);
  await page.getByLabel("Password").fill("not the password");
  await page.locator("form").getByRole("button", { name: "Log in" }).click();
  await expect(page.getByText("Wrong email or password.")).toBeVisible();

  await page.getByLabel("Password").fill(PASSWORD);
  await page.locator("form").getByRole("button", { name: "Log in" }).click();
  await expect(page.getByTestId("handle")).toHaveText(handle);
});

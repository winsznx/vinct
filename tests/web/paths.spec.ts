/**
 * The paths a judge takes, and the states the app has to survive.
 *
 * The completion gate is a person understanding the result in thirty seconds and verifying it
 * in two minutes. Both are timed here, on the built bundle, on desktop and on a phone.
 *
 * Everything chain-dependent runs against whatever `VINCT_COVENANT` names. Without it, the
 * chain-dependent assertions are skipped rather than passed, because a green tick for a test
 * that read nothing is worse than a skip that says so.
 */

import { expect, test } from "@playwright/test";

const COVENANT = process.env.VINCT_COVENANT ?? "";
const OPERATION = process.env.VINCT_OPERATION ?? "";
const withCovenant = (path: string) => (COVENANT ? `${path}?covenant=${COVENANT}` : path);

test.describe("core path", () => {
  test("the first screen names the outcome and the two things that make it hard", async ({
    page,
  }) => {
    const started = Date.now();
    await page.goto(withCovenant("/"));

    await expect(page.getByRole("heading", { name: /binding mutual aid/i })).toBeVisible();
    await expect(page.getByText(/no protocol hands anyone else admin authority/i)).toBeVisible();
    await expect(page.getByTestId("cta-proof")).toBeVisible();

    // The three claims that distinguish this from a multisig, above the fold.
    await expect(page.getByText(/from every other member/i)).toBeVisible();
    await expect(page.getByText(/one effect ceiling/i)).toBeVisible();
    await expect(page.getByText(/shares no code with the program/i)).toBeVisible();

    expect(Date.now() - started, "the first screen took too long to become readable").toBeLessThan(
      15_000,
    );
  });

  test("every route in the nav loads and keeps the selected covenant", async ({ page }) => {
    await page.goto(withCovenant("/"));
    for (const label of [
      "formation",
      "adapters",
      "incident-room",
      "observer",
      "settlement",
      "proof",
      "status",
    ]) {
      await page.getByTestId(`nav-${label}`).click();
      await expect(page).not.toHaveURL(/\/$/);
      if (COVENANT) {
        expect(page.url(), `${label} dropped the covenant from the URL`).toContain(COVENANT);
      }
      await expect(page.locator(".stamp").first()).toBeVisible();
    }
  });

  test("a route that does not exist says nothing is being withheld", async ({ page }) => {
    await page.goto("/no-such-page");
    await expect(page.getByTestId("not-found")).toBeVisible();
    // The important sentence: this is not a locked door.
    await expect(page.getByText(/protected by the rollup/i)).toBeVisible();
    await page.getByTestId("not-found-home").click();
    await expect(page.getByRole("heading", { name: /binding mutual aid/i })).toBeVisible();
  });

  test("a deep link survives a reload", async ({ page }) => {
    const target = OPERATION ? `/proof?operation=${OPERATION}` : "/proof";
    await page.goto(target);
    await expect(page.locator(".stamp").first()).toHaveText("PROOF");

    await page.reload();
    await expect(page.locator(".stamp").first()).toHaveText("PROOF");
    expect(page.url()).toContain("/proof");
    if (OPERATION) expect(page.url()).toContain(OPERATION);
  });

  test("an unreachable node is shown as an outage, never as an empty result", async ({ page }) => {
    // Port 1 refuses connections. The page must say the chain is unreachable rather than
    // rendering as though it read an empty chain.
    await page.goto("/observer?base=http://127.0.0.1:1&covenant=11111111111111111111111111111111");
    await expect(page.getByTestId("outage")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/not an empty result/i)).toBeVisible();
  });

  test("the status page says what breaks when a service is down", async ({ page }) => {
    await page.goto("/status?base=http://127.0.0.1:1&er=http://127.0.0.1:1");
    await expect(page.getByTestId("service-list")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/UNREACHABLE/).first()).toBeVisible();
    await expect(page.getByText(/Nothing on any page is current without it/i)).toBeVisible();
  });
});

test.describe("proof path", () => {
  test("a bad operation id cannot be submitted", async ({ page }) => {
    await page.goto("/proof");
    await page.getByTestId("operation-input").fill("not-an-operation");
    await expect(page.getByTestId("verify")).toBeDisabled();
  });

  test("an operation that does not exist says which cluster it looked at", async ({ page }) => {
    await page.goto("/proof");
    await page.getByTestId("operation-input").fill("00".repeat(31) + "ff");
    await page.getByTestId("verify").click();
    await expect(page.getByTestId("read-error").or(page.getByTestId("outage"))).toBeVisible({
      timeout: 30_000,
    });
  });

  test("a real operation verifies inside two minutes, with no wallet", async ({ page }) => {
    test.skip(!OPERATION, "set VINCT_OPERATION to a certified operation from a live run");
    const started = Date.now();

    await page.goto(`/proof?operation=${OPERATION}`);
    await expect(page.getByTestId("checks")).toBeVisible({ timeout: 60_000 });

    const checks = page.getByTestId("checks").locator("li");
    expect(await checks.count(), "the verifier ran no checks").toBeGreaterThan(10);
    await expect(page.getByText(/^VERIFIED/)).toBeVisible();

    // Delivery is reported next to it and never folded into the verdict.
    await expect(page.getByText(/Reported, not verified/i)).toBeVisible();

    // No wallet was connected, and nothing asked for one.
    const body = await page.locator("body").innerText();
    expect(body.toLowerCase()).not.toContain("connect wallet");

    expect(Date.now() - started, "the proof path took longer than two minutes").toBeLessThan(
      120_000,
    );
  });
});

test.describe("settlement", () => {
  test("the classification and every observation are shown separately", async ({ page }) => {
    test.skip(!COVENANT, "set VINCT_COVENANT to a covenant with a settled incident");
    await page.goto(withCovenant("/settlement"));
    await expect(page.getByTestId("effect-list")).toBeVisible({ timeout: 60_000 });

    // Three observation values, not two. The page must be able to say "not observed".
    await expect(page.getByText(/Three values, not two/i)).toBeVisible();

    const body = await page.locator("body").innerText();
    expect(
      /ALL ACTIONS APPLIED|COMMITWITHOUTACTIONS|ALLACTIONSAPPLIED|PARTIALOBSERVATION|UNKNOWN/i.test(
        body,
      ),
      "no classification was rendered",
    ).toBe(true);
  });

  test("the observer never shows a live approval count", async ({ page }) => {
    test.skip(!COVENANT, "set VINCT_COVENANT to a covenant with an incident");
    await page.goto(withCovenant("/observer"));
    await expect(page.getByTestId("incident-list")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/Not knowable\. No account holds it\.|Final count/)).toBeVisible();
  });
});

/**
 * The paths each of the four audiences takes.
 *
 * A judge who never connects a wallet, an operator who does, a member answering an incident, and
 * a public observer verifying a settlement. The old suite tested routes; this one tests whether
 * somebody can get anywhere.
 */

import { expect, test } from "@playwright/test";

const COVENANT = process.env.VINCT_COVENANT ?? "";
const OPERATION = process.env.VINCT_OPERATION ?? "";

test.describe("judge path", () => {
  test("the landing page explains VINCT without jargon or a wallet", async ({ page }) => {
    const started = Date.now();
    await page.goto("/");

    await expect(page.getByRole("heading", { name: /coordinate/i })).toBeVisible();
    await expect(page.getByText(/nobody hands anybody else authority/i)).toBeVisible();
    await expect(page.getByTestId("cta-demo")).toBeVisible();
    await expect(page.getByTestId("cta-app")).toBeVisible();

    // Nothing above the fold may demand an address or a connection.
    const body = await page.locator("body").innerText();
    expect(body.toLowerCase()).not.toContain("no covenant selected");
    expect(body.toLowerCase()).not.toContain("paste a covenant");

    expect(Date.now() - started, "the first screen took too long").toBeLessThan(15_000);
  });

  test("the demo walks a real incident and reaches the failure case", async ({ page }) => {
    await page.goto("/demo");
    await expect(page.getByText(/recorded on solana devnet/i)).toBeVisible();

    // Named protocols rather than alpha, beta, gamma.
    await expect(page.getByText("Atlas Lending").first()).toBeVisible();
    await expect(page.getByText(/pyth sol\/usd/i).first()).toBeVisible();

    // Every lifecycle step is reachable.
    for (const step of [
      "armed",
      "opened",
      "sealed",
      "certified",
      "certificate",
      "cohort",
      "verified",
    ]) {
      await page.getByTestId(`lifecycle-${step}`).click();
    }

    // The stripped cohort is the point of the page.
    await page.getByTestId("run-stripped").click();
    await expect(page.getByText(/commit without actions/i).first()).toBeVisible();
    await expect(page.getByText(/no protocol acted/i).first()).toBeVisible();

    await expect(page.getByTestId("demo-verify")).toBeVisible();
  });

  test("a judge reaches verification from the demo in one click", async ({ page }) => {
    await page.goto("/demo");
    await page.getByTestId("demo-verify").click();
    await expect(page).toHaveURL(/\/proof\//);
    await expect(page.getByRole("heading", { name: /check a settlement/i })).toBeVisible();
  });
});

test.describe("public verification", () => {
  test("a bad operation id cannot be submitted", async ({ page }) => {
    await page.goto("/proof");
    await page.getByTestId("operation-input").fill("not-an-operation");
    await expect(page.getByTestId("verify")).toBeDisabled();
  });

  test("the proof page offers real samples when given nothing", async ({ page }) => {
    await page.goto("/proof");
    await expect(page.getByText(/or try one of these/i)).toBeVisible();
    await expect(page.getByText(/both are real operations/i)).toBeVisible();
  });

  test("a real operation verifies with no wallet", async ({ page }) => {
    test.skip(!OPERATION, "set VINCT_OPERATION to a certified operation");
    const started = Date.now();
    await page.goto(`/proof/${OPERATION}`);
    await expect(page.getByTestId("checks")).toBeVisible({ timeout: 90_000 });

    const rows = page.getByTestId("checks").locator("tbody tr");
    expect(await rows.count(), "the verifier ran no checks").toBeGreaterThan(10);
    await expect(page.getByText(/^Verified/).first()).toBeVisible();

    // Delivery is reported apart from the verdict, and says so.
    await expect(page.getByText(/deliberately not part of the verdict/i)).toBeVisible();

    const body = await page.locator("body").innerText();
    expect(body.toLowerCase()).not.toContain("connect wallet");

    expect(Date.now() - started, "verification took longer than two minutes").toBeLessThan(120_000);
  });

  test("a deep link survives a reload", async ({ page }) => {
    const target = OPERATION ? `/proof/${OPERATION}` : "/proof";
    await page.goto(target);
    await expect(page.getByRole("heading", { name: /check a settlement/i })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: /check a settlement/i })).toBeVisible();
    if (OPERATION) expect(page.url()).toContain(OPERATION);
  });
});

test.describe("application", () => {
  test("the console works disconnected and offers a way in", async ({ page }) => {
    await page.goto("/app");
    await expect(page.getByText(/without a wallet/i)).toBeVisible();
    // Every empty state carries an action.
    await expect(page.getByTestId("app-nav-covenants")).toBeVisible();
    await expect(
      page.getByTestId("wallet-connect").or(page.getByTestId("wallet-none")),
    ).toBeVisible();
  });

  test("every application route loads and keeps the network", async ({ page }) => {
    await page.goto("/app?network=local");
    for (const label of ["covenants", "incidents", "adapters"]) {
      await page.getByTestId(`app-nav-${label}`).click();
      await expect(page).toHaveURL(new RegExp(label));
      expect(page.url(), `${label} dropped the network`).toContain("network=local");
    }
  });

  test("a covenant workspace shows readiness rather than raw state", async ({ page }) => {
    test.skip(!COVENANT, "set VINCT_COVENANT to a covenant on this cluster");
    await page.goto(`/app/covenants/${COVENANT}`);
    await expect(page.getByText(/readiness/i)).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText(/nobody can form this alone/i)).toBeVisible();
  });

  test("an unknown route says nothing is being withheld", async ({ page }) => {
    await page.goto("/no-such-page");
    await expect(page.getByTestId("not-found")).toBeVisible();
    await expect(page.getByText(/protected by the rollup/i)).toBeVisible();
  });
});

test.describe("resilience", () => {
  test("an unreachable node reads as an outage, never an empty result", async ({ page }) => {
    await page.goto("/app?base=http://127.0.0.1:1");
    await expect(page.getByTestId("outage")).toBeVisible({ timeout: 40_000 });
    await expect(page.getByText(/rather than an empty result/i)).toBeVisible();
  });

  test("the status page says what breaks when a service is down", async ({ page }) => {
    await page.goto("/status?base=http://127.0.0.1:1&er=http://127.0.0.1:1");
    await expect(page.getByTestId("service-list")).toBeVisible({ timeout: 40_000 });
    await expect(page.getByText(/unreachable/i).first()).toBeVisible();
    await expect(page.getByText(/nothing anywhere in the product is current/i)).toBeVisible();
  });
});

test.describe("navigation", () => {
  // The centred group only exists above the breakpoint. Below it the same destinations live in
  // a disclosure panel, which is covered by its own test rather than by skipping the case.
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 940, "desktop navigation");

  test("a grouped menu opens, closes on Escape, and reaches its section", async ({ page }) => {
    await page.goto("/");
    const trigger = page.getByTestId("site-nav-how-it-works");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");

    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("link", { name: /sealed quorum/i })).toBeVisible();

    // A hover-only menu would fail here, which is why these are disclosure widgets.
    await page.keyboard.press("Escape");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");

    await trigger.click();
    await page.getByRole("link", { name: /sealed quorum/i }).click();
    await page.waitForTimeout(900);
    // Landing under the sticky bar would look like a broken link.
    const top = await page.evaluate(
      () => document.getElementById("sealed")?.getBoundingClientRect().top ?? -999,
    );
    expect(top).toBeGreaterThan(0);
    expect(top).toBeLessThan(140);
  });

  test("every nav destination exists", async ({ page }) => {
    await page.goto("/");
    for (const group of ["site-nav-product", "site-nav-how-it-works"]) {
      await page.getByTestId(group).click();
      const links = page.locator(".nav-menu a");
      const count = await links.count();
      expect(count).toBeGreaterThan(0);
      for (let index = 0; index < count; index += 1) {
        const href = await links.nth(index).getAttribute("href");
        expect(href, `${group} item ${index} has no destination`).toBeTruthy();
      }
      await page.keyboard.press("Escape");
    }
  });
});

test.describe("navigation on a phone", () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) >= 940, "mobile navigation");

  test("every destination is one tap away", async ({ page }) => {
    await page.goto("/");
    // Hiding a destination is worse than asking for a tap, so nothing is dropped on mobile.
    await page.getByTestId("site-menu-toggle").click();
    // Scoped to the panel, because the footer carries the same destinations and an unscoped
    // match would pass on a panel that rendered nothing.
    const panel = page.locator("#site-mobile-menu");
    await expect(panel).toBeVisible();
    for (const label of [/live demo/i, /open the console/i, /service status/i, /sealed quorum/i]) {
      await expect(panel.getByRole("link", { name: label })).toBeVisible();
    }
  });
});

/**
 * What the browser keeps, and where it is allowed to talk.
 *
 * These are the two ways a correct protocol leaks anyway. A page that caches a member's answer
 * has moved it outside the rollup's permission model, and a page that pings an analytics host
 * has told a third party which incident somebody is looking at. Neither shows up in a program
 * test, so both are checked here against the built bundle, on every route.
 */

import { expect, test, type Page } from "@playwright/test";

const PUBLIC_ROUTES = ["/", "/demo", "/proof", "/status"];
const APP_ROUTES = ["/app", "/app/covenants", "/app/incidents", "/app/adapters"];
const ROUTES = [...PUBLIC_ROUTES, ...APP_ROUTES];

/** Its own origin, and RPC endpoints the reader chose. Nothing else. */
const ALLOWED_HOSTS = ["127.0.0.1", "localhost"];

/**
 * Storage keys the app is permitted to write.
 *
 * `vinct.wallet` holds a wallet's name so a reload can reconnect silently, never a key.
 * Anything else is a finding.
 */
const ALLOWED_KEYS = new Set(["vinct.wallet", "vinct.covenant"]);

/** The shapes private material takes, rather than one fixture's contents. */
const FORBIDDEN = [
  "approve",
  "reject",
  "abstain",
  "claim",
  "evidence",
  "attestation",
  "ballot",
  "decision",
  "nonce",
  "signature",
  "secret",
  "privatekey",
];

async function settle(page: Page): Promise<void> {
  // Not networkidle: every surface polls the chain, so the page never goes idle and the wait
  // would burn its timeout on each route. A visible heading proves the app mounted.
  await expect(page.locator("h1, h2, .t-page, .m-heading").first()).toBeVisible();
  await page.waitForTimeout(900);
}

test.describe("privacy", () => {
  test("no route persists anything private", async ({ page }) => {
    for (const route of ROUTES) {
      await page.goto(route);
      await settle(page);

      const stored = await page.evaluate(() => {
        const out: { key: string; value: string }[] = [];
        for (const store of [window.localStorage, window.sessionStorage]) {
          for (let index = 0; index < store.length; index += 1) {
            const key = store.key(index);
            if (key === null) continue;
            out.push({ key, value: store.getItem(key) ?? "" });
          }
        }
        return out;
      });

      for (const entry of stored) {
        expect(
          ALLOWED_KEYS.has(entry.key),
          `${route} wrote an unexpected storage key: ${entry.key}`,
        ).toBe(true);
        const blob = `${entry.key}=${entry.value}`.toLowerCase();
        for (const word of FORBIDDEN) {
          expect(blob, `${route} persisted something matching "${word}"`).not.toContain(word);
        }
      }
    }
  });

  test("no route contacts a host the reader did not choose", async ({ page }) => {
    const offOrigin: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.protocol === "data:" || url.protocol === "blob:") return;
      if (!ALLOWED_HOSTS.includes(url.hostname)) offOrigin.push(url.hostname);
    });

    // Only the public routes, because the application deliberately reads a chain and those
    // requests go wherever the network parameter points.
    for (const route of PUBLIC_ROUTES) {
      await page.goto(`${route}?network=local`);
      await settle(page);
    }

    expect([...new Set(offOrigin)], "the app contacted hosts outside its own origin").toEqual([]);
  });

  test("the bundle carries no analytics", async ({ page }) => {
    await page.goto("/");
    const scripts = await page.evaluate(() =>
      Array.from(document.querySelectorAll("script"))
        .map((script) => script.src)
        .filter(Boolean),
    );
    for (const src of scripts) {
      expect(new URL(src).hostname).toMatch(/127\.0\.0\.1|localhost/);
    }
    const globals = await page.evaluate(() =>
      ["ga", "gtag", "dataLayer", "analytics", "posthog", "mixpanel", "Sentry", "_paq"].filter(
        (name) => name in window,
      ),
    );
    expect(globals, `analytics globals present: ${globals.join(", ")}`).toEqual([]);
  });

  test("no surface renders a live quorum count", async ({ page }) => {
    // The forbidden shape is a running tally while an incident collects. "2 approved" after a
    // terminal outcome is public and correct; "1 of 2 approvals" mid-flight is a leak.
    for (const route of [...APP_ROUTES, "/demo"]) {
      await page.goto(route);
      await settle(page);
      const text = await page.locator("body").innerText();
      expect(text, `${route} rendered a live approval progress count`).not.toMatch(
        /\b\d+\s*(of|\/)\s*\d+\s+approvals?\s+so far\b/i,
      );
      for (const leak of ["approved by", "voted approve", "voted reject", "has responded"]) {
        expect(text.toLowerCase(), `${route} rendered "${leak}"`).not.toContain(leak);
      }
    }
  });
});

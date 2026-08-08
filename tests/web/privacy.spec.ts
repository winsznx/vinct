/**
 * What the browser is allowed to keep, and where it is allowed to talk.
 *
 * These are the two ways a correct protocol leaks anyway. A page that caches a decision in
 * storage has moved it outside the rollup's permission model, and a page that pings an
 * analytics host has told a third party which incident somebody is looking at. Neither shows up
 * in a program test, so they are checked here, on the built bundle, by walking every route.
 *
 *   pnpm test:web
 */

import { expect, test, type Page } from "@playwright/test";

const ROUTES = [
  "/",
  "/formation",
  "/adapters",
  "/incident",
  "/observer",
  "/settlement",
  "/proof",
  "/status",
];

/**
 * Every host the app is permitted to contact.
 *
 * Its own origin, and RPC endpoints the user chose. Nothing else. A CDN for a font would be a
 * third party learning when somebody opens an incident page.
 */
const ALLOWED_HOSTS = ["127.0.0.1", "localhost"];

/**
 * Words that must never appear in anything persisted.
 *
 * Chosen to match the shapes private material takes rather than one fixture's contents:
 * decisions, claims, nonces, and signatures.
 */
const FORBIDDEN_IN_STORAGE = [
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
  "privateKey",
];

async function readAllStorage(page: Page): Promise<{ key: string; value: string }[]> {
  return page.evaluate(() => {
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
}

test.describe("privacy", () => {
  test("no route persists anything private", async ({ page }) => {
    for (const route of ROUTES) {
      await page.goto(route);
      // Not networkidle. Every surface polls the chain on an interval, so the page never goes
      // idle and the wait would burn its timeout on each route. What matters here is that the
      // app mounted and had a chance to write storage, which the heading proves.
      await expect(page.locator(".stamp, .display").first()).toBeVisible();

      const stored = await readAllStorage(page);
      for (const entry of stored) {
        // One key is allowed, and it holds a covenant address, which is public on chain.
        expect(entry.key, `${route} wrote an unexpected storage key: ${entry.key}`).toBe(
          "vinct.covenant",
        );

        const blob = `${entry.key}=${entry.value}`.toLowerCase();
        for (const forbidden of FORBIDDEN_IN_STORAGE) {
          expect(blob, `${route} persisted something matching "${forbidden}"`).not.toContain(
            forbidden.toLowerCase(),
          );
        }
      }
    }
  });

  test("no route contacts a host the user did not choose", async ({ page }) => {
    const offOrigin: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.protocol === "data:" || url.protocol === "blob:") return;
      if (!ALLOWED_HOSTS.includes(url.hostname)) offOrigin.push(request.url());
    });

    for (const route of ROUTES) {
      await page.goto(route);
      // Not networkidle. Every surface polls the chain on an interval, so the page never goes
      // idle and the wait would burn its timeout on each route. What matters here is that the
      // app mounted and had a chance to write storage, which the heading proves.
      await expect(page.locator(".stamp, .display").first()).toBeVisible();
    }

    expect(
      offOrigin,
      `the app contacted hosts outside its own origin: ${offOrigin.join(", ")}`,
    ).toEqual([]);
  });

  test("the bundle carries no analytics or tag manager", async ({ page }) => {
    await page.goto("/");
    const scripts = await page.evaluate(() =>
      Array.from(document.querySelectorAll("script")).map((script) => script.src),
    );
    for (const src of scripts) {
      if (!src) continue;
      expect(new URL(src).hostname, `a script loaded from ${src}`).toMatch(
        /127\.0\.0\.1|localhost/,
      );
    }

    // Common analytics globals. Their absence is the point: none of them can be added without
    // this failing.
    const globals = await page.evaluate(() =>
      ["ga", "gtag", "dataLayer", "analytics", "posthog", "mixpanel", "Sentry", "_paq"].filter(
        (name) => name in window,
      ),
    );
    expect(globals, `analytics globals present: ${globals.join(", ")}`).toEqual([]);
  });

  test("the incident room shows the shape of the private state and never its contents", async ({
    page,
  }) => {
    await page.goto("/incident");
    await expect(page.locator(".stamp").first()).toBeVisible();

    const text = (await page.locator("body").innerText()).toLowerCase();
    // Whatever the chain says, the page must never render a decision word next to a member.
    // These are the words a leaked ballot would produce.
    for (const leaked of ["approved by", "rejected by", "voted approve", "voted reject"]) {
      expect(text, `the incident room rendered "${leaked}"`).not.toContain(leaked);
    }
    // And it says out loud that it cannot read them, rather than leaving a gap.
    await expect(page.getByText(/holds no member key/i)).toBeVisible();
  });
});

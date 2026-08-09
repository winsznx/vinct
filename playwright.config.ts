/**
 * Browser tests against the built app, not the dev server.
 *
 * `vite preview` serves exactly what a deployment would, so a test cannot pass because of a
 * dev-only transform. Video is on for every test, because the phase's required evidence is a
 * recording of the path a judge takes.
 *
 * Two projects: desktop and mobile. The core path has to work on both, and a layout that only
 * survives at 1280px is a layout nobody can check on a phone during a demo.
 */

import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;

export default defineConfig({
  testDir: "tests/web",
  outputDir: "artifacts/web/test-results",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { outputFolder: "artifacts/web/report", open: "never" }]],
  timeout: 60_000,
  use: {
    /*
     * Point at a deployment with `VINCT_WEB_URL` to run the same suite against the real thing.
     *
     * The tests are written against behaviour rather than against a dev server, so the only
     * thing that changes is the origin. A suite that can only pass locally proves the build
     * works on the machine that made it.
     */
    baseURL: process.env.VINCT_WEB_URL ?? `http://127.0.0.1:${PORT}`,
    video: "on",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  // No local server when a deployed URL is given: there is nothing to start.
  ...(process.env.VINCT_WEB_URL
    ? {}
    : {
        webServer: {
          // --host is load-bearing. Without it vite preview binds to ::1, and a baseURL of
          // 127.0.0.1 then fails to connect with no error anyone would recognise.
          command: `pnpm --filter @vinct/web exec vite preview --port ${PORT} --strictPort --host 127.0.0.1`,
          url: `http://127.0.0.1:${PORT}`,
          reuseExistingServer: true,
          timeout: 120_000,
        },
      }),
});

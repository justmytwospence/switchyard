import { defineConfig } from "@playwright/test";
import { E2E_URL } from "./packages/web/e2e/state";

/**
 * Browser tests against the real stack (coordinator + host agent + Pi with the mock model),
 * started by packages/web/e2e/global-setup.ts. Run `pnpm build` first.
 */
export default defineConfig({
  testDir: "packages/web/e2e",
  globalSetup: "./packages/web/e2e/global-setup.ts",
  globalTeardown: "./packages/web/e2e/global-teardown.ts",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: process.env.SY_E2E_WORKERS ? Number(process.env.SY_E2E_WORKERS) : 4,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: E2E_URL,
    browserName: "chromium",
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop-1440x900", use: { viewport: { width: 1440, height: 900 } } },
    { name: "compact-1024x768", use: { viewport: { width: 1024, height: 768 } } },
    {
      name: "mobile-390x844",
      use: {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 3,
      },
    },
    {
      name: "mobile-360x740",
      use: {
        viewport: { width: 360, height: 740 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2,
      },
    },
  ],
});

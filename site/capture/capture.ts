/**
 * Captures the site's product screenshots from the seeded demo (demo-stack.ts), never from a real
 * deployment. Run `pnpm build` at the repository root, then `node site/capture/capture.ts` (or
 * `pnpm --dir site capture`). It writes light and dark PNGs to site/src/assets/screens/, which the
 * site optimizes at build time.
 *
 * SY_DEMO_URL and SY_DEMO_TOKEN capture from a demo that is already running instead.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, type BrowserContext, chromium, type Page } from "@playwright/test";
import { type Demo, startDemo } from "./demo-stack.ts";

const here = dirname(fileURLToPath(import.meta.url));
const out = process.env.SY_CAPTURE_OUT ?? join(here, "..", "src", "assets", "screens");

type Scheme = "light" | "dark";

interface Shot {
  name: string;
  device: "desktop" | "phone";
  path: (demo: Pick<Demo, "sessions">) => string;
  /** Wait for this text before the screenshot. */
  ready: string;
  prepare?: (page: Page) => Promise<void>;
  /** Screenshot only this element. */
  element?: string;
}

const SHOTS: Shot[] = [
  {
    name: "sessions",
    device: "desktop",
    path: (d) => `/code/${d.sessions.a11y}`,
    ready: "Ready for review",
  },
  {
    name: "terminal",
    device: "desktop",
    path: (d) => `/code/${d.sessions.retry}`,
    ready: "Submit answers",
    prepare: async (page) => {
      await page.getByRole("radio", { name: "Terminal" }).click();
      await page.locator(".xterm-screen").waitFor();
      const fit = page.getByRole("button", { name: "Fit to this screen" });
      if (await fit.isVisible()) await fit.click();
      await page.getByText("navigate").first().waitFor();
      await page.waitForTimeout(1500);
    },
    element: '[data-testid="conversation"]',
  },
  { name: "board", device: "desktop", path: () => "/board", ready: "Add Apple Pay to checkout" },
  {
    name: "question",
    device: "desktop",
    path: (d) => `/code/${d.sessions.retry}`,
    ready: "Submit answers",
  },
  {
    name: "phone-question",
    device: "phone",
    path: (d) => `/code/${d.sessions.retry}`,
    ready: "Submit answers",
    prepare: async (page) => {
      await page.getByText("Three times", { exact: true }).click();
      await page.getByText("Submit answers").scrollIntoViewIfNeeded();
    },
  },
  { name: "phone-board", device: "phone", path: () => "/board", ready: "Retry declined card" },
  { name: "phone-sessions", device: "phone", path: () => "/code", ready: "Render invoices as PDF" },
];

async function context(
  browser: Browser,
  url: string,
  token: string,
  device: Shot["device"],
  scheme: Scheme,
): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    baseURL: url,
    colorScheme: scheme,
    serviceWorkers: "block",
    reducedMotion: "reduce",
    ...(device === "phone"
      ? {
          viewport: { width: 390, height: 844 },
          deviceScaleFactor: 3,
          isMobile: true,
          hasTouch: true,
        }
      : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 }),
  });
  const enrollment = await fetch(`${url}/api/devices/enrollments`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  }).then((r) => r.json() as Promise<{ token: string }>);
  const res = await ctx.request.post("/api/enroll", {
    data: { token: enrollment.token, name: "Site capture", kind: "browser" },
  });
  if (res.status() !== 201) throw new Error(`enroll failed: ${res.status()}`);
  return ctx;
}

async function main() {
  const external = process.env.SY_DEMO_URL;
  const demo: Demo = external
    ? ({
        url: external,
        adminToken: process.env.SY_DEMO_TOKEN ?? "",
        sessions: JSON.parse(process.env.SY_DEMO_SESSIONS ?? "{}"),
        stop: async () => {},
      } as Demo)
    : await startDemo();
  const only = process.argv.slice(2);
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const scheme of ["light", "dark"] as Scheme[]) {
      for (const shot of SHOTS) {
        if (only.length && !only.includes(shot.name)) continue;
        const ctx = await context(browser, demo.url, demo.adminToken, shot.device, scheme);
        const page = await ctx.newPage();
        await page.goto(shot.path(demo));
        await page.getByText(shot.ready).first().waitFor({ timeout: 20_000 });
        await shot.prepare?.(page);
        await page.waitForTimeout(600);
        const file = join(out, `${shot.name}-${scheme}.png`);
        if (shot.element) await page.locator(shot.element).screenshot({ path: file });
        else await page.screenshot({ path: file });
        console.log(`[capture] ${file}`);
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
    await demo.stop();
  }
}

await main();

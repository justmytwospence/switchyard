import { test as base, expect, type Page, type TestInfo } from "@playwright/test";
import { type E2EState, readState } from "./state";

export type Api = <T = any>(method: string, path: string, body?: unknown) => Promise<T>;

/** Admin REST client (bearer admin token; no browser cookies). */
export function adminApi(state: E2EState): Api {
  return async (method, path, body) => {
    const res = await fetch(`${state.baseURL}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${state.adminToken}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
    return text ? JSON.parse(text) : null;
  };
}

/** Poll `fn` until it returns a truthy value. */
export async function poll<T>(
  label: string,
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 30_000,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${label}`);
}

interface Fixtures {
  state: E2EState;
  api: Api;
  /** Enroll this browser context as a device (sets the HttpOnly sy_device cookie). */
  signIn: (page?: Page) => Promise<void>;
}

export const test = base.extend<Fixtures>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture signature
  state: async ({}, use) => {
    await use(readState());
  },
  api: async ({ state }, use) => {
    await use(adminApi(state));
  },
  signIn: async ({ page, api }, use) => {
    await use(async (p = page) => {
      const e = await api<{ token: string }>("POST", "/api/devices/enrollments");
      const res = await p.request.post("/api/enroll", {
        data: { token: e.token, name: "Playwright", kind: "browser" },
      });
      expect(res.status()).toBe(201);
    });
  },
});

export { expect };

export type Viewport = "desktop" | "compact" | "mobile";

export function viewportOf(info: TestInfo): Viewport {
  const name = info.project.name;
  if (name.startsWith("desktop")) return "desktop";
  if (name.startsWith("compact")) return "compact";
  return "mobile";
}

export const isMobile = (info: TestInfo) => viewportOf(info) === "mobile";

/** Wait until the app shell connected its live sync (connection chip says Connected). */
export async function waitForApp(page: Page): Promise<void> {
  await expect(page.locator("#main")).toBeVisible();
}

/** Create a manual session in the main workspace and wait for it to reach `runtime`. */
export async function createSession(
  api: Api,
  state: E2EState,
  title: string,
  prompt: string,
  until: (s: any) => boolean = (s) => s.runtime === "idle",
): Promise<string> {
  const s = await api<{ id: string }>("POST", "/api/sessions", {
    projectId: state.projectId,
    workspace: { existingId: state.workspaceId },
    title,
    prompt,
  });
  await poll(
    `session ${title}`,
    async () => until(await api("GET", `/api/sessions/${s.id}`)),
    60_000,
  );
  return s.id;
}

/** Create a task through the API. */
export async function createTask(
  api: Api,
  state: E2EState,
  body: Record<string, unknown>,
): Promise<{ id: string; title: string }> {
  return api("POST", "/api/tasks", { projectId: state.projectId, ...body });
}

/** A unique suffix for titles created by one test. */
export function uid(info: TestInfo): string {
  return `${info.project.name.split("-")[0]}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

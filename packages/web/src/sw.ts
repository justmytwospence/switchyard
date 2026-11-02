/// <reference lib="webworker" />
import type { PushPayload } from "@switchyard/protocol";
import { cleanupOutdatedCaches, matchPrecache, precacheAndRoute } from "workbox-precaching";

/**
 * Service worker: precache the app shell, serve it for offline navigations,
 * show/clear push notifications (one tag per session) and route
 * notification clicks to the exact deep link.
 */

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null } | string>;
};

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

self.addEventListener("install", () => {
  void self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

const NO_SPA_FALLBACK = /^\/(api|ws|adapter-frames|healthz|readyz)(\/|$)/;

// Network first for navigations; fall back to the precached shell when offline.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.mode !== "navigate") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || NO_SPA_FALLBACK.test(url.pathname)) return;
  event.respondWith(
    fetch(req).catch(async () => (await matchPrecache("/index.html")) ?? Response.error()),
  );
});

function parsePayload(event: PushEvent): PushPayload | null {
  if (!event.data) return null;
  try {
    const v = event.data.json() as PushPayload;
    if (v && (v.type === "show" || v.type === "clear")) return v;
  } catch {
    // Plain-text push: show it as is.
    return {
      type: "show",
      title: "Switchyard",
      body: event.data.text(),
      tag: "switchyard",
      url: "/attention",
      renotify: false,
    };
  }
  return null;
}

self.addEventListener("push", (event) => {
  const payload = parsePayload(event);
  if (!payload) return;
  if (payload.type === "clear") {
    event.waitUntil(
      self.registration.getNotifications({ tag: payload.tag }).then((list) => {
        for (const n of list) n.close();
      }),
    );
    return;
  }
  const options: NotificationOptions & { renotify?: boolean } = {
    body: payload.body,
    tag: payload.tag,
    data: { url: payload.url },
    renotify: payload.renotify,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
  };
  event.waitUntil(self.registration.showNotification(payload.title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const raw = (event.notification.data as { url?: string } | null)?.url ?? "/";
  const target = new URL(raw, self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const sameOrigin = windows.filter((c) => new URL(c.url).origin === self.location.origin);
      const existing = sameOrigin.find((c) => c.url === target) ?? sameOrigin[0];
      if (existing) {
        const focused = await existing.focus();
        if (focused.url !== target) {
          // The app navigates in place (keeps drafts and sync state); see main.tsx.
          focused.postMessage({ type: "navigate", url: target });
        }
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});

/// <reference lib="webworker" />
import { cleanupOutdatedCaches, matchPrecache, precacheAndRoute } from "workbox-precaching";
import { parsePushData, resolvedNotice } from "./swPush";

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

const ICON = "/icon-192.png";

self.addEventListener("push", (event) => {
  const p = parsePushData(event.data);
  event.waitUntil(
    p.type === "clear"
      ? clearTag(p.tag)
      : self.registration.showNotification(p.title, {
          body: p.body,
          tag: p.tag,
          data: { url: p.url },
          renotify: p.renotify,
          icon: ICON,
          badge: ICON,
        } as NotificationOptions),
  );
});

/**
 * A `clear` push must still show something or the browser may show its own "updated in the
 * background" notice (and may revoke the subscription). With a visible window we only close;
 * otherwise we replace the notification with a silent "Resolved" one under the same tag, which
 * the app closes when it returns to the foreground.
 */
async function clearTag(tag: string): Promise<void> {
  const open = await self.registration.getNotifications({ tag });
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  if (windows.some((c) => c.visibilityState === "visible")) {
    for (const n of open) n.close();
    return;
  }
  const n = resolvedNotice(tag, open[0] ? { title: open[0].title, data: open[0].data } : null);
  await self.registration.showNotification(n.title, {
    ...n.options,
    icon: ICON,
    badge: ICON,
  } as NotificationOptions);
}

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
        try {
          const focused = (await existing.focus()) ?? existing;
          if (focused.url !== target) {
            // The app navigates in place (keeps drafts and sync state); see main.tsx.
            focused.postMessage({ type: "navigate", url: target });
          }
          return;
        } catch {
          // focus() is not allowed for this client: open a window instead.
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});

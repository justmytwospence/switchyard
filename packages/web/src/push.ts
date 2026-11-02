import { api, apiGet, apiPost } from "./sync/api";

/** Web push helpers (Settings > Notifications). */

export type PushPermission = "granted" | "denied" | "default" | "unknown" | "unsupported";

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** Whether running as an installed app (iOS only allows push in Home Screen apps). */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function isIos(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

export function pushPermission(): PushPermission {
  if (!pushSupported()) return "unsupported";
  return Notification.permission as PushPermission;
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/**
 * Ask for permission (must be called from a user gesture), subscribe with the
 * coordinator's VAPID key and register the subscription. Returns the resulting
 * permission.
 */
export async function subscribePush(): Promise<PushPermission> {
  if (!pushSupported()) return "unsupported";
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    await reportPermission(permission).catch(() => undefined);
    return permission;
  }
  const reg = await navigator.serviceWorker.ready;
  // Coordinator routes/push.ts: GET /api/push/vapid-public-key -> {publicKey}.
  const { publicKey: key } = await apiGet<{ publicKey: string }>("/api/push/vapid-public-key");
  if (!key) throw new Error("The coordinator has no push key configured");
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    });
  }
  const json = sub.toJSON();
  await apiPost("/api/push/subscriptions", {
    endpoint: json.endpoint,
    keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" },
    permission: "granted",
  });
  return "granted";
}

/** Remove this browser's subscription locally and on the coordinator. */
export async function unsubscribePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await api("/api/push/subscriptions", {
    method: "DELETE",
    body: { endpoint: sub.endpoint },
  }).catch(() => undefined);
  await sub.unsubscribe();
}

/** Tell the coordinator this device's permission state (shown in Settings). */
export async function reportPermission(permission: NotificationPermission): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  const json = sub.toJSON();
  await apiPost("/api/push/subscriptions", {
    endpoint: json.endpoint,
    keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" },
    permission,
  });
}

export function sendTestNotification(): Promise<unknown> {
  return apiPost("/api/push/test");
}

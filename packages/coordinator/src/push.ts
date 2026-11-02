import {
  type Device,
  NotificationSettings,
  type PushPayload,
  SwitchyardError,
} from "@switchyard/protocol";
import webpush from "web-push";
import type { CoordinatorContext } from "./context.js";
import type { PushSubscriptionRow } from "./store.js";

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/**
 * Delivers one push message. Throws on failure; an error carrying `statusCode` 404 or 410 means
 * the subscription is gone. Injectable for tests (`pushSender` option).
 */
export type PushSender = (
  subscription: PushTarget,
  payload: PushPayload,
  vapid: VapidKeys & { subject: string },
) => Promise<void>;

/** The real sender: web-push with VAPID. */
export const webPushSender: PushSender = async (subscription, payload, vapid) => {
  await webpush.sendNotification(subscription, JSON.stringify(payload), {
    vapidDetails: {
      subject: vapid.subject,
      publicKey: vapid.publicKey,
      privateKey: vapid.privateKey,
    },
    TTL: 24 * 3600,
    urgency: payload.type === "show" ? "high" : "normal",
  });
};

const VAPID_KEY = "vapid";
const SETTINGS_KEY = "notificationSettings";

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  quietHours: null,
  privatePreviews: false,
  preferredDeviceId: null,
};

export interface SendResult {
  sent: number;
  removed: number;
  failed: number;
}

/** VAPID keys, subscriptions per device, notification settings and delivery. */
export class PushService {
  constructor(
    private readonly ctx: CoordinatorContext,
    private readonly sender: PushSender = webPushSender,
  ) {}

  /** VAPID keys, generated once and stored in `settings`. */
  vapid(): VapidKeys {
    const existing = this.ctx.store.getSetting<VapidKeys | null>(VAPID_KEY, null);
    if (existing) return existing;
    const keys = webpush.generateVAPIDKeys();
    this.ctx.store.setSetting(VAPID_KEY, keys);
    return keys;
  }

  private subject(): string {
    const url = this.ctx.config.publicUrl;
    return url.startsWith("https://") ? url : "mailto:switchyard@localhost";
  }

  settings(): NotificationSettings {
    return {
      ...DEFAULT_NOTIFICATION_SETTINGS,
      ...this.ctx.store.getSetting<Partial<NotificationSettings>>(SETTINGS_KEY, {}),
    };
  }

  updateSettings(patch: Partial<NotificationSettings>): NotificationSettings {
    const next = NotificationSettings.parse({ ...this.settings(), ...patch });
    if (next.quietHours) {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: next.quietHours.timezone });
      } catch {
        throw new SwitchyardError(
          "invalid_request",
          `Unknown timezone "${next.quietHours.timezone}"`,
        );
      }
    }
    if (next.preferredDeviceId) this.ctx.store.devices.require(next.preferredDeviceId);
    this.ctx.store.setSetting(SETTINGS_KEY, next);
    return next;
  }

  subscriptions(deviceId: string): PushSubscriptionRow[] {
    return this.ctx.store.listPushSubscriptions(deviceId);
  }

  /** Store a browser subscription for a device and record its permission state. */
  subscribe(deviceId: string, sub: PushTarget, permission: Device["push"]["permission"]): Device {
    const { store } = this.ctx;
    return store.tx(() => {
      if (permission === "granted") {
        store.upsertPushSubscription({
          deviceId,
          endpoint: sub.endpoint,
          subscription: { endpoint: sub.endpoint, keys: sub.keys },
          createdAt: store.nowIso(),
        });
      } else {
        store.deletePushSubscription(sub.endpoint);
      }
      return this.syncDevice(deviceId, permission);
    });
  }

  unsubscribe(deviceId: string, endpoint: string | null): Device {
    const { store } = this.ctx;
    return store.tx(() => {
      if (endpoint) {
        const own = store.listPushSubscriptions(deviceId).some((s) => s.endpoint === endpoint);
        if (own) store.deletePushSubscription(endpoint);
      } else {
        store.deletePushSubscriptionsForDevice(deviceId);
      }
      return this.syncDevice(deviceId);
    });
  }

  /** Mirror subscription presence into `device.push`. */
  private syncDevice(deviceId: string, permission?: Device["push"]["permission"]): Device {
    const { store } = this.ctx;
    const d = store.devices.require(deviceId);
    const push: Device["push"] = {
      subscribed: store.listPushSubscriptions(deviceId).length > 0,
      permission: permission ?? d.push.permission,
    };
    if (JSON.stringify(push) === JSON.stringify(d.push)) return d;
    return store.putDevice({ ...d, push });
  }

  /** Send to every subscription of a device. 404/410 deletes the subscription. */
  async sendToDevice(deviceId: string, payload: PushPayload): Promise<SendResult> {
    const subs = this.ctx.store.listPushSubscriptions(deviceId);
    const result: SendResult = { sent: 0, removed: 0, failed: 0 };
    if (subs.length === 0) return result;
    const vapid = { ...this.vapid(), subject: this.subject() };
    for (const s of subs) {
      try {
        await this.sender(s.subscription, payload, vapid);
        result.sent++;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          this.ctx.store.tx(() => {
            this.ctx.store.deletePushSubscription(s.endpoint);
            if (this.ctx.store.devices.get(deviceId)) this.syncDevice(deviceId);
          });
          result.removed++;
        } else {
          result.failed++;
          this.ctx.log.warn({ err, deviceId, status }, "push delivery failed");
        }
      }
    }
    return result;
  }
}

import type {
  AttentionItem,
  AttentionReason,
  Device,
  NotificationSettings,
  PushPayload,
} from "@switchyard/protocol";
import type { CoordinatorContext } from "../context.js";
import type { PushService } from "../push.js";

export const DESKTOP_RECENT_MS = 5 * 60_000;
export const PRIVATE_PREVIEW_TEXT = "Open Switchyard to view";

const REASON_LABEL: Record<AttentionReason, string> = {
  needs_input: "Needs input",
  unsupported_interaction: "Needs input",
  failed: "Failed",
  ready_for_review: "Ready for review",
  host_unreachable: "Host unreachable",
};

export type RouteDecision =
  | { action: "inline"; deviceId: string }
  | {
      action: "push";
      target: "desktop" | "mobile";
      deviceId: string;
      payload: PushPayload;
      sent: number;
    }
  | {
      action: "suppressed";
      reason: "quiet_hours" | "desktop_active" | "no_device" | "already_notified";
      deviceId?: string;
    };

/** Is `at` inside `{start, end}` (HH:MM, may wrap midnight) in the timezone? */
export function inQuietHours(quiet: NotificationSettings["quietHours"], at: Date): boolean {
  if (!quiet) return false;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: quiet.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const hh = parts.find((p) => p.type === "hour")?.value ?? "00";
  const mm = parts.find((p) => p.type === "minute")?.value ?? "00";
  const t = `${hh}:${mm}`;
  if (quiet.start === quiet.end) return false;
  return quiet.start < quiet.end
    ? t >= quiet.start && t < quiet.end
    : t >= quiet.start || t < quiet.end;
}

export function notificationTag(item: Pick<AttentionItem, "sessionId" | "taskId" | "id">): string {
  if (item.sessionId) return `session-${item.sessionId}`;
  if (item.taskId) return `task-${item.taskId}`;
  return `attention-${item.id}`;
}

/** Notification bookkeeping key (one row per session, else per task). */
function rowKey(item: AttentionItem): string {
  return item.sessionId ?? `task:${item.taskId ?? item.id}`;
}

/**
 * Projects attention items onto OS notifications. Attention stays authoritative; this decides
 * whether and where to push, suppressing unwanted mobile pushes before sending:
 * viewing the session (foreground lease) -> inline; recent desktop interaction -> that desktop;
 * otherwise the preferred mobile device or the most recently seen PWA. Quiet hours suppress.
 */
export class NotificationRouter {
  private unsubscribe: (() => void)[] = [];

  constructor(
    private readonly ctx: CoordinatorContext,
    private readonly push: PushService,
    private readonly opts: { desktopRecentMs: number } = { desktopRecentMs: DESKTOP_RECENT_MS },
  ) {}

  start(): void {
    const raised = (item: AttentionItem) => {
      void this.route(item).catch((err) =>
        this.ctx.log.warn({ err, attentionId: item.id }, "notification routing failed"),
      );
    };
    const resolved = (item: AttentionItem) => {
      void this.clear(item).catch((err) =>
        this.ctx.log.warn({ err, attentionId: item.id }, "notification clear failed"),
      );
    };
    this.ctx.hub.on("attention.raised", raised);
    this.ctx.hub.on("attention.resolved", resolved);
    this.unsubscribe.push(
      () => this.ctx.hub.off("attention.raised", raised),
      () => this.ctx.hub.off("attention.resolved", resolved),
    );
  }

  stop(): void {
    for (const u of this.unsubscribe) u();
    this.unsubscribe = [];
  }

  payloadFor(item: AttentionItem, settings: NotificationSettings): PushPayload {
    const { store } = this.ctx;
    const project = item.projectId ? store.projects.get(item.projectId) : undefined;
    const task = item.taskId ? store.tasks.get(item.taskId) : undefined;
    const session = item.sessionId ? store.sessions.get(item.sessionId) : undefined;
    const subject = task?.title ?? session?.title ?? "Switchyard";
    const summary = settings.privatePreviews ? PRIVATE_PREVIEW_TEXT : item.summary;
    return {
      type: "show",
      title: `${project?.name ?? "Switchyard"} · ${subject}`,
      body: `${REASON_LABEL[item.reason]}: ${summary}`,
      tag: notificationTag(item),
      url: item.deepLink,
      renotify: true,
    };
  }

  private activeDevices(): Device[] {
    return this.ctx.store.devices.list("revoked_at IS NULL AND is_admin = 0");
  }

  /** Decide (and send) the notification for a newly raised attention item. */
  async route(item: AttentionItem): Promise<RouteDecision> {
    const { store } = this.ctx;
    if (item.resolvedAt) return { action: "suppressed", reason: "already_notified" };
    const key = rowKey(item);
    const prior = store.getNotification(key);
    if (prior?.attentionId === item.id && prior.sentAt) {
      return { action: "suppressed", reason: "already_notified" };
    }
    const now = store.now();
    const devices = new Map(this.activeDevices().map((d) => [d.id, d]));
    const presence = store.listPresence().filter((p) => devices.has(p.deviceId));

    // 1. Someone is looking at this session right now.
    if (item.sessionId) {
      const viewer = presence.find(
        (p) =>
          p.viewingSessionId === item.sessionId &&
          p.foregroundUntil !== null &&
          Date.parse(p.foregroundUntil) > now.getTime(),
      );
      if (viewer) return { action: "inline", deviceId: viewer.deviceId };
    }

    const settings = this.push.settings();
    // 2. A desktop client (browser or terminal) was used recently: notify there, not mobile.
    const desktop = presence
      .filter((p) => {
        const kind = devices.get(p.deviceId)?.kind;
        return (
          (kind === "browser" || kind === "terminal") &&
          p.interactedAt !== null &&
          now.getTime() - Date.parse(p.interactedAt) <= this.opts.desktopRecentMs
        );
      })
      .sort((a, b) => Date.parse(b.interactedAt!) - Date.parse(a.interactedAt!))[0];
    let target: { deviceId: string; kind: "desktop" | "mobile" } | null = null;
    if (desktop) {
      if (this.push.subscriptions(desktop.deviceId).length === 0) {
        return { action: "suppressed", reason: "desktop_active", deviceId: desktop.deviceId };
      }
      target = { deviceId: desktop.deviceId, kind: "desktop" };
    } else {
      // 3. Preferred mobile device, else the most recently seen PWA.
      const subscribed = (d: Device | undefined) => !!d && this.push.subscriptions(d.id).length > 0;
      const preferred =
        (settings.preferredDeviceId ? devices.get(settings.preferredDeviceId) : undefined) ??
        [...devices.values()].find((d) => d.preferredMobile);
      const pwa = [...devices.values()]
        .filter((d) => d.kind === "pwa" && subscribed(d))
        .sort((a, b) =>
          (b.lastSeenAt ?? b.createdAt).localeCompare(a.lastSeenAt ?? a.createdAt),
        )[0];
      const chosen = subscribed(preferred) ? preferred : pwa;
      if (chosen) target = { deviceId: chosen.id, kind: "mobile" };
    }
    if (!target) return { action: "suppressed", reason: "no_device" };
    // 4. Quiet hours suppress pushes; the attention item is still recorded.
    if (inQuietHours(settings.quietHours, now)) {
      return { action: "suppressed", reason: "quiet_hours", deviceId: target.deviceId };
    }
    const payload = this.payloadFor(item, settings);
    // Recorded before sending so a resolve racing the delivery still clears it.
    store.putNotification({
      sessionId: key,
      attentionId: item.id,
      sentToDevice: target.deviceId,
      sentAt: store.nowIso(),
      tag: notificationTag(item),
    });
    const r = await this.push.sendToDevice(target.deviceId, payload);
    if (r.sent === 0 && store.getNotification(key)?.attentionId === item.id) {
      store.deleteNotification(key);
    }
    return {
      action: "push",
      target: target.kind,
      deviceId: target.deviceId,
      payload,
      sent: r.sent,
    };
  }

  /** Best-effort `{type: "clear", tag}` to the device last notified for this item. */
  async clear(item: AttentionItem): Promise<boolean> {
    const { store } = this.ctx;
    const key = rowKey(item);
    const row = store.getNotification(key);
    if (!row || row.attentionId !== item.id || !row.sentToDevice) return false;
    store.deleteNotification(key);
    const r = await this.push.sendToDevice(row.sentToDevice, {
      type: "clear",
      tag: row.tag ?? notificationTag(item),
    });
    return r.sent > 0;
  }
}

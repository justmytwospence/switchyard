import type { PushPayload } from "@switchyard/protocol";

/** Pure push helpers for the service worker (kept out of sw.ts so Node tests can import them). */

type Show = Extract<PushPayload, { type: "show" }>;

export const FALLBACK_PUSH: Show = {
  type: "show",
  title: "Switchyard",
  body: "Something changed. Open Switchyard to see it.",
  tag: "switchyard",
  url: "/attention",
  renotify: false,
};

const isString = (v: unknown): v is string => typeof v === "string";

/** Always returns something to show or clear: every push must be user-visible. */
export function parsePushData(data: { json(): unknown; text(): string } | null): PushPayload {
  if (!data) return FALLBACK_PUSH;
  let v: Record<string, unknown> | null;
  try {
    v = data.json() as Record<string, unknown> | null;
  } catch {
    let text = "";
    try {
      text = data.text();
    } catch {
      // unreadable body
    }
    return text ? { ...FALLBACK_PUSH, body: text } : FALLBACK_PUSH;
  }
  if (v?.type === "clear" && isString(v.tag)) return { type: "clear", tag: v.tag };
  if (
    v?.type === "show" &&
    isString(v.title) &&
    isString(v.body) &&
    isString(v.tag) &&
    isString(v.url)
  ) {
    return {
      type: "show",
      title: v.title,
      body: v.body,
      tag: v.tag,
      url: v.url,
      renotify: v.renotify === true,
    };
  }
  return FALLBACK_PUSH;
}

/**
 * The silent replacement for a cleared notification when no window is visible: it updates the
 * notification in place under the same tag (no sound) so the push is still user-visible.
 */
export function resolvedNotice(tag: string, prev: { title: string; data: unknown } | null) {
  const url = (prev?.data as { url?: unknown } | null)?.url;
  return {
    title: "Resolved",
    options: {
      body: prev?.title
        ? `${prev.title} no longer needs you.`
        : "A Switchyard item no longer needs you.",
      tag,
      silent: true,
      renotify: false,
      data: { url: isString(url) ? url : "/attention", resolved: true },
    },
  };
}

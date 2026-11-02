import type { OidcClaimResponse } from "@switchyard/protocol";

/** How often the PWA polls `POST /api/auth/oidc/claim` while the screen is visible. */
export const HANDOFF_POLL_MS = 2000;
/** How long a handoff waits before giving up (the coordinator flow lives 10 minutes). */
export const HANDOFF_TIMEOUT_MS = 10 * 60 * 1000;

export type HandoffPhase = "waiting" | "done" | "timeout" | "failed" | "cancelled";

export interface HandoffState {
  phase: HandoffPhase;
  startedAt: number;
  /** Set when `phase` is `failed`. */
  message: string | null;
}

export type HandoffEvent =
  | { type: "claim"; result: OidcClaimResponse; now: number }
  | { type: "claim_error"; code: string; message: string; now: number }
  | { type: "tick"; now: number }
  | { type: "cancel" };

export function startHandoff(now: number): HandoffState {
  return { phase: "waiting", startedAt: now, message: null };
}

/**
 * Pure state machine for the PWA single sign-on handoff. Terminal phases
 * never change. A transient error (network, server hiccup) keeps waiting;
 * an expired or unknown flow (`unauthorized`, `invalid_request`) fails.
 */
export function handoffReduce(state: HandoffState, event: HandoffEvent): HandoffState {
  if (state.phase !== "waiting") return state;
  if (event.type === "cancel") return { ...state, phase: "cancelled" };
  if (event.now - state.startedAt >= HANDOFF_TIMEOUT_MS && event.type !== "claim") {
    return { ...state, phase: "timeout" };
  }
  switch (event.type) {
    case "tick":
      return state;
    case "claim":
      if (event.result.status === "done") return { ...state, phase: "done" };
      return event.now - state.startedAt >= HANDOFF_TIMEOUT_MS
        ? { ...state, phase: "timeout" }
        : state;
    case "claim_error":
      if (event.code === "unauthorized" || event.code === "invalid_request") {
        return { ...state, phase: "failed", message: event.message };
      }
      return state;
  }
}

/** Whether a poll should run now: still waiting and the page is visible. */
export function shouldPoll(state: HandoffState, visible: boolean): boolean {
  return state.phase === "waiting" && visible;
}

const GENERIC_FORBIDDEN = "This account is not allowed to sign in to this server.";

/** Static texts for coordinator error codes shown on /enroll. */
export const ERROR_TEXT: Record<string, string> = {
  enrollment_expired:
    "This enrollment link has expired. Links are valid for 10 minutes. Create a new one from Settings › Devices › Add device on an enrolled device, or run `switchyard pair` on the server.",
  enrollment_used:
    "This enrollment link was already used. Each link enrolls one device. Create a new one from Settings › Devices › Add device, or run `switchyard pair`.",
  invalid_request: "The enrollment request was rejected. Check the device name and try again.",
  network: "Could not reach the coordinator. Check your connection and try again.",
  rate_limited: "Too many attempts. Wait a minute and try again.",
  unsupported_capability: "This sign-in method is not available on this server.",
  unauthorized: "That sign-in was not accepted. Try again, or use another sign-in method.",
};

/**
 * Message for an error code, with the coordinator's `detail` where it is the
 * useful part (`/enroll?error=forbidden&detail=Signed in as ...`).
 */
export function enrollErrorText(code: string, detail?: string | null): string {
  const d = detail?.trim() || null;
  switch (code) {
    case "forbidden":
      return d ?? GENERIC_FORBIDDEN;
    case "oidc_failed":
      return `Single sign-on failed: ${d ?? "the identity provider returned an error."}`;
    case "unsupported_capability":
      return d ?? (ERROR_TEXT.unsupported_capability as string);
    default:
      return ERROR_TEXT[code] ?? d ?? `Sign-in failed (${code}).`;
  }
}

/** Short heading for an error alert. */
export function enrollErrorTitle(code: string): string {
  switch (code) {
    case "enrollment_expired":
      return "Enrollment link expired";
    case "enrollment_used":
      return "Enrollment link already used";
    case "forbidden":
      return "Not allowed";
    case "oidc_failed":
      return "Single sign-on failed";
    case "rate_limited":
      return "Too many attempts";
    default:
      return "Sign-in failed";
  }
}

/** A readable default device name from the user agent, e.g. "Safari on iPhone". */
export function defaultDeviceName(ua: string = navigator.userAgent): string {
  const device = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Macintosh|Mac OS X/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : /Linux/.test(ua)
              ? "Linux"
              : "device";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\/|FxiOS/.test(ua)
      ? "Firefox"
      : /Chrome\/|CriOS/.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Browser";
  return `${browser} on ${device}`;
}

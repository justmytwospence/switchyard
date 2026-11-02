import type { Presence } from "@switchyard/protocol";
import { useEffect } from "react";
import type { SyncClient } from "./sync/client";

/**
 * Presence leases for notification routing (spec 16): whether this client is
 * in the foreground, when the user last interacted, and which session is on
 * screen. Sent every 20 s and on change. A socket alone is not presence.
 */

const HEARTBEAT_MS = 20_000;
const INTERACTION_THROTTLE_MS = 10_000;

let client: SyncClient | null = null;
let viewing: string | null = null;
let interactedAt: string | null = null;
let lastSentAt = 0;
let lastSent: Presence | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function isForeground(): boolean {
  return document.visibilityState === "visible";
}

export function currentPresence(): Presence {
  return {
    foreground: isForeground(),
    interactedAt,
    viewing: viewing && isForeground() ? { sessionId: viewing } : null,
  };
}

function send(force = false): void {
  if (!client) return;
  const p = currentPresence();
  const changed =
    !lastSent ||
    lastSent.foreground !== p.foreground ||
    lastSent.viewing?.sessionId !== p.viewing?.sessionId;
  if (!force && !changed) return;
  if (client.send({ type: "presence", presence: p })) {
    lastSent = p;
    lastSentAt = Date.now();
  }
}

function onInteraction(): void {
  interactedAt = new Date().toISOString();
  if (Date.now() - lastSentAt > INTERACTION_THROTTLE_MS) send(true);
}

function onVisibility(): void {
  if (isForeground()) interactedAt = new Date().toISOString();
  send(true);
}

/** Start reporting presence over the sync client. Returns a stop function. */
export function startPresence(c: SyncClient): () => void {
  client = c;
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pointerdown", onInteraction, { passive: true });
  window.addEventListener("keydown", onInteraction, { passive: true });
  window.addEventListener("focus", onVisibility);
  const offLive = c.onLive(() => send(true));
  timer = setInterval(() => send(true), HEARTBEAT_MS);
  send(true);
  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pointerdown", onInteraction);
    window.removeEventListener("keydown", onInteraction);
    window.removeEventListener("focus", onVisibility);
    offLive();
    if (timer) clearInterval(timer);
    timer = null;
    client = null;
  };
}

/** Set which session is on screen (null when none). */
export function setViewing(sessionId: string | null): void {
  if (viewing === sessionId) return;
  viewing = sessionId;
  send();
}

/** Report the session on screen while the calling component is mounted. */
export function useViewingSession(sessionId: string | null | undefined): void {
  useEffect(() => {
    setViewing(sessionId ?? null);
    return () => setViewing(null);
  }, [sessionId]);
}

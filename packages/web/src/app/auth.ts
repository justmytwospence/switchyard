import type { Device } from "@switchyard/protocol";
import { create } from "zustand";
import { startPresence } from "../presence";
import { ApiClientError, apiGet, onUnauthorized } from "../sync/api";
import { clearCache } from "../sync/cache";
import { syncClient } from "../sync/client";
import { syncStore } from "../sync/store";

/** Response of GET /api/me: `{device, admin, publicUrl}` (coordinator routes/auth.ts). */
export interface Me {
  device: Device;
  /** The local admin token (CLI), not a browser device. */
  admin: boolean;
  /** The coordinator's public URL (enrollment links, push deep links). */
  publicUrl: string;
}

export type AuthStatus = "checking" | "authenticated" | "unauthenticated" | "error";

interface AuthStore {
  status: AuthStatus;
  me: Me | null;
  error: unknown;
  /** Why the device was signed out (device revoked, force_logout reason). */
  signedOutReason: string | null;
}

export const useAuth = create<AuthStore>()(() => ({
  status: "checking",
  me: null,
  error: null,
  signedOutReason: null,
}));

const ME_KEY = "sy:me";
const RETURN_KEY = "sy:returnTo";

let stopPresence: (() => void) | null = null;

function startSync(): void {
  syncClient.start();
  stopPresence ??= startPresence(syncClient);
}

function stopSync(): void {
  syncClient.stop();
  stopPresence?.();
  stopPresence = null;
}

/** The current device id, when known. */
export function currentDeviceId(): string | null {
  const me = useAuth.getState().me;
  return me?.device?.id ?? null;
}

/** GET /api/me; starts live sync when authenticated. */
export async function checkAuth(): Promise<AuthStatus> {
  useAuth.setState({ status: "checking", error: null });
  try {
    const me = await apiGet<Me>("/api/me");
    try {
      localStorage.setItem(ME_KEY, JSON.stringify(me));
    } catch {
      // ignore
    }
    useAuth.setState({ status: "authenticated", me, signedOutReason: null });
    startSync();
    return "authenticated";
  } catch (e) {
    if (e instanceof ApiClientError && (e.status === 401 || e.code === "device_revoked")) {
      signOut(e.code === "device_revoked" ? "This device was revoked." : null);
      return "unauthenticated";
    }
    // Coordinator unreachable: run from the offline cache if this device enrolled before.
    const cached = readCachedMe();
    if (cached) {
      useAuth.setState({ status: "authenticated", me: cached });
      startSync();
      return "authenticated";
    }
    useAuth.setState({ status: "error", error: e });
    return "error";
  }
}

function readCachedMe(): Me | null {
  try {
    const raw = localStorage.getItem(ME_KEY);
    const me = raw ? (JSON.parse(raw) as Partial<Me>) : null;
    // Ignore caches written before the shape was known.
    return me?.device?.id ? (me as Me) : null;
  } catch {
    return null;
  }
}

/** Forget the local session and show enrollment. */
export function signOut(reason: string | null): void {
  stopSync();
  void clearCache();
  syncStore.getState().reset();
  try {
    localStorage.removeItem(ME_KEY);
  } catch {
    // ignore
  }
  useAuth.setState({ status: "unauthenticated", me: null, signedOutReason: reason });
}

/** Remember where to go after enrollment (deep links survive authentication). */
export function saveReturnTo(url: string): void {
  if (url.startsWith("/enroll")) return;
  try {
    localStorage.setItem(RETURN_KEY, url);
  } catch {
    // ignore
  }
}

/** Saved deep link (consumed). Only same-origin paths are honored. */
export function takeReturnTo(fromQuery: string | null): string {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(RETURN_KEY);
    localStorage.removeItem(RETURN_KEY);
  } catch {
    // ignore
  }
  const candidate = fromQuery ?? saved;
  if (
    candidate?.startsWith("/") &&
    !candidate.startsWith("//") &&
    !candidate.startsWith("/enroll")
  ) {
    return candidate;
  }
  return "/";
}

let wired = false;
/** Wire global auth listeners once. */
export function initAuth(): void {
  if (wired) return;
  wired = true;
  onUnauthorized((code) => {
    if (useAuth.getState().status === "authenticated") {
      signOut(code === "device_revoked" ? "This device was revoked." : null);
    }
  });
  syncClient.onLogout((reason) => {
    signOut(reason === "unauthorized" ? null : `Signed out: ${reason}`);
  });
}

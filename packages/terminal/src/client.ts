import type {
  ClientToServer,
  Interaction,
  InteractionResponse,
  Presence,
  ServerToClient,
  Session,
  TranscriptItem,
} from "@switchyard/protocol";
import WebSocket from "ws";
import {
  backoffDelay,
  computePresence,
  FOREGROUND_MS,
  keypressShouldSend,
  PRESENCE_INTERVAL_MS,
  presenceChanged,
} from "./presence.js";
import {
  applyEvent,
  applyReplay,
  applySessionSnapshot,
  applySnapshot,
  applyStream,
  applyTranscriptPage,
  Store,
  setConnection,
  upsertInteraction,
} from "./store.js";

/** An error response from the coordinator REST API (`{error: {code, message, details}}`). */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  coordinatorUrl: string;
  /** Device credential (or the local admin token), sent as `Authorization: Bearer`. */
  credential: string | null;
  fetch?: FetchLike;
}

/** Minimal JSON REST client for the coordinator, shared by the terminal app and the CLI. */
export class ApiClient {
  readonly baseUrl: string;
  private readonly credential: string | null;
  private readonly doFetch: FetchLike;

  constructor(opts: ApiClientOptions) {
    this.baseUrl = opts.coordinatorUrl.replace(/\/+$/, "");
    this.credential = opts.credential;
    this.doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.credential) headers.authorization = `Bearer ${this.credential}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await this.doFetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new ApiRequestError(
        0,
        "host_unreachable",
        `Cannot reach coordinator ${this.baseUrl}: ${(err as Error).message}`,
      );
    }
    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (!res.ok) {
      const e = (json as { error?: { code?: string; message?: string; details?: unknown } } | null)
        ?.error;
      throw new ApiRequestError(
        res.status,
        e?.code ?? (res.status === 401 ? "unauthorized" : "internal"),
        e?.message ?? `HTTP ${res.status} for ${method} ${path}`,
        e?.details,
      );
    }
    return json as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  post<T>(path: string, body: unknown = {}): Promise<T> {
    return this.request<T>("POST", path, body);
  }
}

export function wsUrlFor(coordinatorUrl: string): string {
  const u = new URL(coordinatorUrl.replace(/\/+$/, ""));
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = `${u.pathname.replace(/\/+$/, "")}/ws/client`;
  u.search = "";
  u.hash = "";
  return u.toString();
}

export interface ClientOptions extends ApiClientOptions {
  /** WebSocket constructor (tests inject a fake). */
  WebSocketImpl?: typeof WebSocket;
  now?: () => number;
  random?: () => number;
  pingIntervalMs?: number;
}

export type AnswerOutcome =
  | { status: "answered"; interaction: Interaction }
  | { status: "already_answered"; summary: string; interaction: Interaction | null };

const PING_INTERVAL_MS = 25_000;
const PONG_TIMEOUT_MS = 10_000;

/**
 * The terminal's connection to a coordinator: REST for queries and mutations, `/ws/client` for
 * live sync into an in-memory `Store`, interaction-based presence, reconnect with backoff, and
 * `force_logout` handling.
 */
export class SwitchyardClient {
  readonly api: ApiClient;
  readonly store = new Store();
  private readonly opts: ClientOptions;
  private ws: WebSocket | null = null;
  private stopped = true;
  private attempts = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private pongTimer: NodeJS.Timeout | null = null;
  private presenceTimer: NodeJS.Timeout | null = null;
  private foregroundTimer: NodeJS.Timeout | null = null;
  private lastKeyAt: number | null = null;
  private viewing: string | null = null;
  private lastPresence: Presence | null = null;
  private lastPresenceSentAt: number | null = null;
  private logoutListeners = new Set<(reason: string) => void>();
  private liveListeners = new Set<() => void>();

  constructor(opts: ClientOptions) {
    this.opts = opts;
    this.api = new ApiClient(opts);
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  connect(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.open();
    this.presenceTimer = setInterval(() => this.sendPresence(true), PRESENCE_INTERVAL_MS);
    this.presenceTimer.unref?.();
  }

  close(): void {
    this.stopped = true;
    this.clearTimers();
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    if (this.foregroundTimer) clearTimeout(this.foregroundTimer);
    this.presenceTimer = null;
    this.foregroundTimer = null;
    const ws = this.ws;
    this.ws = null;
    ws?.removeAllListeners();
    ws?.on("error", () => undefined);
    try {
      ws?.close(1000, "client closed");
    } catch {
      // not open yet
    }
  }

  onLogout(fn: (reason: string) => void): () => void {
    this.logoutListeners.add(fn);
    return () => this.logoutListeners.delete(fn);
  }

  /** Called each time the connection becomes live (after replay or snapshot). */
  onLive(fn: () => void): () => void {
    this.liveListeners.add(fn);
    return () => this.liveListeners.delete(fn);
  }

  send(msg: ClientToServer): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  private open(): void {
    if (this.stopped) return;
    const Impl = this.opts.WebSocketImpl ?? WebSocket;
    const headers: Record<string, string> = {};
    if (this.opts.credential) headers.authorization = `Bearer ${this.opts.credential}`;
    let ws: WebSocket;
    try {
      ws = new Impl(wsUrlFor(this.opts.coordinatorUrl), { headers });
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.on("open", () => {
      if (this.ws !== ws) return;
      const cursor = this.store.getState().seq;
      ws.send(JSON.stringify({ type: "hello", cursor } satisfies ClientToServer));
    });
    ws.on("message", (raw) => {
      if (this.ws !== ws) return;
      let msg: ServerToClient;
      try {
        msg = JSON.parse(raw.toString()) as ServerToClient;
      } catch {
        return;
      }
      this.handle(msg);
    });
    ws.on("unexpected-response", (_req, res) => {
      if (this.ws !== ws) return;
      const code = res.statusCode ?? 0;
      res.resume();
      if (code === 401 || code === 403) {
        this.logout(code === 401 ? "This device's credential was rejected" : "Forbidden");
        return;
      }
      this.ws = null;
      this.scheduleReconnect();
    });
    ws.on("close", (code, reason) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearTimers();
      if (this.stopped) return;
      if (code === 4401 || code === 4403) {
        this.logout(reason.toString() || "unauthorized");
        return;
      }
      this.scheduleReconnect();
    });
    ws.on("error", () => {
      // close follows and schedules the reconnect.
    });
  }

  private handle(msg: ServerToClient): void {
    switch (msg.type) {
      case "snapshot":
        this.store.update((s) => applySnapshot(s, msg.seq, msg.state));
        this.becomeLive();
        break;
      case "replay":
        this.store.update((s) => applyReplay(s, msg.seq, msg.events));
        this.becomeLive();
        break;
      case "event":
        this.store.update((s) => applyEvent(s, msg.event));
        break;
      case "stream":
        this.store.update((s) => applyStream(s, msg.delta));
        break;
      case "pong":
        if (this.pongTimer) clearTimeout(this.pongTimer);
        this.pongTimer = null;
        break;
      case "force_logout":
        this.logout(msg.reason);
        break;
    }
  }

  private becomeLive(): void {
    this.attempts = 0;
    this.store.update((s) => setConnection(s, { state: "live", attempts: 0, reason: null }));
    this.lastPresence = null;
    this.sendPresence(true);
    this.startPing();
    for (const fn of this.liveListeners) fn();
    // After a snapshot the viewed transcript is stale: reload it.
    if (this.viewing && this.store.getState().transcripts[this.viewing]?.stale) {
      void this.loadSession(this.viewing).catch(() => undefined);
    }
  }

  private logout(reason: string): void {
    this.close();
    this.store.update((s) => setConnection(s, { state: "logged_out", reason }));
    for (const fn of this.logoutListeners) fn(reason);
  }

  private startPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (!this.send({ type: "ping" })) return;
      if (this.pongTimer) return;
      this.pongTimer = setTimeout(() => {
        this.pongTimer = null;
        this.ws?.terminate();
      }, PONG_TIMEOUT_MS);
    }, this.opts.pingIntervalMs ?? PING_INTERVAL_MS);
    this.pingTimer.unref?.();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.attempts++;
    this.store.update((s) =>
      setConnection(s, {
        state: s.synced ? "reconnecting" : "connecting",
        attempts: this.attempts,
      }),
    );
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = null;
        this.open();
      },
      backoffDelay(this.attempts, this.opts.random),
    );
    this.retryTimer.unref?.();
  }

  private clearTimers(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.retryTimer = null;
    this.pingTimer = null;
    this.pongTimer = null;
  }

  // Presence

  /** Record a keypress: foreground for 45 s and a fresh `interactedAt`. */
  noteKeypress(): void {
    const now = this.now();
    this.lastKeyAt = now;
    const next = computePresence(now, this.lastKeyAt, this.viewing);
    if (keypressShouldSend(this.lastPresence, next, now, this.lastPresenceSentAt)) {
      this.sendPresence(true);
    }
    // Report the end of the foreground lease when it lapses without further keys.
    if (this.foregroundTimer) clearTimeout(this.foregroundTimer);
    this.foregroundTimer = setTimeout(() => this.sendPresence(false), FOREGROUND_MS + 50);
    this.foregroundTimer.unref?.();
  }

  setViewing(sessionId: string | null): void {
    if (this.viewing === sessionId) return;
    this.viewing = sessionId;
    this.sendPresence(false);
  }

  get viewingSessionId(): string | null {
    return this.viewing;
  }

  /** Send presence when it changed (or always, with `force`). */
  private sendPresence(force: boolean): void {
    const now = this.now();
    const next = computePresence(now, this.lastKeyAt, this.viewing);
    if (!force && !presenceChanged(this.lastPresence, next)) return;
    if (this.send({ type: "presence", presence: next })) {
      this.lastPresence = next;
      this.lastPresenceSentAt = now;
    }
  }

  // Data

  /** Load the newest transcript page and the host's live snapshot (best effort) for a session. */
  async loadSession(sessionId: string): Promise<void> {
    const page = await this.api.get<{ items: TranscriptItem[]; hasMore: boolean }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/transcript?limit=200`,
    );
    this.store.update((s) => applyTranscriptPage(s, sessionId, page.items, page.hasMore));
    try {
      const snap = await this.api.get<{
        partial: TranscriptItem[];
        pendingInteractions: Interaction[];
      }>(`/api/sessions/${encodeURIComponent(sessionId)}/snapshot`);
      if (snap && Array.isArray(snap.partial)) {
        this.store.update((s) => applySessionSnapshot(s, sessionId, snap));
      }
    } catch {
      // Host offline: the durable transcript is still shown.
    }
  }

  prompt(sessionId: string, text: string, mode: "prompt" | "followUp" | "steer") {
    return this.api.post<{ ok: boolean; automationActive?: boolean }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/prompt`,
      { text, mode },
    );
  }

  /**
   * Answer an interaction. The server is authoritative: a 409 `already_answered` carries the
   * accepted resolution, which is applied and reported as "Already answered: <summary>".
   */
  async answer(interaction: Interaction, response: InteractionResponse): Promise<AnswerOutcome> {
    try {
      const res = await this.api.post<{ status: string; interaction: Interaction }>(
        `/api/interactions/${encodeURIComponent(interaction.id)}/answer`,
        { revision: interaction.revision, response },
      );
      this.store.update((s) => upsertInteraction(s, res.interaction));
      return { status: "answered", interaction: res.interaction };
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === "already_answered") {
        const other =
          (err.details as { interaction?: Interaction } | undefined)?.interaction ?? null;
        if (other) this.store.update((s) => upsertInteraction(s, other));
        return {
          status: "already_answered",
          summary: other?.resolution?.summary ?? "answered on another device",
          interaction: other,
        };
      }
      throw err;
    }
  }

  takeover(sessionId: string) {
    return this.api.post(`/api/sessions/${encodeURIComponent(sessionId)}/takeover`);
  }

  returnToAutomation(sessionId: string) {
    return this.api.post(`/api/sessions/${encodeURIComponent(sessionId)}/return-to-automation`);
  }

  stop(sessionId: string) {
    return this.api.post(`/api/sessions/${encodeURIComponent(sessionId)}/stop`);
  }

  session(sessionId: string): Session | undefined {
    return this.store.getState().sessions[sessionId];
  }
}

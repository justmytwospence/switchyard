import { type InteractionResponse, type UINode, validateUINode } from "@switchyard/protocol";
import { genericClaim } from "./generic.js";
import {
  type PiUiMethod,
  type PiUiRequest,
  type PiUiResponse,
  PiUiResponseSchema,
  responseFitsRequest,
} from "./pi-ui.js";
import type {
  AdapterContext,
  AdapterDiagnostic,
  AdapterSessionHost,
  AdapterStateStore,
  AdapterTier,
  AnswerMatcher,
  AnswerSource,
  Claim,
  ClaimResponse,
  CustomMessageInfo,
  LoadedAdapter,
  MaybePromise,
  QueuedStep,
  ServerAdapter,
  SessionEntryInfo,
  ToolEndEvent,
  ToolInfo,
  ToolStartEvent,
  ToolUpdateEvent,
} from "./types.js";

export const DEFAULT_HOOK_TIMEOUT_MS = 2000;

export class HookTimeoutError extends Error {
  constructor(ms: number) {
    super(`timed out after ${ms} ms`);
    this.name = "HookTimeoutError";
  }
}

/** Run `fn` (sync or async) with a timeout; sync throws become rejections. */
export async function withTimeout<T>(fn: () => MaybePromise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(fn),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new HookTimeoutError(ms)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isInteractionResponseError(err: unknown): boolean {
  return err instanceof Error && err.name === "InteractionResponseError";
}

/** A dialog shown to the user, with the claim that will map the answer. */
export interface ClaimedInteraction {
  kind: "claim";
  claim: Claim;
  /** null for the generic renderer. */
  adapterId: string | null;
  request: PiUiRequest;
}

/** A dialog answered from the user's earlier form (queueAnswers). */
export interface QueuedInteraction {
  kind: "queued";
  response: PiUiResponse;
  toolCallId: string;
  adapterId: string | null;
  request: PiUiRequest;
}

export type UiRequestOutcome = QueuedInteraction | ClaimedInteraction;

export type RespondOutcome =
  | { kind: "respond"; response: PiUiResponse; queued: number }
  | { kind: "reclaim"; claim: Claim; adapterId: null; request: PiUiRequest; reason: string };

export interface AdapterRuntimeStatus {
  adapterId: string;
  tier: AdapterTier;
  status: "active" | "disabled";
  detail: string | null;
}

type HookName = Exclude<keyof ServerAdapter, never>;

interface Entry {
  adapter: LoadedAdapter;
  id: string;
  ctx: AdapterContext;
  disabled: string | null;
}

interface QueueItem {
  adapterId: string | null;
  match: (req: PiUiRequest) => boolean;
  source: AnswerSource;
}

type CallResult<T> = { ok: true; value: T } | { ok: false };

function toMatcher(m: AnswerMatcher): (req: PiUiRequest) => boolean {
  if (typeof m === "function") return m;
  const methods: PiUiMethod[] | null =
    m.method === undefined ? null : Array.isArray(m.method) ? m.method : [m.method];
  return (req) =>
    (!methods || methods.includes(req.method)) &&
    (m.titleIncludes === undefined || req.title.includes(m.titleIncludes)) &&
    (m.titleStartsWith === undefined || req.title.startsWith(m.titleStartsWith));
}

function shapeMatcher(resp: PiUiResponse): (req: PiUiRequest) => boolean {
  if ("cancelled" in resp) return () => true;
  if ("confirmed" in resp) return (req) => req.method === "confirm";
  return (req) => req.method !== "confirm";
}

function isQueuedStep(x: PiUiResponse | QueuedStep): x is QueuedStep {
  return typeof x === "object" && x !== null && "match" in x && "response" in x;
}

function resolveSource(source: AnswerSource, req: PiUiRequest): PiUiResponse | undefined {
  const r = typeof source === "function" ? source(req) : source;
  if (r === undefined) return undefined;
  return PiUiResponseSchema.safeParse(r).success ? r : undefined;
}

/**
 * Adapter state for one live session: per-adapter contexts, hook dispatch in precedence order,
 * failure isolation and the queued-answer mechanics. Created by `AdapterRegistry.openSession`.
 */
export class AdapterSession {
  readonly sessionId: string;
  private readonly entries: Entry[];
  private readonly activeTools = new Map<string, ToolStartEvent>();
  private readonly queues = new Map<string, QueueItem[]>();
  private closed = false;

  constructor(
    adapters: readonly LoadedAdapter[],
    private readonly host: AdapterSessionHost,
    private readonly hookTimeoutMs = DEFAULT_HOOK_TIMEOUT_MS,
  ) {
    this.sessionId = host.sessionId;
    this.entries = adapters.map((adapter) => {
      const entry: Entry = {
        adapter,
        id: adapter.manifest.id,
        disabled: null,
        ctx: undefined as unknown as AdapterContext,
      };
      entry.ctx = this.makeContext(entry);
      return entry;
    });
  }

  // -------------------------------------------------------------------------
  // Host-facing API

  /** `tool_execution_start`: records the running tool call, then runs `onToolStart` hooks. */
  async onToolStart(e: ToolStartEvent): Promise<void> {
    this.activeTools.set(e.toolCallId, e);
    await this.callAll("onToolStart", e);
  }

  /** `tool_execution_update`: runs `onToolUpdate` hooks with the partial result. */
  async onToolUpdate(e: ToolUpdateEvent): Promise<void> {
    await this.callAll("onToolUpdate", e);
  }

  /** `tool_execution_end`: runs `onToolEnd` hooks, then expires answers queued for the call. */
  async onToolEnd(e: ToolEndEvent): Promise<void> {
    try {
      await this.callAll("onToolEnd", e);
    } finally {
      this.activeTools.delete(e.toolCallId);
      this.queues.delete(e.toolCallId);
    }
  }

  /** First adapter card for the tool, or undefined (clients keep their built-in tool view). */
  async toolCard(tool: ToolInfo): Promise<{ adapterId: string; node: UINode } | undefined> {
    for (const entry of this.enabled("toolCard")) {
      const r = await this.call(entry, "toolCard", [tool]);
      if (!r.ok || r.value === undefined || r.value === null) continue;
      try {
        return { adapterId: entry.id, node: validateUINode(r.value) };
      } catch (err) {
        this.disable(entry, "toolCard", `returned an invalid card: ${errorMessage(err)}`);
      }
    }
    return undefined;
  }

  /**
   * A Pi dialog request. Returns a queued answer when an earlier form already answered it,
   * otherwise the first adapter claim in precedence order, otherwise the generic claim.
   * Never answers on its own: a claim always waits for a human response.
   */
  async onUiRequest(req: PiUiRequest): Promise<UiRequestOutcome> {
    const queued = this.takeQueued(req);
    if (queued) return queued;

    for (const entry of this.enabled("claimInteraction")) {
      const r = await this.call(entry, "claimInteraction", [req]);
      if (!r.ok || r.value === undefined || r.value === null) continue;
      const claim = r.value;
      try {
        if (typeof claim.title !== "string") throw new Error("claim.title must be a string");
        if (typeof claim.toPiResponse !== "function") {
          throw new Error("claim.toPiResponse must be a function");
        }
        const presentation = validateUINode(claim.presentation);
        return {
          kind: "claim",
          claim: { ...claim, presentation, toPiResponse: claim.toPiResponse.bind(claim) },
          adapterId: entry.id,
          request: req,
        };
      } catch (err) {
        this.disable(entry, "claimInteraction", `returned an invalid claim: ${errorMessage(err)}`);
      }
    }
    return { kind: "claim", claim: genericClaim(req), adapterId: null, request: req };
  }

  /**
   * Map a human answer through its claim. Returns the response for the current dialog (and
   * queues any follow-up answers), or, when the adapter fails, a generic claim to show instead.
   * Throws InteractionResponseError when the answer itself is invalid for the claim.
   */
  async respond(claimed: ClaimedInteraction, resp: InteractionResponse): Promise<RespondOutcome> {
    const { request: req, adapterId } = claimed;
    const entry = adapterId === null ? null : this.entries.find((e) => e.id === adapterId);
    const fail = (reason: string): RespondOutcome => {
      if (!entry) throw new Error(`generic claim failed: ${reason}`);
      this.disable(entry, "toPiResponse", reason);
      return { kind: "reclaim", claim: genericClaim(req), adapterId: null, request: req, reason };
    };
    if (entry?.disabled) {
      return {
        kind: "reclaim",
        claim: genericClaim(req),
        adapterId: null,
        request: req,
        reason: `adapter ${entry.id} is disabled: ${entry.disabled}`,
      };
    }

    let out: ClaimResponse;
    try {
      out = await withTimeout(() => claimed.claim.toPiResponse(resp), this.hookTimeoutMs);
    } catch (err) {
      if (isInteractionResponseError(err)) throw err;
      return fail(errorMessage(err));
    }

    const steps =
      out && typeof out === "object" && "sequence" in out && Array.isArray(out.sequence)
        ? out.sequence
        : [out as PiUiResponse];
    if (steps.length === 0) return fail("toPiResponse returned an empty sequence");
    const [first, ...rest] = steps;
    let response: PiUiResponse | undefined;
    try {
      response = resolveSource(isQueuedStep(first) ? first.response : first, req);
    } catch (err) {
      return fail(errorMessage(err));
    }
    if (!response || !responseFitsRequest(req, response)) {
      return fail(
        `toPiResponse produced ${JSON.stringify(response)}, which does not fit the dialog`,
      );
    }

    if (rest.length > 0) {
      const owner = claimed.claim.ownerToolCallId ?? this.latestToolCallId();
      const items: QueueItem[] = rest.map((s) =>
        isQueuedStep(s)
          ? { adapterId, match: toMatcher(s.match), source: s.response }
          : { adapterId, match: shapeMatcher(s), source: s },
      );
      if (!this.enqueue(owner, items, adapterId)) return { kind: "respond", response, queued: 0 };
    }
    return { kind: "respond", response, queued: rest.length };
  }

  async onEntry(entry: SessionEntryInfo): Promise<void> {
    await this.callAll("onEntry", entry);
  }

  async onCustomMessage(m: CustomMessageInfo): Promise<void> {
    await this.callAll("onCustomMessage", m);
  }

  /** `setStatus`. True when some adapter reported that it presented the value. */
  async onStatus(key: string, text: string | undefined): Promise<boolean> {
    const results = await this.callAll("onStatus", key, text);
    return results.some((r) => r === true);
  }

  /** `setWidget` (string lines only in RPC mode). */
  async onWidget(key: string, lines: string[] | undefined): Promise<boolean> {
    const results = await this.callAll("onWidget", key, lines);
    return results.some((r) => r === true);
  }

  /** A validated adapter action from a client (panel action or web renderer). */
  async onAction(
    adapterId: string,
    actionId: string,
    payload: unknown,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const entry = this.entries.find((e) => e.id === adapterId);
    if (!entry) return { ok: false, reason: `unknown adapter ${adapterId}` };
    if (entry.disabled) return { ok: false, reason: `adapter ${adapterId} is disabled` };
    if (!entry.adapter.server.onAction) {
      return { ok: false, reason: `adapter ${adapterId} has no actions` };
    }
    const r = await this.call(entry, "onAction", [actionId, payload]);
    return r.ok ? { ok: true } : { ok: false, reason: entry.disabled ?? "action failed" };
  }

  /** Per-adapter active/disabled state for this session (tests and diagnostics). */
  statuses(): AdapterRuntimeStatus[] {
    return this.entries.map((e) => ({
      adapterId: e.id,
      tier: e.adapter.tier,
      status: e.disabled ? "disabled" : "active",
      detail: e.disabled,
    }));
  }

  /** Tool call ids with pending queued answers and their counts (for diagnostics/tests). */
  queuedAnswers(): Record<string, number> {
    return Object.fromEntries([...this.queues].map(([k, v]) => [k, v.length]));
  }

  activeToolCalls(): string[] {
    return [...this.activeTools.keys()];
  }

  close(): void {
    this.closed = true;
    this.queues.clear();
    this.activeTools.clear();
  }

  // -------------------------------------------------------------------------
  // Internals

  private latestToolCallId(): string | undefined {
    let last: string | undefined;
    for (const id of this.activeTools.keys()) last = id;
    return last;
  }

  private enqueue(owner: string | undefined, items: QueueItem[], adapterId: string | null) {
    if (!owner || !this.activeTools.has(owner)) {
      this.diag(
        "warning",
        adapterId,
        `Dropped ${items.length} queued answer(s): no running tool call owns them, so the follow-up questions will be shown instead.`,
      );
      return false;
    }
    const q = this.queues.get(owner) ?? [];
    q.push(...items);
    this.queues.set(owner, q);
    return true;
  }

  private takeQueued(req: PiUiRequest): QueuedInteraction | undefined {
    for (const [toolCallId, items] of this.queues) {
      const head = items[0];
      if (!head) {
        this.queues.delete(toolCallId);
        continue;
      }
      let matched = false;
      let response: PiUiResponse | undefined;
      try {
        matched = head.match(req);
        if (matched) response = resolveSource(head.source, req);
      } catch (err) {
        this.diag("warning", head.adapterId, `Queued answer matcher failed: ${errorMessage(err)}`);
        this.queues.delete(toolCallId);
        continue;
      }
      if (!matched) continue;
      if (!response || !responseFitsRequest(req, response)) {
        this.queues.delete(toolCallId);
        this.diag(
          "warning",
          head.adapterId,
          `Queued answers for tool call ${toolCallId} no longer fit Pi's dialog "${req.title.split("\n")[0]}"; the remaining questions will be shown instead.`,
        );
        continue;
      }
      items.shift();
      if (items.length === 0) this.queues.delete(toolCallId);
      return { kind: "queued", response, toolCallId, adapterId: head.adapterId, request: req };
    }
    return undefined;
  }

  private enabled(hook: HookName): Entry[] {
    return this.entries.filter((e) => !e.disabled && typeof e.adapter.server[hook] === "function");
  }

  private async callAll(hook: HookName, ...args: unknown[]): Promise<unknown[]> {
    const out: unknown[] = [];
    for (const entry of this.enabled(hook)) {
      const r = await this.call(entry, hook, args);
      if (r.ok) out.push(r.value);
    }
    return out;
  }

  private async call<K extends HookName>(
    entry: Entry,
    hook: K,
    args: unknown[],
  ): Promise<CallResult<Awaited<ReturnType<NonNullable<ServerAdapter[K]>>>>> {
    const server = entry.adapter.server;
    const fn = server[hook] as ((...a: unknown[]) => unknown) | undefined;
    if (!fn || entry.disabled || this.closed) return { ok: false };
    try {
      const value = await withTimeout(
        () => fn.apply(server, [...args, entry.ctx]),
        this.hookTimeoutMs,
      );
      return { ok: true, value: value as Awaited<ReturnType<NonNullable<ServerAdapter[K]>>> };
    } catch (err) {
      this.disable(entry, hook, errorMessage(err));
      return { ok: false };
    }
  }

  private disable(entry: Entry, where: string, reason: string) {
    if (entry.disabled) return;
    entry.disabled = `${where} failed: ${reason}`;
    for (const [id, items] of this.queues) {
      const kept = items.filter((i) => i.adapterId !== entry.id);
      if (kept.length === 0) this.queues.delete(id);
      else this.queues.set(id, kept);
    }
    this.diag(
      "error",
      entry.id,
      `Adapter ${entry.id} failed in ${where} (${reason}). It is disabled for this session; generic rendering is used instead.`,
    );
  }

  private diag(level: AdapterDiagnostic["level"], adapterId: string | null, message: string) {
    this.emit({ type: "diagnostic", sessionId: this.sessionId, adapterId, level, message });
  }

  private emit(effect: Parameters<AdapterSessionHost["emit"]>[0]) {
    try {
      this.host.emit(effect);
    } catch {
      // The host's sink must never take down adapter dispatch.
    }
  }

  private makeContext(entry: Entry): AdapterContext {
    const initial = this.host.initialState?.[entry.adapter.manifest.id] ?? {};
    const values = new Map<string, unknown>(Object.entries(initial));
    const live = () => !entry.disabled && !this.closed;
    const adapterId = entry.adapter.manifest.id;
    const state: AdapterStateStore = {
      get: <T>(key: string) => values.get(key) as T | undefined,
      set: (key, value) => {
        if (value === undefined) {
          state.delete(key);
          return;
        }
        const json = JSON.parse(JSON.stringify(value)) as unknown;
        values.set(key, json);
        if (live()) this.emit({ type: "state", adapterId, key, value: json });
      },
      delete: (key) => {
        if (!values.delete(key)) return;
        if (live()) this.emit({ type: "state", adapterId, key, value: undefined });
      },
      keys: () => [...values.keys()],
    };
    return {
      sessionId: this.sessionId,
      adapterId,
      state,
      setPanel: (slot, node, opts) => {
        const checked = node === null ? null : validateUINode(node);
        if (!live()) return;
        this.emit({
          type: "panel",
          adapterId,
          slot,
          title: opts?.title ?? slot,
          node: checked,
          webRenderer: entry.adapter.webRendererPath !== null,
          mobileFallback: opts?.mobileFallback ?? null,
          ...(opts && "state" in opts ? { state: opts.state } : {}),
        });
      },
      attention: (reason, summary) => {
        if (live()) this.emit({ type: "attention", adapterId, reason, summary });
      },
      linkSubagent: (link) => {
        if (live()) this.emit({ type: "subagent", adapterId, link: { ...link } });
      },
      queueAnswers: (matcher, responses, opts) => {
        if (!live() || responses.length === 0) return;
        const match = toMatcher(matcher);
        this.enqueue(
          opts?.toolCallId ?? this.latestToolCallId(),
          responses.map((source) => ({ adapterId, match, source })),
          adapterId,
        );
      },
      log: (level, message) => {
        if (live()) this.emit({ type: "log", adapterId, level, message });
      },
    };
  }
}

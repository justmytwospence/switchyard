/**
 * Switchyard terminal extension, loaded with `-e` into an interactive Pi that runs inside a
 * Switchyard terminal holder (a pty). It is the control channel the host uses instead of
 * `pi --mode rpc`: it answers the same JSONL commands (`prompt`, `steer`, `follow_up`, `abort`,
 * `get_state`, ...), forwards session events in RPC shape, and lets remote clients answer extension
 * dialogs while they are also shown in the terminal (whichever answer comes first wins).
 *
 * It connects to the holder's socket named by `SWITCHYARD_CONTROL_SOCKET`, imports only Node
 * built-ins, and never throws: without the variable it does nothing.
 *
 * Dialogs: every extension's `ctx.ui` is the same object, so replacing `select`, `confirm`,
 * `input` and `editor` on it routes all dialogs through the race below. When that object cannot be
 * patched, `remoteDialogs` is false and the host tells remote clients to answer in the terminal.
 *
 * Other extensions that draw a custom terminal dialog can also ask the same question as a
 * web-only dialog through `switchyard.remote-ui.v1` on `pi.events`; the first answer wins.
 */
import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { modelInfo } from "./pi-model.js";

const PATCHED = Symbol.for("switchyard.terminal");
const WRAPPED = Symbol.for("switchyard.terminal.wrapped");
const REMOTE_UI_CHANNEL = "switchyard.remote-ui.v1";

type Json = Record<string, unknown>;
type Body = { value?: string; confirmed?: boolean; cancelled?: boolean };

interface Pending {
  request: Json;
  onRemote(body: Body): void;
}

function messageText(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: any) => c?.type === "text" && typeof c.text === "string")
    .map((c: any) => c.text)
    .join("\n");
}

/** Pi's `toJsonEvent` for `message_update` (`dist/modes/json-event.js`). */
export function jsonMessageUpdate(event: any): Json {
  const aev = event?.assistantMessageEvent ?? {};
  let out: Json;
  if (aev.type === "toolcall_start") {
    const { partial, ...rest } = aev;
    const call = partial?.content?.[aev.contentIndex];
    out = { ...rest, id: call?.id, toolName: call?.name };
  } else if (aev && typeof aev === "object" && "partial" in aev) {
    const { partial: _p, ...rest } = aev;
    out = rest;
  } else {
    out = aev;
  }
  return { type: "message_update", usage: event?.message?.usage, assistantMessageEvent: out };
}

function addUsage(totals: { tokens: number; cost: number }, usage: any): void {
  if (!usage || typeof usage !== "object") return;
  if (typeof usage.totalTokens === "number") totals.tokens += usage.totalTokens;
  if (typeof usage.cost?.total === "number") totals.cost += usage.cost.total;
}

/** Token and cost totals over session entries, like Pi's `getSessionStats()`. */
export function sessionTotals(entries: any[]): { tokens: number; cost: number } {
  const totals = { tokens: 0, cost: 0 };
  for (const e of entries) {
    if (e?.type === "usage") addUsage(totals, e.usage);
    else if ((e?.type === "branch_summary" || e?.type === "compaction") && e.usage) {
      addUsage(totals, e.usage);
    } else if (e?.type === "message") {
      const m = e.message;
      if (m?.role === "assistant" || m?.role === "toolResult") addUsage(totals, m.usage);
    }
  }
  return totals;
}

export default function switchyardTerminal(pi: any): void {
  const socketPath = process.env.SWITCHYARD_CONTROL_SOCKET;
  if (!socketPath) return;

  let ctx: any = null;
  let completer: any = null;
  // Work that needs a command context (reload, plugin web views) runs inside a hidden command.
  const internal = new Map<string, (c: any) => Promise<void> | void>();
  const runInternal = (fn: (c: any) => Promise<void> | void): void => {
    const token = randomUUID();
    internal.set(token, fn);
    // Without expandPromptTemplates Pi sends the text to the model instead of running the command.
    pi.sendUserMessage(`/switchyard-internal ${token}`, { expandPromptTemplates: true });
  };
  try {
    pi.registerCommand?.("switchyard-internal", {
      description: "Used by Switchyard's web app",
      handler: async (args: string, c: any) => {
        const key = String(args ?? "").trim();
        const run = internal.get(key);
        internal.delete(key);
        await run?.(c);
      },
    });
  } catch {
    // an older Pi: no web views or reload
  }
  let remoteDialogs = false;
  let entryCount = 0;
  const pending = new Map<string, Pending>();
  const early: any[] = [];
  const queue = { steering: [] as string[], followUp: [] as string[] };
  let socket: Socket | null = null;
  let remoteBacked = 0;

  const send = (obj: unknown): void => {
    try {
      if (!socket || socket.destroyed) return;
      socket.write(`${JSON.stringify(obj)}\n`);
    } catch {
      // never throw into Pi
    }
  };

  const sendModelState = () =>
    send({
      type: "model_state",
      model: modelInfo(ctx?.model),
      thinkingLevel: ctx?.thinkingLevel ?? pi.getThinkingLevel?.() ?? null,
      scoped: (ctx?.scopedModels ?? [])
        .map((s: any) =>
          s?.model?.provider && s?.model?.id ? `${s.model.provider}/${s.model.id}` : null,
        )
        .filter(Boolean),
    });

  const sendQueue = () => send({ type: "queue_update", ...queue });

  /** Announce this session (and whether dialogs are remote-backed) to the host. */
  const hello = (): void => {
    if (!ctx) return;
    try {
      send({
        type: "extension_hello",
        pid: process.pid,
        remoteDialogs,
        sessionId: ctx.sessionManager.getSessionId(),
        sessionFile: ctx.sessionManager.getSessionFile() ?? null,
      });
    } catch {
      // never throw into Pi
    }
  };

  const flushEntries = () => {
    try {
      const entries = ctx?.sessionManager?.getEntries?.() ?? [];
      for (const entry of entries.slice(entryCount)) send({ type: "entry_appended", entry });
      entryCount = entries.length;
    } catch {
      // ignore
    }
  };

  // ---- dialogs ----

  const parseBody = (method: string, body: Body): unknown => {
    if (method === "confirm") return body.cancelled ? false : body.confirmed === true;
    return body.cancelled ? undefined : body.value;
  };

  const race = (
    ui: any,
    method: "select" | "confirm" | "input",
    orig: (...args: any[]) => Promise<unknown>,
    title: string,
    second: unknown,
    opts: any,
  ): Promise<unknown> => {
    if (opts?.signal?.aborted) return orig.call(ui, title, second, opts);
    const id = randomUUID();
    const ac = new AbortController();
    const signals = [ac.signal, opts?.signal].filter(Boolean) as AbortSignal[];
    const signal = signals.length > 1 ? AbortSignal.any(signals) : ac.signal;
    const extra =
      method === "select"
        ? { options: second }
        : method === "confirm"
          ? { message: second }
          : { placeholder: second };
    const request: Json = {
      type: "extension_ui_request",
      id,
      method,
      title,
      ...extra,
      ...(opts?.timeout ? { timeout: opts.timeout } : {}),
    };
    return new Promise((resolve) => {
      let done = false;
      const finish = (value: unknown) => {
        if (done) return;
        done = true;
        pending.delete(id);
        resolve(value);
      };
      pending.set(id, {
        request,
        onRemote: (body) => {
          const value = parseBody(method, body);
          ac.abort();
          finish(value);
        },
      });
      send(request);
      Promise.resolve()
        .then(() => orig.call(ui, title, second, { ...(opts ?? {}), signal }))
        .then(
          (value) => {
            if (ac.signal.aborted) return;
            send({
              type: "extension_ui_closed",
              id,
              by: opts?.signal?.aborted ? "pi" : "terminal",
            });
            finish(value);
          },
          () => {
            if (ac.signal.aborted) return;
            send({ type: "extension_ui_closed", id, by: "terminal" });
            finish(method === "confirm" ? false : undefined);
          },
        );
    });
  };

  const raceEditor = (
    ui: any,
    orig: (...args: any[]) => Promise<unknown>,
    title: string,
    prefill: unknown,
  ): Promise<unknown> => {
    const id = randomUUID();
    const request: Json = {
      type: "extension_ui_request",
      id,
      method: "editor",
      title,
      ...(prefill !== undefined ? { prefill } : {}),
    };
    return new Promise((resolve) => {
      let done = false;
      let remote = false;
      const finish = (value: unknown) => {
        if (done) return;
        done = true;
        pending.delete(id);
        resolve(value);
      };
      pending.set(id, {
        request,
        onRemote: (body) => {
          remote = true;
          // The terminal editor takes no abort signal: dismiss it with Esc.
          send({ type: "holder_keys", data: "\u001b" });
          finish(parseBody("editor", body));
        },
      });
      send(request);
      Promise.resolve()
        .then(() => orig.call(ui, title, prefill))
        .then(
          (value) => {
            if (remote) return;
            send({ type: "extension_ui_closed", id, by: "terminal" });
            finish(value);
          },
          () => {
            if (remote) return;
            send({ type: "extension_ui_closed", id, by: "terminal" });
            finish(undefined);
          },
        );
    });
  };

  /** A dialog shown only to remote clients (the caller shows its own in the terminal). */
  const remoteOnly = (
    method: "select" | "confirm" | "input" | "editor",
    title: string,
    fields: Json,
    signal?: AbortSignal,
  ): Promise<any> => {
    const dflt = method === "confirm" ? false : undefined;
    if (signal?.aborted) return Promise.resolve(dflt);
    const id = randomUUID();
    const request: Json = { type: "extension_ui_request", id, method, title, ...fields };
    return new Promise((resolve) => {
      let done = false;
      const onAbort = () => {
        send({
          type: "extension_ui_closed",
          id,
          by: signal?.reason === "pi" ? "pi" : "terminal",
        });
        finish(dflt);
      };
      const finish = (value: unknown) => {
        if (done) return;
        done = true;
        remoteBacked--;
        pending.delete(id);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      remoteBacked++;
      pending.set(id, { request, onRemote: (body) => finish(parseBody(method, body)) });
      signal?.addEventListener("abort", onAbort, { once: true });
      send(request);
    });
  };

  const remoteUi = {
    select: (title: string, options: string[], opts?: { signal?: AbortSignal }) =>
      remoteOnly("select", title, { options }, opts?.signal),
    confirm: (title: string, message: string, opts?: { signal?: AbortSignal }) =>
      remoteOnly("confirm", title, { message }, opts?.signal),
    input: (title: string, placeholder?: string, opts?: { signal?: AbortSignal }) =>
      remoteOnly("input", title, placeholder !== undefined ? { placeholder } : {}, opts?.signal),
    editor: (title: string, prefill?: string, opts?: { signal?: AbortSignal }) =>
      remoteOnly("editor", title, prefill !== undefined ? { prefill } : {}, opts?.signal),
  };

  const fire = (method: string, fields: Json) =>
    send({ type: "extension_ui_request", id: randomUUID(), method, ...fields });

  const patchUi = (c: any): void => {
    try {
      const ui = c.ui;
      if (!ui || typeof ui !== "object") {
        remoteDialogs = false;
        return;
      }
      if (ui[PATCHED]) {
        remoteDialogs = c.ui.select === ui.select && ui.select?.[WRAPPED] === true;
        return;
      }
      const wrap = (fn: (...args: any[]) => unknown) => {
        (fn as any)[WRAPPED] = true;
        return fn;
      };
      for (const method of ["select", "confirm", "input"] as const) {
        const orig = ui[method];
        if (typeof orig !== "function") continue;
        ui[method] = wrap((title: string, second: unknown, opts: any) =>
          race(ui, method, orig, title, second, opts),
        );
      }
      const origEditor = ui.editor;
      if (typeof origEditor === "function") {
        ui.editor = wrap((title: string, prefill: unknown) =>
          raceEditor(ui, origEditor, title, prefill),
        );
      }
      const origNotify = ui.notify;
      if (typeof origNotify === "function") {
        ui.notify = (message: string, type?: string) => {
          const r = origNotify.call(ui, message, type);
          fire("notify", { message, notifyType: type });
          return r;
        };
      }
      const origStatus = ui.setStatus;
      if (typeof origStatus === "function") {
        ui.setStatus = (key: string, text: string | undefined) => {
          const r = origStatus.call(ui, key, text);
          fire("setStatus", { statusKey: key, statusText: text });
          return r;
        };
      }
      const origWidget = ui.setWidget;
      if (typeof origWidget === "function") {
        ui.setWidget = (key: string, content: unknown, options?: any) => {
          const r = origWidget.call(ui, key, content, options);
          if (content === undefined || Array.isArray(content)) {
            fire("setWidget", {
              widgetKey: key,
              widgetLines: content,
              widgetPlacement: options?.placement,
            });
          }
          return r;
        };
      }
      const origTitle = ui.setTitle;
      if (typeof origTitle === "function") {
        ui.setTitle = (title: string) => {
          const r = origTitle.call(ui, title);
          fire("setTitle", { title });
          return r;
        };
      }
      Object.defineProperty(ui, PATCHED, { value: true });
      remoteDialogs = c.ui.select === ui.select && ui.select?.[WRAPPED] === true;
    } catch {
      remoteDialogs = false;
    }
  };

  // ---- commands ----

  const content = (message: string, images: any): unknown => {
    if (!Array.isArray(images) || images.length === 0) return message;
    return [
      { type: "text", text: message },
      ...images.map((i: any) => ({ type: "image", data: i.data, mimeType: i.mimeType })),
    ];
  };

  const respond = (id: unknown, command: string, data?: unknown, error?: string) => {
    if (error !== undefined) send({ type: "response", id, command, success: false, error });
    else if (data === undefined) send({ type: "response", id, command, success: true });
    else send({ type: "response", id, command, success: true, data });
  };

  const handleCommand = (cmd: any): void => {
    const id = cmd.id;
    const type = String(cmd.type);
    if (!ctx) {
      // Commands that arrive before the session started run once it has.
      early.push(cmd);
      return;
    }
    try {
      switch (type) {
        case "get_state":
          respond(id, type, {
            sessionId: ctx.sessionManager.getSessionId(),
            sessionFile: ctx.sessionManager.getSessionFile() ?? null,
            sessionName: pi.getSessionName?.() ?? null,
            isStreaming: !ctx.isIdle(),
            model: modelInfo(ctx.model),
            thinkingLevel: ctx.thinkingLevel ?? pi.getThinkingLevel?.() ?? null,
            pendingMessageCount: ctx.hasPendingMessages() ? 1 : 0,
          });
          return;
        case "prompt": {
          const message = String(cmd.message ?? "");
          if (message.startsWith("/")) {
            const name = message.slice(1).split(/\s/)[0];
            const known = (pi.getCommands?.() ?? []).find((c: any) => c.name === name);
            if (known?.source === "extension") {
              const args = message.slice(1 + name.length).trim();
              const probe: any = { version: 1, name, args, probe: true };
              try {
                pi.events?.emit?.("switchyard.web-command.v1", probe);
              } catch {
                // no web view
              }
              if (probe.accept === true) {
                runInternal(async (c) => {
                  const req: any = { version: 1, name, args, probe: false, ctx: c };
                  try {
                    pi.events.emit("switchyard.web-command.v1", req);
                    const view = await Promise.race([
                      Promise.resolve(req.view),
                      new Promise((_, rej) => setTimeout(() => rej(new Error("timed out")), 15000)),
                    ]);
                    if (!view) throw new Error(`/${name} returned no view`);
                    respond(id, type, { disposition: "view", view });
                  } catch (e: any) {
                    respond(id, type, undefined, `/${name} failed: ${e?.message ?? e}`);
                  }
                });
                return;
              }
              pi.sendUserMessage(message, { expandPromptTemplates: true });
              respond(id, type, { disposition: "handled" });
              return;
            }
            if (known) {
              if (!ctx.isIdle()) {
                respond(id, type, undefined, "Session is running: choose Steer or Queue follow-up");
                return;
              }
              pi.sendUserMessage(content(message, cmd.images), { expandPromptTemplates: true });
              respond(id, type, { disposition: "started" });
              return;
            }
          }
          if (!ctx.isIdle()) {
            respond(id, type, undefined, "Session is running: choose Steer or Queue follow-up");
            return;
          }
          pi.sendUserMessage(content(message, cmd.images));
          respond(id, type, { disposition: "started" });
          return;
        }
        case "steer":
        case "follow_up": {
          const message = String(cmd.message ?? "");
          const idle = ctx.isIdle();
          pi.sendUserMessage(content(message, cmd.images), {
            deliverAs: type === "steer" ? "steer" : "followUp",
          });
          if (!idle) {
            (type === "steer" ? queue.steering : queue.followUp).push(message);
            sendQueue();
          }
          respond(id, type, { disposition: idle ? "started" : "queued" });
          return;
        }
        case "abort":
          ctx.abort();
          respond(id, type);
          return;
        case "clear_queue":
          respond(id, type, { steering: [], followUp: [] });
          return;
        case "set_session_name": {
          const name = String(cmd.name ?? "").trim();
          if (!name) {
            respond(id, type, undefined, "Session name cannot be empty");
            return;
          }
          pi.setSessionName(name);
          respond(id, type);
          return;
        }
        case "get_session_stats": {
          const totals = sessionTotals(ctx.sessionManager.getEntries());
          respond(id, type, {
            tokens: { total: totals.tokens },
            cost: totals.cost,
            contextUsage: ctx.getContextUsage?.() ?? undefined,
          });
          return;
        }
        case "get_available_models":
          respond(id, type, {
            models: (ctx.modelRegistry?.getAvailable?.() ?? []).map(modelInfo).filter(Boolean),
          });
          return;
        case "get_commands":
          respond(id, type, {
            commands: (pi.getCommands?.() ?? [])
              .filter((c: any) => c.name !== "switchyard-internal")
              .map((c: any) => ({
                name: c.name,
                description: c.description ?? null,
                source: c.source,
                sourceInfo: c.sourceInfo ?? null,
              })),
          });
          return;
        case "set_model": {
          const provider = String(cmd.provider ?? "");
          const modelId = String(cmd.modelId ?? "");
          const model = ctx.modelRegistry?.find?.(provider, modelId);
          if (!model) {
            respond(id, type, undefined, `Model not found: ${provider}/${modelId}`);
            return;
          }
          Promise.resolve(pi.setModel(model)).then(
            (ok) => {
              if (ok === false)
                respond(id, type, undefined, `No API key for ${provider}/${modelId}`);
              else respond(id, type, modelInfo(ctx.model));
            },
            (err) => respond(id, type, undefined, err instanceof Error ? err.message : String(err)),
          );
          return;
        }
        case "set_thinking_level":
          pi.setThinkingLevel(String(cmd.level));
          respond(id, type);
          return;
        case "compact":
          if (!ctx.isIdle()) {
            respond(
              id,
              type,
              undefined,
              "Session is running: wait for it to finish before compacting",
            );
            return;
          }
          ctx.compact({
            customInstructions:
              typeof cmd.customInstructions === "string" && cmd.customInstructions
                ? cmd.customInstructions
                : undefined,
            onComplete: () => {},
            onError: () => {},
          });
          respond(id, type, { started: true });
          return;
        case "shutdown":
          respond(id, type);
          setImmediate(() => {
            try {
              ctx.shutdown();
            } catch {
              // ignore
            }
          });
          return;
        case "reload":
          if (!ctx) {
            respond(id, type, undefined, "Session is not ready");
            return;
          }
          respond(id, type);
          runInternal((c) => c.reload());
          return;
        case "complete": {
          const text = String(cmd.text ?? "");
          if (!completer?.getSuggestions || !/^\/\S+ /.test(text) || text.includes("\n")) {
            respond(id, type, { items: [], prefix: "" });
            return;
          }
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(), 2000);
          Promise.resolve(completer.getSuggestions([text], 0, text.length, { signal: ac.signal }))
            .then((s: any) =>
              respond(id, type, {
                items: (Array.isArray(s?.items) ? s.items : [])
                  .filter((i: any) => typeof i?.value === "string")
                  .slice(0, 50)
                  .map((i: any) => ({
                    value: i.value,
                    label: typeof i.label === "string" ? i.label : i.value,
                    description: typeof i.description === "string" ? i.description : null,
                  })),
                prefix: typeof s?.prefix === "string" ? s.prefix : "",
              }),
            )
            .catch(() => respond(id, type, { items: [], prefix: "" }))
            .finally(() => clearTimeout(timer));
          return;
        }
        default:
          respond(id, type, undefined, `Unknown command: ${type}`);
      }
    } catch (err) {
      respond(id, type, undefined, err instanceof Error ? err.message : String(err));
    }
  };

  /** Tell a (re)attached controller who we are, then re-send the dialogs it has not answered. */
  const announce = (): void => {
    if (ctx) {
      hello();
      sendModelState();
      sendQueue();
    }
    for (const p of pending.values()) send(p.request);
  };

  const onLine = (line: string): void => {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "extension_ui_response") {
      pending.get(String(msg.id))?.onRemote(msg as Body);
      return;
    }
    if (msg.type === "control_attached") {
      // A controller re-attached (host agent restart): it starts from scratch, so announce the
      // session again before re-sending the dialogs it has not answered.
      announce();
      return;
    }
    if (typeof msg.type === "string" && msg.id !== undefined) handleCommand(msg);
  };

  // ---- socket ----

  // The holder listens before it starts Pi, but retry a few times anyway (a slow or restarting holder).
  const CONNECT_ATTEMPTS = 5;
  const CONNECT_RETRY_MS = 200;
  const connect = (attempt: number): void => {
    let s: Socket;
    try {
      s = createConnection(socketPath);
    } catch {
      socket = null;
      return;
    }
    socket = s;
    let connected = false;
    let buf = "";
    s.setEncoding("utf8");
    s.on("data", (chunk: string) => {
      buf += chunk;
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line) onLine(line);
        nl = buf.indexOf("\n");
      }
    });
    s.once("connect", () => {
      connected = true;
      if (attempt > 1) announce();
    });
    s.on("error", () => {
      if (socket === s) socket = null;
    });
    s.on("close", () => {
      if (socket === s) socket = null;
      if (!connected && attempt < CONNECT_ATTEMPTS) {
        setTimeout(() => connect(attempt + 1), CONNECT_RETRY_MS).unref();
      }
    });
    s.unref();
    s.write(`${JSON.stringify({ role: "extension" })}\n`);
  };
  connect(1);

  try {
    pi.events?.on?.(REMOTE_UI_CHANNEL, (data: unknown) => {
      const r = data as { version?: number; ui?: unknown; provider?: string } | undefined;
      if (r?.version !== 1 || r.ui || !socket) return;
      r.ui = remoteUi;
      r.provider = "switchyard";
    });
  } catch {
    // optional service
  }

  // ---- events ----

  const on = (name: string, fn: (event: any, c: any) => void) => {
    try {
      pi.on(name, (event: any, c: any) => {
        try {
          fn(event, c);
        } catch {
          // never throw into Pi
        }
      });
    } catch {
      // ignore
    }
  };

  on("session_start", (event, c) => {
    ctx = c;
    patchUi(c);
    completer = null;
    try {
      c.ui?.addAutocompleteProvider?.((current: any) => {
        completer = current;
        return current;
      });
    } catch {
      // RPC or an older Pi: no completions
    }
    entryCount = c.sessionManager.getEntries().length;
    const sessionId = c.sessionManager.getSessionId();
    const sessionFile = c.sessionManager.getSessionFile() ?? null;
    hello();
    sendModelState();
    if (event?.reason && event.reason !== "startup") {
      send({ type: "switchyard_native", sessionId, sessionFile });
    }
    for (const cmd of early.splice(0)) handleCommand(cmd);
  });

  for (const name of [
    "agent_start",
    "message_start",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
    "session_info_changed",
  ]) {
    on(name, (event) => send(event));
  }
  on("message_start", (event) => {
    if (event?.message?.role !== "user") return;
    const text = messageText(event.message);
    for (const list of [queue.steering, queue.followUp]) {
      const i = list.indexOf(text);
      if (i >= 0) {
        list.splice(i, 1);
        sendQueue();
        return;
      }
    }
  });
  on("message_update", (event) => send(jsonMessageUpdate(event)));
  on("message_end", (event) => {
    send(event);
    flushEntries();
  });
  on("turn_end", () => flushEntries());
  on("agent_settled", (event) => {
    send({ type: "agent_settled", aborted: event?.aborted === true });
    flushEntries();
    if (queue.steering.length > 0 || queue.followUp.length > 0) {
      queue.steering = [];
      queue.followUp = [];
      sendQueue();
    }
  });
  on("session_compact", () => {
    send({ type: "compaction_end", result: true });
    flushEntries();
  });
  on("session_compact_failed", (event) =>
    send({
      type: "compaction_end",
      result: null,
      aborted: event?.aborted === true,
      errorMessage: event?.errorMessage ?? "unknown error",
    }),
  );
  on("model_select", () => sendModelState());
  on("thinking_level_select", () => sendModelState());
  on("session_before_compact", (event) =>
    send({ type: "compaction_start", reason: event?.reason ?? "manual" }),
  );
  on("ui_prompt_start", (event) =>
    send({
      type: "ui_prompt",
      event: event.type,
      kind: event.kind,
      title: event.title ?? null,
      remoteBacked: event.kind === "custom" && remoteBacked > 0,
    }),
  );
  on("ui_prompt_end", (event) =>
    send({ type: "ui_prompt", event: event.type, kind: event.kind, title: event.title ?? null }),
  );
  on("input", (event) => {
    if (event?.source !== "interactive" || !event.streamingBehavior) return;
    (event.streamingBehavior === "steer" ? queue.steering : queue.followUp).push(
      String(event.text ?? ""),
    );
    sendQueue();
  });
}

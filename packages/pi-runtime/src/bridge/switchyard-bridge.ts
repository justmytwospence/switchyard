/**
 * Switchyard bridge extension, loaded into every managed Pi with `-e`.
 *
 * Forwards `ui_prompt_start` / `ui_prompt_end` (kinds select|confirm|input|editor|custom) as JSON
 * lines over the Unix socket named by `SWITCHYARD_BRIDGE_SOCKET`. This reveals terminal-only
 * `ctx.ui.custom()` calls (which RPC mode answers with `undefined`) and dialogs that Pi resolved
 * itself (timeout or abort). It imports only Node built-ins, is a no-op without the variable, and
 * never throws: any socket error disables forwarding for the rest of the process.
 */
import { createConnection, type Socket } from "node:net";
import { modelInfo } from "./pi-model.js";

export interface BridgeMessage {
  type: "hello" | "ui_prompt_start" | "ui_prompt_end" | "model_state";
  model?: unknown;
  thinkingLevel?: string | null;
  kind?: string;
  title?: string | null;
  seq: number;
  at: string;
  pid: number;
}

export default function switchyardBridge(pi: any): void {
  const socketPath = process.env.SWITCHYARD_BRIDGE_SOCKET;
  if (!socketPath) return;

  let socket: Socket | null = null;
  let disabled = false;
  let seq = 0;

  const ensureSocket = (): Socket | null => {
    if (disabled) return null;
    if (socket) return socket;
    try {
      const s = createConnection(socketPath);
      s.on("error", () => {
        disabled = true;
        try {
          s.destroy();
        } catch {
          // ignore
        }
      });
      s.on("close", () => {
        // A clean close (session_shutdown) allows a later reconnect; errors disabled us above.
        if (socket === s) socket = null;
      });
      s.unref();
      socket = s;
      send(s, { type: "hello" });
      return s;
    } catch {
      disabled = true;
      return null;
    }
  };

  const send = (
    s: Socket,
    msg: { type: BridgeMessage["type"]; kind?: string; title?: string },
    extra: Record<string, unknown> = {},
  ) => {
    const full: BridgeMessage = {
      ...extra,
      type: msg.type,
      ...(msg.kind !== undefined ? { kind: msg.kind } : {}),
      title: msg.title ?? null,
      seq: ++seq,
      at: new Date().toISOString(),
      pid: process.pid,
    };
    try {
      s.write(`${JSON.stringify(full)}\n`);
    } catch {
      disabled = true;
    }
  };

  const forward = (event: any) => {
    try {
      const s = ensureSocket();
      if (!s) return;
      send(s, {
        type: event?.type === "ui_prompt_end" ? "ui_prompt_end" : "ui_prompt_start",
        kind: typeof event?.kind === "string" ? event.kind : "unknown",
        title: typeof event?.title === "string" ? event.title : undefined,
      });
    } catch {
      disabled = true;
    }
  };

  const sendModelState = (ctx: any) => {
    try {
      const s = ensureSocket();
      if (!s) return;
      send(
        s,
        { type: "model_state" },
        {
          model: modelInfo(ctx?.model),
          thinkingLevel: ctx?.thinkingLevel ?? null,
          scoped: (ctx?.scopedModels ?? [])
            .map((s: any) =>
              s?.model?.provider && s?.model?.id ? `${s.model.provider}/${s.model.id}` : null,
            )
            .filter(Boolean),
        },
      );
    } catch {
      disabled = true;
    }
  };

  try {
    pi.on("session_start", (_event: any, ctx: any) => {
      try {
        ensureSocket();
      } catch {
        disabled = true;
      }
      sendModelState(ctx);
    });
    pi.on("model_select", (_event: any, ctx: any) => sendModelState(ctx));
    pi.on("thinking_level_select", (_event: any, ctx: any) => sendModelState(ctx));
    pi.on("ui_prompt_start", forward);
    pi.on("ui_prompt_end", forward);
    pi.on("session_shutdown", () => {
      try {
        socket?.end();
      } catch {
        // ignore
      }
      socket = null;
    });
  } catch {
    disabled = true;
  }
}

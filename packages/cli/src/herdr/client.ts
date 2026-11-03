import { existsSync, readdirSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Env } from "../paths.js";

/** The herdr socket is missing, refused, timed out, or answered garbage. */
export class HerdrUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HerdrUnavailable";
  }
}

/** herdr answered with an error. */
export class HerdrError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "HerdrError";
  }
}

/**
 * `HERDR_SOCKET_PATH` (set in herdr panes and plugin hooks), else `HERDR_SESSION`'s socket, else
 * the default server's, else the only named session's.
 */
export function herdrSocketPath(env: Env = process.env, home = homedir()): string {
  if (env.HERDR_SOCKET_PATH) return env.HERDR_SOCKET_PATH;
  const base = join(home, ".config", "herdr");
  if (env.HERDR_SESSION) return join(base, "sessions", env.HERDR_SESSION, "herdr.sock");
  const dflt = join(base, "herdr.sock");
  if (existsSync(dflt)) return dflt;
  let live: string[] = [];
  try {
    live = readdirSync(join(base, "sessions"))
      .map((s) => join(base, "sessions", s, "herdr.sock"))
      .filter((p) => existsSync(p));
  } catch {
    live = [];
  }
  return live.length === 1 ? live[0]! : dflt;
}

export type HerdrCall = (method: string, params: Record<string, unknown>) => Promise<any>;

/** One JSON request line, one JSON reply line, over herdr's socket API. */
export function herdrCall(
  method: string,
  params: Record<string, unknown>,
  socketPath: string = herdrSocketPath(),
  timeoutMs = 5000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const s = createConnection(socketPath);
    let buf = "";
    const timer = setTimeout(() => {
      s.destroy();
      reject(new HerdrUnavailable(`herdr did not answer ${method}`));
    }, timeoutMs);
    s.setEncoding("utf8");
    s.on("connect", () => {
      s.write(
        `${JSON.stringify({ id: `switchyard:${method}:${process.hrtime.bigint()}`, method, params })}\n`,
      );
    });
    s.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      clearTimeout(timer);
      s.destroy();
      let reply: any;
      try {
        reply = JSON.parse(buf.slice(0, nl));
      } catch (err) {
        reject(new HerdrUnavailable(`unreadable reply: ${(err as Error).message}`));
        return;
      }
      if (reply?.error) {
        reject(
          new HerdrError(String(reply.error.code ?? "error"), String(reply.error.message ?? "")),
        );
        return;
      }
      resolve(reply?.result ?? {});
    });
    s.on("error", (err) => {
      clearTimeout(timer);
      reject(new HerdrUnavailable(err.message));
    });
  });
}

/** The herdr session a process belongs to, from the launcher, the socket path or HERDR_SESSION. */
export function herdrSessionName(env: Env = process.env): string {
  if (env.SWITCHYARD_HERDR_SESSION) return env.SWITCHYARD_HERDR_SESSION;
  const m = env.HERDR_SOCKET_PATH?.match(/\/sessions\/([^/]+)\/herdr\.sock$/);
  if (m) return m[1]!;
  if (env.HERDR_SESSION) return env.HERDR_SESSION;
  return "default";
}

export interface HerdrSubscription {
  close(): void;
}

/**
 * A long-lived `events.subscribe` connection. `onEvent` gets each pushed event's `data`
 * (`{type: "tab_closed", ...}`); `onEnd` reports the connection ending (an error code or "closed").
 */
export function herdrSubscribe(
  types: string[],
  onEvent: (data: { type: string; [k: string]: unknown }) => void,
  onEnd: (reason: string) => void,
  socketPath: string = herdrSocketPath(),
): HerdrSubscription {
  const s = createConnection(socketPath);
  let closed = false;
  const end = (reason: string) => {
    if (closed) return;
    closed = true;
    s.destroy();
    onEnd(reason);
  };
  let buf = "";
  s.setEncoding("utf8");
  s.on("connect", () => {
    s.write(
      `${JSON.stringify({
        id: `switchyard:subscribe:${process.hrtime.bigint()}`,
        method: "events.subscribe",
        params: { subscriptions: types.map((type) => ({ type })) },
      })}\n`,
    );
  });
  s.on("data", (chunk: string) => {
    buf += chunk;
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg?.error) {
        end(String(msg.error.code ?? "error"));
        return;
      }
      const data = msg?.data ?? msg?.result?.event?.data;
      if (data && typeof data === "object" && typeof data.type === "string") onEvent(data);
    }
  });
  s.on("error", () => end("closed"));
  s.on("close", () => end("closed"));
  return {
    close() {
      closed = true;
      s.destroy();
    },
  };
}

let lastSeq = 0;

/** A strictly increasing report sequence number, also across processes (time based). */
export function nextSeq(): number {
  lastSeq = Math.max(lastSeq + 1, Date.now() * 1000);
  return lastSeq;
}

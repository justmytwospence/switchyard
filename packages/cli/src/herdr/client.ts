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

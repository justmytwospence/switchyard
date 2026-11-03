import { TermServerToViewer } from "@switchyard/protocol";
import WebSocket from "ws";

/** Ctrl+]: leaves the terminal; the session keeps running. */
export const DETACH_KEY = 0x1d;

/**
 * Written when leaving, so modes Pi switched on in this terminal do not linger: pop Kitty keyboard
 * flags, bracketed paste off, mouse reporting off, leave the alternate screen, reset attributes,
 * show the cursor.
 */
export const TERMINAL_RESET =
  "\x1b[<u\x1b[?2004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1049l\x1b[0m\x1b[?25h";

/** `http(s)://host/base` -> `ws(s)://host/base/ws/terminal/<id>?cols=&rows=`. */
export function terminalWsUrl(
  coordinatorUrl: string,
  sessionId: string,
  cols: number,
  rows: number,
): string {
  const u = new URL(coordinatorUrl.replace(/\/+$/, ""));
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = `${u.pathname.replace(/\/+$/, "")}/ws/terminal/${encodeURIComponent(sessionId)}`;
  u.search = `?cols=${cols}&rows=${rows}`;
  u.hash = "";
  return u.toString();
}

export interface RawTerminalOptions {
  coordinatorUrl: string;
  credential: string | null;
  sessionId: string;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  WebSocketImpl?: typeof WebSocket;
}

export type RawTerminalResult = { reason: "detached" } | { reason: "closed"; message: string };

/**
 * Attach this terminal to a session's Pi terminal through the coordinator: raw keystrokes in,
 * Pi's screen out. Ctrl+] detaches.
 */
export function runRawTerminal(opts: RawTerminalOptions): Promise<RawTerminalResult> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  if (!stdin.isTTY) {
    return Promise.reject(new Error("switchyard tui needs an interactive terminal"));
  }
  const cols = Math.min(1000, Math.max(10, stdout.columns || 80));
  const rows = Math.min(500, Math.max(5, stdout.rows || 24));
  const Impl = opts.WebSocketImpl ?? WebSocket;
  const headers: Record<string, string> = {};
  if (opts.credential) headers.authorization = `Bearer ${opts.credential}`;

  return new Promise<RawTerminalResult>((resolve) => {
    const ws = new Impl(terminalWsUrl(opts.coordinatorUrl, opts.sessionId, cols, rows), {
      headers,
    });
    let opened = false;
    let done = false;

    const onInput = (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      const i = buf.indexOf(DETACH_KEY);
      if (i >= 0) {
        if (i > 0) send({ t: "in", d: buf.subarray(0, i).toString("base64") });
        finish({ reason: "detached" });
        return;
      }
      send({ t: "in", d: buf.toString("base64") });
    };
    const onResize = () => {
      send({
        t: "resize",
        cols: Math.min(1000, Math.max(10, stdout.columns || 80)),
        rows: Math.min(500, Math.max(5, stdout.rows || 24)),
      });
    };
    const send = (msg: unknown) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };
    const finish = (result: RawTerminalResult) => {
      if (done) return;
      done = true;
      stdin.off("data", onInput);
      stdout.off("resize", onResize);
      if (opened) {
        try {
          stdin.setRawMode?.(false);
        } catch {
          // not a TTY anymore
        }
        stdin.pause();
        stdout.write(`${TERMINAL_RESET}\r\n`);
      }
      ws.removeAllListeners();
      ws.on("error", () => {});
      try {
        ws.close(1000, "detached");
      } catch {
        // not open
      }
      resolve(result);
    };

    ws.on("open", () => {
      opened = true;
      stdin.setRawMode?.(true);
      stdin.resume();
      stdin.on("data", onInput);
      stdout.on("resize", onResize);
    });
    ws.on("message", (raw) => {
      let json: unknown;
      try {
        json = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const msg = TermServerToViewer.safeParse(json);
      if (!msg.success) return;
      if (msg.data.t === "out") stdout.write(Buffer.from(msg.data.d, "base64"));
      else finish({ reason: "closed", message: msg.data.reason });
    });
    ws.on("unexpected-response", (_req, res) => {
      finish({
        reason: "closed",
        message:
          res.statusCode === 401
            ? "Not signed in to the coordinator (401)"
            : `The coordinator refused the terminal (HTTP ${res.statusCode})`,
      });
    });
    ws.on("error", (err) => {
      finish({ reason: "closed", message: `Cannot reach the coordinator: ${err.message}` });
    });
    ws.on("close", () => {
      finish({ reason: "closed", message: "Connection to the coordinator was lost" });
    });
  });
}

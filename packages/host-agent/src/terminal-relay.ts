import { createConnection, type Socket } from "node:net";
import { JsonlReader } from "@switchyard/pi-runtime";
import { type TermCoordinatorMsg, TermServerToViewer } from "@switchyard/protocol";
import type { Logger } from "./logger.js";
import type { SessionSupervisor } from "./supervisor.js";

export const NO_TERMINAL =
  "This session has no terminal: it is not running, or its host does not run terminal sessions";
export const TERMINAL_CLOSED = "Terminal closed";

export interface TerminalRelayOptions {
  supervisor: Pick<SessionSupervisor, "record" | "isLive">;
  send: (streamId: string, msg: TermServerToViewer) => void;
  log: Logger;
}

/**
 * Pipes coordinator terminal streams to the sessions' terminal holders: one viewer connection to
 * the holder per stream.
 */
export class TerminalRelay {
  private readonly streams = new Map<string, { socket: Socket; closed: boolean }>();

  constructor(private readonly opts: TerminalRelayOptions) {}

  handle(streamId: string, msg: TermCoordinatorMsg): void {
    switch (msg.t) {
      case "open":
        this.open(streamId, msg.sessionId, msg.cols, msg.rows);
        return;
      case "in":
      case "resize": {
        const s = this.streams.get(streamId);
        if (s && !s.socket.destroyed) s.socket.write(`${JSON.stringify(msg)}\n`);
        return;
      }
      case "close": {
        const s = this.streams.get(streamId);
        this.streams.delete(streamId);
        if (s) {
          s.closed = true;
          s.socket.destroy();
        }
        return;
      }
    }
  }

  /** Drop every stream without telling the coordinator (the link is gone). */
  closeAll(): void {
    for (const s of this.streams.values()) {
      s.closed = true;
      s.socket.destroy();
    }
    this.streams.clear();
  }

  private open(streamId: string, sessionId: string, cols: number, rows: number): void {
    const existing = this.streams.get(streamId);
    if (existing) return;
    const rec = this.opts.supervisor.record(sessionId);
    if (!rec?.terminal || !this.opts.supervisor.isLive(sessionId)) {
      this.opts.send(streamId, { t: "closed", reason: NO_TERMINAL });
      return;
    }
    const socket = createConnection(rec.terminal.socketPath);
    const entry = { socket, closed: false };
    this.streams.set(streamId, entry);
    const end = (reason: string) => {
      if (entry.closed) return;
      entry.closed = true;
      if (this.streams.get(streamId) === entry) this.streams.delete(streamId);
      this.opts.send(streamId, { t: "closed", reason });
      socket.destroy();
    };
    socket.on("error", (err) => {
      this.opts.log.debug({ sessionId, err: err.message }, "terminal holder connection failed");
    });
    socket.on("close", () => end(TERMINAL_CLOSED));
    JsonlReader.attach(socket, (record) => {
      const parsed = TermServerToViewer.safeParse(record);
      if (!parsed.success) return;
      if (parsed.data.t === "closed") {
        end(parsed.data.reason);
        return;
      }
      if (!entry.closed) this.opts.send(streamId, parsed.data);
    });
    socket.write(`${JSON.stringify({ role: "viewer", cols, rows })}\n`);
  }
}

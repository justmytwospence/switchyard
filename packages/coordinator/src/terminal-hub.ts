import {
  newId,
  type TermCoordinatorMsg,
  type TermServerToViewer,
  TermViewerToServer,
} from "@switchyard/protocol";
import type { Logger } from "pino";
import type { WebSocket } from "ws";
import type { HostHub } from "./host-hub.js";
import type { Store } from "./store.js";

const WsOpen = 1;

interface Stream {
  socket: WebSocket;
  hostId: string;
}

/**
 * `/ws/terminal/:sessionId`: relays a viewer's terminal stream to the session's host (`term`
 * frames with a stream id) and the host's output back. Only hosts that announce the `terminal`
 * capability get these frames.
 */
export class TerminalHub {
  private readonly streams = new Map<string, Stream>();

  constructor(
    private readonly store: Store,
    private readonly hostHub: Pick<HostHub, "isConnected" | "sendTerm">,
    private readonly log: Logger,
  ) {}

  handleSocket(socket: WebSocket, sessionId: string, cols: number, rows: number): void {
    const refuse = (reason: string) => {
      this.sendTo(socket, { t: "closed", reason });
      socket.close(1000, "closed");
    };
    const session = this.store.sessions.get(sessionId);
    if (!session) {
      refuse("Session not found");
      return;
    }
    const host = this.store.hosts.get(session.hostId);
    if (host?.capabilities?.terminal !== true) {
      refuse("This session's host does not run terminal sessions");
      return;
    }
    if (!this.hostHub.isConnected(host.id)) {
      refuse(`Host ${host.name} is not connected`);
      return;
    }
    const streamId = newId("trm");
    this.streams.set(streamId, { socket, hostId: host.id });
    socket.on("message", (raw) => {
      let json: unknown;
      try {
        json = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const msg = TermViewerToServer.safeParse(json);
      if (msg.success) this.toHost(streamId, msg.data);
    });
    socket.on("close", () => {
      if (!this.streams.has(streamId)) return;
      this.streams.delete(streamId);
      this.toHost(streamId, { t: "close" }, host.id);
    });
    socket.on("error", (err) => this.log.debug({ err, streamId }, "terminal socket error"));
    if (!this.hostHub.sendTerm(host.id, streamId, { t: "open", sessionId, cols, rows })) {
      this.streams.delete(streamId);
      refuse(`Host ${host.name} is not connected`);
    }
  }

  /** A `term` frame from a host. */
  frame(hostId: string, streamId: string, msg: TermServerToViewer): void {
    const s = this.streams.get(streamId);
    if (!s || s.hostId !== hostId) return;
    this.sendTo(s.socket, msg);
    if (msg.t === "closed") {
      this.streams.delete(streamId);
      s.socket.close(1000, "closed");
    }
  }

  /** A host's link dropped: end its streams. */
  disconnected(hostId: string): void {
    for (const [id, s] of this.streams) {
      if (s.hostId !== hostId) continue;
      this.streams.delete(id);
      this.sendTo(s.socket, { t: "closed", reason: "Host disconnected" });
      s.socket.close(1000, "closed");
    }
  }

  private toHost(streamId: string, msg: TermCoordinatorMsg, hostId?: string): void {
    const target = hostId ?? this.streams.get(streamId)?.hostId;
    if (target) this.hostHub.sendTerm(target, streamId, msg);
  }

  private sendTo(socket: WebSocket, msg: TermServerToViewer): void {
    if (socket.readyState === WsOpen) socket.send(JSON.stringify(msg));
  }
}

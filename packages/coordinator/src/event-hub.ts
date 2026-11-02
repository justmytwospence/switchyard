import { EventEmitter } from "node:events";
import type {
  AttentionItem,
  EventEnvelope,
  Interaction,
  Run,
  RuntimeState,
  Session,
  StreamDelta,
  Task,
} from "@switchyard/protocol";

/** Payload of `session.settled`: a session went from running/waiting_input to idle. */
export interface SessionSettled {
  session: Session;
  previousRuntime: RuntimeState;
  aborted: boolean;
  lastAssistantText: string | null;
}

/**
 * Typed in-process events. Durable `event`s are published only after their transaction commits,
 * in `seq` order. Later services (dispatcher, runs, scheduler, notification router) subscribe here.
 */
export interface CoordinatorEventMap {
  /** A durable event, after commit. */
  event: [EventEnvelope];
  /** An ephemeral stream delta from a host. */
  stream: [StreamDelta];
  "session.settled": [SessionSettled];
  /** A host completed `hello`. `reconnect` is false only for its first connection since start. */
  "host.connected": [{ hostId: string; reconnect: boolean }];
  "host.disconnected": [{ hostId: string }];
  "host.unreachable": [{ hostId: string }];
  /** A task was upserted (`task` set) or deleted (`task` null). */
  "task.changed": [{ id: string; task: Task | null }];
  "run.changed": [Run];
  "attention.raised": [AttentionItem];
  "attention.resolved": [AttentionItem];
  "interaction.updated": [Interaction];
  "presence.changed": [{ deviceId: string }];
  /** Control mode changed through takeover / return-to-automation routes. */
  "control.changed": [{ run: Run; session: Session; mode: "automation" | "human" }];
  "device.revoked": [{ deviceId: string }];
}

export type CoordinatorEventName = keyof CoordinatorEventMap;

/**
 * Event hub. Listener exceptions are caught and reported through `onListenerError` so a faulty
 * subscriber never breaks the publisher or other subscribers.
 */
export class EventHub extends EventEmitter<CoordinatorEventMap> {
  onListenerError: (name: string, err: unknown) => void = () => {};

  constructor() {
    super();
    this.setMaxListeners(1000);
  }

  override emit(name: any, ...args: any[]): boolean {
    const listeners = this.rawListeners(name) as ((...a: unknown[]) => unknown)[];
    for (const fn of listeners) {
      try {
        const r = fn(...args);
        if (r && typeof (r as Promise<unknown>).catch === "function") {
          (r as Promise<unknown>).catch((err) => this.onListenerError(String(name), err));
        }
      } catch (err) {
        this.onListenerError(String(name), err);
      }
    }
    return listeners.length > 0;
  }
}

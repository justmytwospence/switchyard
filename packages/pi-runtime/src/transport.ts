import type { EventEmitter } from "node:events";
import type { BridgeAgentResult, BridgeMethod, BridgeRequestOptions } from "./bridge-wire.js";
import type { PiExit } from "./rpc-process.js";
import type { AgentTransportEventMap, PiUiResponseBody } from "./types.js";

/**
 * What `ManagedSession` needs from a Pi process: RPC-shaped commands, dialog answers and exit.
 * `PiRpcProcess` (`pi --mode rpc`) and `PiTerminalProcess` (interactive Pi in a pty holder) both
 * satisfy it and emit the same events (`event`, `ui_request`, `bridge`, `stderr`, `exit`,
 * `protocol_error`), plus the direct `agent_request`, `bridge_features`, `bridge_lost` lane.
 */
export interface PiTransport extends EventEmitter {
  on<K extends keyof AgentTransportEventMap>(
    event: K,
    listener: (...args: AgentTransportEventMap[K]) => void,
  ): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this;
  readonly pid: number | undefined;
  readonly exited: PiExit | null;
  readonly stderr: string;
  bridgeConnected: boolean;
  /** `timeoutMs <= 0`: no timeout. */
  request<T = any>(cmd: { type: string; [k: string]: unknown }, timeoutMs?: number): Promise<T>;
  bridgeRequest<T = unknown>(
    method: BridgeMethod,
    args: unknown,
    options?: BridgeRequestOptions,
  ): Promise<T>;
  /** Reply directly to the originating extension request, never to Pi's RPC stdin. */
  replyAgent(frame: BridgeAgentResult): void;
  respondUi(id: string, body: PiUiResponseBody): Promise<void>;
  close(opts?: { graceMs?: number; termMs?: number }): Promise<PiExit>;
  kill(signal?: NodeJS.Signals, requested?: boolean): void;
  waitForExit(): Promise<PiExit>;
}

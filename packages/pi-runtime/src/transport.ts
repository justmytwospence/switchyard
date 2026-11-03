import type { EventEmitter } from "node:events";
import type { PiExit } from "./rpc-process.js";
import type { PiUiResponseBody } from "./types.js";

/**
 * What `ManagedSession` needs from a Pi process: RPC-shaped commands, dialog answers and exit.
 * `PiRpcProcess` (`pi --mode rpc`) and `PiTerminalProcess` (interactive Pi in a pty holder) both
 * satisfy it and emit the same events (`event`, `ui_request`, `bridge`, `stderr`, `exit`,
 * `protocol_error`).
 */
export interface PiTransport extends EventEmitter {
  readonly pid: number | undefined;
  readonly exited: PiExit | null;
  readonly stderr: string;
  bridgeConnected: boolean;
  request<T = any>(cmd: { type: string; [k: string]: unknown }, timeoutMs?: number): Promise<T>;
  respondUi(id: string, body: PiUiResponseBody): Promise<void>;
  close(opts?: { graceMs?: number; termMs?: number }): Promise<PiExit>;
  kill(signal?: NodeJS.Signals, requested?: boolean): void;
  waitForExit(): Promise<PiExit>;
}

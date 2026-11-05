import { type ErrorBody, HostCommand, type Receipt, SwitchyardError } from "@switchyard/protocol";
import { runChecks } from "./checks.js";
import type { HostDb } from "./db/index.js";
import type { Dispatcher } from "./dispatch.js";
import { listDir, readWorkspaceFile } from "./files.js";
import { diffWorkspace, discoverWorktrees, inspectCheckout, worktreeStatus } from "./git.js";
import type { Logger } from "./logger.js";
import { scanProjectFolder } from "./project-folders.js";
import type { SessionSupervisor } from "./supervisor.js";
import type { WorkspaceService } from "./workspaces.js";

export interface HostTestHooks {
  /** Return true to store the receipt but not send it (simulates a lost receipt). */
  dropReceipt?(commandId: string, command: HostCommand): boolean;
  /** Called for every command received, including duplicates. */
  onCommand?(command: HostCommand): void;
}

export interface CommandLogEntry {
  commandId: string;
  type: string;
  sessionId: string | null;
  origin: string | null;
  controlRevision: number | null;
  at: string;
  /** Receipt status: ok, the error code, or "duplicate" for a resent stored receipt. */
  outcome: string;
}

export interface CommandRouterOptions {
  db: HostDb;
  supervisor: SessionSupervisor;
  dispatcher: Dispatcher;
  workspaces: WorkspaceService;
  log: Logger;
  sendReceipt: (receipt: Receipt) => void;
  testHooks?: HostTestHooks;
  /** Environment for checks. */
  env?: Record<string, string | undefined>;
  /** Timeout per check command (default 30 min). */
  checkTimeoutMs?: number;
}

/** Map any thrown value to a protocol error body. */
export function toErrorBody(err: unknown): ErrorBody {
  if (err instanceof SwitchyardError) return err.toBody();
  if (err instanceof Error && err.name === "InteractionResponseError") {
    return { code: "invalid_request", message: err.message };
  }
  if (err instanceof Error && err.name === "ZodError") {
    return { code: "invalid_request", message: `Invalid command: ${err.message.slice(0, 500)}` };
  }
  return { code: "internal", message: err instanceof Error ? err.message : String(err) };
}

/** Serial-queue key: per session for session-scoped commands, else the shared host queue. */
export function queueKey(command: HostCommand): string {
  if (command.type === "checks.run") return `checks:${command.sessionId}`;
  // Control commands get their own per-session lane. A prompt that runs a slash command which
  // opens a dialog does not return until that dialog is answered, so the answer (and Stop) must
  // not queue behind it. They are still serialized among themselves, and answers stay atomic
  // through the supervisor's id+revision transaction.
  if (
    command.type === "session.answer" ||
    command.type === "session.abort" ||
    command.type === "session.stop" ||
    command.type === "session.setControl" ||
    command.type === "session.adapterAction" ||
    command.type === "session.snapshot" ||
    command.type === "session.models" ||
    command.type === "session.commands" ||
    command.type === "session.complete" ||
    command.type === "session.tree" ||
    command.type === "session.export" ||
    command.type === "session.reload"
  ) {
    return `control:${command.sessionId}`;
  }
  if ("sessionId" in command && typeof command.sessionId === "string") {
    return `session:${command.sessionId}`;
  }
  return "host";
}

/**
 * Routes coordinator commands. Receipts are stored by `commandId` before they are sent, so a
 * duplicate command (the coordinator re-sends after reconnecting) gets the stored receipt and
 * never runs twice. Commands for one session run one at a time, in arrival order.
 */
export class CommandRouter {
  private readonly opts: CommandRouterOptions;
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly inflight = new Map<string, Promise<Receipt>>();
  /** Every command received (for diagnostics and tests). */
  readonly commandLog: CommandLogEntry[] = [];

  constructor(opts: CommandRouterOptions) {
    this.opts = opts;
  }

  storedReceipt(commandId: string): Receipt | undefined {
    return this.opts.db.getJson<Receipt>("SELECT json FROM receipts WHERE command_id = ?", [
      commandId,
    ]);
  }

  handle(commandId: string, raw: unknown): Promise<Receipt> {
    const parsed = HostCommand.safeParse(raw);
    const command = parsed.success ? parsed.data : null;
    const entry: CommandLogEntry = {
      commandId,
      type: command?.type ?? String((raw as { type?: unknown })?.type ?? "unknown"),
      sessionId:
        command && "sessionId" in command && typeof command.sessionId === "string"
          ? command.sessionId
          : null,
      origin: command && "origin" in command ? String(command.origin) : null,
      controlRevision:
        command && "controlRevision" in command ? Number(command.controlRevision) : null,
      at: new Date().toISOString(),
      outcome: "pending",
    };
    this.commandLog.push(entry);
    if (this.commandLog.length > 1000) this.commandLog.shift();
    if (command) {
      try {
        this.opts.testHooks?.onCommand?.(command);
      } catch {
        // test hooks never break routing
      }
    }

    const stored = this.storedReceipt(commandId);
    if (stored) {
      entry.outcome = "duplicate";
      this.deliver(stored, command);
      return Promise.resolve(stored);
    }
    const running = this.inflight.get(commandId);
    if (running) {
      entry.outcome = "duplicate";
      return running.then((r) => {
        this.deliver(r, command);
        return r;
      });
    }

    const work = async (): Promise<Receipt> => {
      let receipt: Receipt;
      if (!command) {
        receipt = {
          commandId,
          ok: false,
          error: {
            code: "invalid_request",
            message: `Invalid command: ${parsed.error?.message.slice(0, 500)}`,
          },
        };
      } else {
        try {
          const result = await this.execute(command);
          receipt = { commandId, ok: true, result: result ?? null };
        } catch (err) {
          const error = toErrorBody(err);
          if (error.code === "internal") {
            this.opts.log.error(
              { commandId, type: command.type, err: error.message },
              "command failed",
            );
          }
          receipt = { commandId, ok: false, error };
        }
      }
      entry.outcome = receipt.ok ? "ok" : receipt.error.code;
      this.opts.db.tx(() =>
        this.opts.db.run(
          "INSERT OR REPLACE INTO receipts (command_id, json, created_at) VALUES (?, ?, ?)",
          [commandId, JSON.stringify(receipt), new Date().toISOString()],
        ),
      );
      this.deliver(receipt, command);
      return receipt;
    };

    const key = command ? queueKey(command) : "host";
    const prev = this.queues.get(key) ?? Promise.resolve();
    const p = prev.catch(() => {}).then(work);
    this.queues.set(key, p);
    this.inflight.set(commandId, p);
    p.finally(() => {
      this.inflight.delete(commandId);
      if (this.queues.get(key) === p) this.queues.delete(key);
    }).catch(() => {
      // The caller handles the rejection of `p`; this derived promise must not go unhandled.
    });
    return p;
  }

  /** Prune receipts older than `maxAgeMs` (default 7 days). */
  pruneReceipts(maxAgeMs = 7 * 24 * 60 * 60 * 1000): number {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    return this.opts.db.run("DELETE FROM receipts WHERE created_at < ?", [cutoff]).changes;
  }

  private deliver(receipt: Receipt, command: HostCommand | null): void {
    if (command && this.opts.testHooks?.dropReceipt?.(receipt.commandId, command)) return;
    this.opts.sendReceipt(receipt);
  }

  private async execute(c: HostCommand): Promise<unknown> {
    const { supervisor: sup, dispatcher, workspaces } = this.opts;
    switch (c.type) {
      case "session.start":
        return sup.start({
          sessionId: c.sessionId,
          title: c.title,
          workspacePath: c.workspacePath,
          projectId: c.projectId,
          profile: c.profile,
          nativeHandle: c.nativeHandle,
          initialPrompt: c.initialPrompt,
          dispatchKey: c.dispatchKey,
          controlRevision: c.controlRevision,
          controlMode: c.controlMode,
          origin: c.origin,
          readOnly: c.readOnly,
        });
      case "session.prompt": {
        if (c.origin === "automation") {
          const control = sup.controlOf(c.sessionId);
          if (
            control &&
            (c.controlRevision < control.controlRevision ||
              (control.controlMode === "human" && c.controlRevision <= control.controlRevision))
          ) {
            throw new SwitchyardError(
              "stale_control",
              `Automation lost control of this session (revision ${c.controlRevision} < ${control.controlRevision}${control.controlMode === "human" ? ", human control" : ""})`,
              { controlRevision: control.controlRevision, controlMode: control.controlMode },
            );
          }
          sup.noteRevision(c.sessionId, c.controlRevision);
        }
        return sup.prompt(c.sessionId, c.text, c.images, c.mode);
      }
      case "session.abort":
        return sup.abort(c.sessionId, c.clearQueue);
      case "session.stop":
        return sup.stop(c.sessionId);
      case "session.answer":
        return sup.answer(c.sessionId, c.interactionId, c.revision, c.response, c.deviceId);
      case "session.adapterAction":
        return sup.adapterAction(c.sessionId, c.adapterId, c.actionId, c.payload);
      case "session.setControl":
        return sup.setControl(c.sessionId, c.controlRevision, c.mode);
      case "session.rename":
        return sup.rename(c.sessionId, c.title);
      case "session.importable":
        return sup.importable();
      case "session.readNative":
        return sup.readNative(c.sessionFile);
      case "session.snapshot":
        return sup.snapshot(c.sessionId);
      case "session.models":
        return sup.models(c.sessionId);
      case "session.commands":
        return sup.commands(c.sessionId);
      case "session.complete":
        return sup.complete(c.sessionId, c.text);
      case "session.tree":
        return sup.tree(c.sessionId);
      case "session.branch":
        return sup.branch(c.sessionId, c.entryId, c.fork);
      case "session.reload":
        return sup.reload(c.sessionId);
      case "session.export":
        return sup.exportSession(c.sessionId);
      case "session.setModel":
        return sup.setModel(c.sessionId, c.provider, c.modelId);
      case "session.setThinking":
        return sup.setThinking(c.sessionId, c.level);
      case "session.compact":
        return sup.compact(c.sessionId, c.instructions);
      case "checkout.inspect":
        return inspectCheckout(c.path);
      case "projects.scan":
        return scanProjectFolder(c.folder);
      case "workspace.discover":
        return {
          worktrees: await discoverWorktrees(c.checkoutPath, { worktreeDir: c.worktreeDir }),
        };
      case "workspace.create": {
        const { setupDone: _done, ...created } = await workspaces.create(
          c.checkoutPath,
          c.branch,
          c.base,
          c.setupCommand,
          c.worktreeDir,
        );
        return created;
      }
      case "workspace.status":
        return { path: c.path, git: await worktreeStatus(c.path, c.base) };
      case "workspace.remove":
        return workspaces.remove(c.path, c.checkoutPath, c.base, c.force);
      case "workspace.diff":
        return diffWorkspace(c.path, c.base, c.file);
      case "workspace.files":
        return listDir(c.path, c.dir);
      case "workspace.readFile":
        return readWorkspaceFile(c.path, c.file);
      case "dispatch.start":
        return dispatcher.start(c);
      case "dispatch.reconcile":
        return dispatcher.reconcile(c.dispatchKey);
      case "checks.run":
        return runChecks(c.path, c.commands, {
          timeoutMs: this.opts.checkTimeoutMs,
          env: { ...process.env, ...(this.opts.env ?? {}) } as NodeJS.ProcessEnv,
        });
    }
  }
}

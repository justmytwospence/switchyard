import {
  branchSlug,
  type HostCommand,
  type HostCommandOf,
  type Run,
  type Task,
} from "@switchyard/protocol";
import type { CreateCoordinatorOptions } from "../src/index.js";
import { requireService } from "../src/index.js";
import {
  enrollHost,
  FakeHost,
  hostSession,
  NO_REPLY,
  startCoordinator,
  type TestCoordinator,
  until,
} from "./helpers.js";

export const ROOT = "/repos/app";

/** Host-side state of the smart fake host. */
export class HostState {
  /** dispatchKey -> stored outcome (the host dedupes by dispatch key). */
  dispatches = new Map<string, { sessionId: string; workspacePath: string }>();
  /** sessionId -> control revision the host last learned. */
  revisions = new Map<string, number>();
  /** Exit code per check command (default 0). */
  checkExit: Record<string, number> = {};
  /** Hold `session.prompt` (automation) until released. */
  promptGate: Promise<void> | null = null;
}

export type Override = (cmd: HostCommand, commandId: string) => unknown | undefined;

/** A fake host that behaves like the real one for dispatch, control revisions and checks. */
export function smartHandler(state: HostState, override?: () => Override | undefined) {
  return async (cmd: HostCommand, commandId: string): Promise<unknown> => {
    const o = override?.();
    if (o) {
      const r = await o(cmd, commandId);
      if (r !== undefined) return r;
    }
    switch (cmd.type) {
      case "checkout.inspect":
        return {
          root: ROOT,
          commonDir: `${ROOT}/.git`,
          repoIdentity: `https://github.com/me/${Math.random().toString(36).slice(2)}`,
          defaultBranch: "main",
        };
      case "workspace.discover":
        return [
          {
            path: ROOT,
            head: "abc",
            branch: "refs/heads/main",
            bare: false,
            detached: false,
            locked: false,
            prunable: false,
            provenance: "main",
            git: null,
          },
        ];
      case "dispatch.start": {
        const known = state.dispatches.get(cmd.dispatchKey);
        state.revisions.set(
          cmd.sessionId,
          Math.max(state.revisions.get(cmd.sessionId) ?? 0, cmd.controlRevision),
        );
        const workspacePath =
          "path" in cmd.workspace
            ? cmd.workspace.path
            : `${cmd.workspace.createFrom.checkoutPath}/.worktrees/${branchSlug(cmd.workspace.createFrom.branch)}`;
        const outcome = known ?? { sessionId: cmd.sessionId, workspacePath };
        state.dispatches.set(cmd.dispatchKey, outcome);
        return {
          ...outcome,
          nativeHandle: {
            sessionId: `n-${cmd.sessionId}`,
            sessionFile: `/s/${cmd.sessionId}.jsonl`,
          },
          reused: !!known,
        };
      }
      case "dispatch.reconcile": {
        const d = state.dispatches.get(cmd.dispatchKey);
        if (!d) return { known: false };
        return {
          known: true,
          sessionId: d.sessionId,
          state: "started",
          runtime: "running",
          workspacePath: d.workspacePath,
          nativeHandle: { sessionId: `n-${d.sessionId}`, sessionFile: `/s/${d.sessionId}.jsonl` },
          error: null,
        };
      }
      case "session.setControl":
        state.revisions.set(
          cmd.sessionId,
          Math.max(state.revisions.get(cmd.sessionId) ?? 0, cmd.controlRevision),
        );
        return null;
      case "session.prompt": {
        if (cmd.origin === "automation") {
          if (state.promptGate) await state.promptGate;
          const stored = state.revisions.get(cmd.sessionId) ?? 0;
          if (cmd.controlRevision < stored) {
            return { __error: { code: "stale_control", message: "Control was taken over" } };
          }
        }
        return null;
      }
      case "checks.run":
        return {
          results: cmd.commands.map((c) => ({
            command: c,
            exitCode: state.checkExit[c] ?? 0,
            outputTail: state.checkExit[c] ? `${c} failed` : "ok",
          })),
        };
      default:
        return null;
    }
  };
}

export interface Harness {
  t: TestCoordinator;
  host: FakeHost;
  creds: { hostId: string; credential: string };
  project: { id: string; checkouts: { id: string }[] };
  state: HostState;
  override: Override | undefined;
}

export async function setupHarness(
  opts: {
    coordinator?: Partial<CreateCoordinatorOptions>;
    checks?: string[];
    maxConcurrentRuns?: number;
    capabilities?: Record<string, unknown> | null;
  } = {},
): Promise<Harness> {
  const t = await startCoordinator({
    dispatcher: { tickMs: 0 },
    schedulerTickMs: 0,
    ...opts.coordinator,
  });
  const creds = await enrollHost(t);
  const state = new HostState();
  const h = { t, creds, state, override: undefined } as Harness;
  h.host = await FakeHost.connect(
    t,
    creds,
    smartHandler(state, () => h.override),
  );
  if (opts.capabilities !== undefined) {
    await h.host.close();
    await h.host.open({ capabilities: opts.capabilities });
  }
  const p = await t.admin("POST", "/api/projects", {
    name: "App",
    hostId: creds.hostId,
    path: ROOT,
    checks: opts.checks ?? [],
    maxConcurrentRuns: opts.maxConcurrentRuns ?? 1,
  });
  if (p.status !== 201) throw new Error(`project: ${JSON.stringify(p.body)}`);
  h.project = p.body;
  return h;
}

export function fullCapabilities(over: Record<string, unknown> = {}) {
  return {
    prompt: true,
    steer: true,
    followUp: true,
    abort: true,
    resume: true,
    rename: true,
    importInactive: true,
    extensionDialogs: true,
    customUi: false,
    widgetsText: true,
    widgetsComponent: false,
    tokenAccounting: true,
    costAccounting: true,
    agentRequests: true,
    policies: true,
    unsupported: [],
    ...over,
  };
}

export async function createTask(h: Harness, body: Record<string, unknown> = {}): Promise<Task> {
  const r = await h.t.admin("POST", "/api/tasks", {
    projectId: h.project.id,
    title: "Fix the login bug",
    objective: "Users cannot log in",
    acceptanceCriteria: ["Login works"],
    ...body,
  });
  if (r.status !== 201) throw new Error(`task: ${JSON.stringify(r.body)}`);
  return r.body;
}

export function task(h: Harness, id: string): Task {
  return h.t.c.store.tasks.require(id);
}

export function runOf(h: Harness, taskId: string): Run {
  const t = task(h, taskId);
  return h.t.c.store.runs.require(t.currentRunId!);
}

export function commandsOf<T extends HostCommand["type"]>(
  host: FakeHost,
  type: T,
): HostCommandOf<T>[] {
  return host.commands.filter((c) => c.command.type === type).map((c) => c.command) as never;
}

/** Wait until the task's current run reaches `state`. */
export async function untilRun(h: Harness, taskId: string, state: Run["state"], ms = 5000) {
  await until(() => {
    const t = h.t.c.store.tasks.get(taskId);
    const r = t?.currentRunId ? h.t.c.store.runs.get(t.currentRunId) : undefined;
    return r?.state === state;
  }, ms);
  return runOf(h, taskId);
}

/** Dispatch a Ready task and wait until its run is running. */
export async function startRun(h: Harness, body: Record<string, unknown> = {}) {
  const tk = await createTask(h, { state: "ready", ...body });
  const run = await untilRun(h, tk.id, "running");
  return { task: task(h, tk.id), run };
}

/** The host reports the session working, then idle with a final assistant message. */
export async function settle(
  h: Harness,
  sessionId: string,
  text: string | null,
  extra: Record<string, unknown> = {},
) {
  const cwd = h.t.c.store.sessions.require(sessionId).cwd;
  await h.host.event(
    "session.updated",
    hostSession(sessionId, { cwd, runtime: "running", ...extra }),
  );
  await h.host.event(
    "session.updated",
    hostSession(sessionId, { cwd, runtime: "idle", lastAssistantText: text, ...extra }),
  );
}

export function dispatcherOf(h: Harness) {
  return requireService(h.t.c.ctx, "dispatcher");
}

export async function cleanupHarness(h: Harness | undefined) {
  if (!h) return;
  await h.host.close().catch(() => undefined);
  await h.t.cleanup();
}

export { NO_REPLY };

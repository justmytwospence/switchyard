import { join } from "node:path";
import { SwitchyardError } from "@switchyard/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  Dispatcher,
  openHostDb,
  RESTARTED_DURING_DISPATCH,
  RESTARTED_DURING_LAUNCH,
  type SessionSupervisor,
  silentLogger,
  type WorkspaceService,
} from "../src/index.js";
import { tempDir } from "./helpers.js";

const dirs: { cleanup(): void }[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) d.cleanup();
});

function setup() {
  const d = tempDir();
  dirs.push(d);
  const db = openHostDb(join(d.path, "host.db"));
  const handle = { sessionId: "native-1", sessionFile: "/s/native-1.jsonl" };
  const supervisor = {
    record: (id: string) =>
      id === "ses_ready" ? { id, nativeHandle: handle, runtime: "interrupted" } : undefined,
  } as unknown as SessionSupervisor;
  const dispatcher = new Dispatcher({
    db,
    supervisor,
    workspaces: {} as WorkspaceService,
    log: silentLogger(),
  });
  const insert = (key: string, sessionId: string, state: string, path: string | null) =>
    db.run(
      "INSERT INTO dispatches (dispatch_key, run_id, session_id, state, workspace_path, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      [key, key, sessionId, state, path, new Date().toISOString()],
    );
  return { db, dispatcher, handle, insert };
}

describe("dispatch recovery after a host-agent restart", () => {
  it("reports only `accepted` launches as safely not started; later stages as started: unknown", async () => {
    const { db, dispatcher, handle, insert } = setup();
    insert("run_acc", "ses_acc", "accepted", null);
    insert("run_ready", "ses_ready", "workspace_ready", "/repo/.worktrees/x");
    expect(dispatcher.recoverAfterRestart()).toBe(2);

    const acc = dispatcher.reconcile("run_acc");
    expect(acc).toMatchObject({
      known: true,
      state: "failed",
      error: RESTARTED_DURING_DISPATCH,
      errorDetails: { started: false },
    });
    const ready = dispatcher.reconcile("run_ready");
    expect(ready).toMatchObject({
      known: true,
      state: "failed",
      error: RESTARTED_DURING_LAUNCH,
      errorDetails: {
        started: "unknown",
        nativeHandle: handle,
        workspacePath: "/repo/.worktrees/x",
      },
    });

    // A resent dispatch.start returns the stored failure with the same details, never a relaunch.
    const err = await dispatcher
      .start({
        type: "dispatch.start",
        dispatchKey: "run_ready",
        runId: "run_ready",
        taskId: "tsk_1",
        sessionId: "ses_ready",
        projectId: "prj_1",
        title: "x",
        workspace: { path: "/repo/.worktrees/x" },
        nativeHandle: null,
        profile: {
          id: "prf",
          name: "p",
          provider: null,
          model: null,
          thinking: null,
          projectTrust: "ask",
          extraArgs: [],
        },
        prompt: "go",
        controlRevision: 1,
        controlMode: "automation",
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SwitchyardError);
    expect((err as SwitchyardError).message).toBe(RESTARTED_DURING_LAUNCH);
    expect((err as SwitchyardError).details).toMatchObject({ started: "unknown", reused: true });
    db.close();
  });
});

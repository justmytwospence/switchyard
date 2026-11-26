// @module-tag slow
import { join } from "node:path";
import { makeRepo } from "@switchyard/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { type CoordinatorLink, openHostDb, silentLogger, WorkspaceService } from "../src/index.js";
import { tempDir } from "./helpers.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function setup() {
  const repo = makeRepo();
  const state = tempDir();
  cleanups.push(repo.cleanup, state.cleanup);
  const db = openHostDb(join(state.path, "host.db"));
  const emitted: { type: string; data: Record<string, unknown> }[] = [];
  const link = {
    emit: (e: { type: string; data: Record<string, unknown> }) => {
      emitted.push(e);
      return {};
    },
  } as unknown as CoordinatorLink;
  const workspaces = new WorkspaceService({
    db,
    link,
    log: silentLogger(),
    hasActiveSession: () => false,
  });
  return { repo, db, workspaces, emitted };
}

describe("workspace updates that outlive the host", () => {
  it("records the setup outcome while the host runs", async () => {
    const { repo, db, workspaces, emitted } = setup();
    const ws = await workspaces.create(repo.path, "feature/a", "main", "true");
    expect((await ws.setupDone).state).toBe("succeeded");
    expect(emitted.some((e) => (e.data.setup as { state?: string })?.state === "succeeded")).toBe(
      true,
    );
    db.close();
  });

  it("drops a setup outcome and a git status that finish after the database closed", async () => {
    const { repo, db, workspaces, emitted } = setup();
    const rejections: unknown[] = [];
    const onRejection = (err: unknown) => rejections.push(err);
    process.on("unhandledRejection", onRejection);
    try {
      const ws = await workspaces.create(repo.path, "feature/b", "main", "sleep 0.3");
      const before = emitted.length;
      db.close();
      // The setup command still finishes; its outcome just has nowhere to go.
      expect((await ws.setupDone).state).toBe("succeeded");
      await new Promise((r) => setTimeout(r, 300));
      expect(emitted.slice(before).filter((e) => e.data.setup)).toEqual([]);
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});

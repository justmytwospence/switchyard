import { join } from "node:path";
import { type HostCommand, type Receipt, SwitchyardError } from "@switchyard/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CommandRouter,
  type CommandRouterOptions,
  queueKey,
  READ_ONLY_COMMANDS,
  RESTARTED_WHILE_RUNNING,
} from "../src/commands.js";
import { openHostDb } from "../src/db/index.js";
import { silentLogger } from "../src/logger.js";
import { SessionSupervisor } from "../src/supervisor.js";
import { tempDir } from "./helpers.js";

const fields = {
  path: "/workspace",
  repository: "owner/repo",
  number: 12,
  expectedHeadOid: "a".repeat(40),
};
const mergeFields = { ...fields, expectedPullRequestNodeId: "PR_node_12" };
const merge = { type: "workspace.prMerge", ...mergeFields } satisfies HostCommand;
const cleanup: (() => void)[] = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});
function fixture() {
  const dir = tempDir();
  const db = openHostDb(join(dir.path, "host.db"));
  cleanup.push(() => {
    db.close();
    dir.cleanup();
  });
  const github = {
    refresh: vi.fn(async () => ({ snapshot: "view" })),
    failedLogs: vi.fn(async () => ({ jobs: [] })),
    merge: vi.fn(async () => ({ status: "outcome_unknown" })),
  };
  const sendReceipt = vi.fn();
  const make = (integration: object | undefined = github) =>
    new CommandRouter({
      db,
      supervisor: {} as CommandRouterOptions["supervisor"],
      workspaces: {} as CommandRouterOptions["workspaces"],
      dispatcher: {} as CommandRouterOptions["dispatcher"],
      github: integration as CommandRouterOptions["github"],
      log: silentLogger(),
      sendReceipt,
    });
  return { db, github, sendReceipt, make, router: make() };
}
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("GitHub host command routing and receipt discipline", () => {
  it("routes strict reusable command arguments to the service", async () => {
    const f = fixture();
    expect(
      await f.router.handle("view", { type: "workspace.prView", path: fields.path }),
    ).toMatchObject({ ok: true, result: { snapshot: "view" } });
    expect(
      await f.router.handle("logs", { type: "workspace.prFailedLogs", ...fields }),
    ).toMatchObject({ ok: true, result: { jobs: [] } });
    expect(await f.router.handle("merge", merge)).toMatchObject({
      ok: true,
      result: { status: "outcome_unknown" },
    });
    expect(f.github.refresh).toHaveBeenCalledWith(fields.path);
    expect(f.github.failedLogs).toHaveBeenCalledWith(fields);
    expect(f.github.merge).toHaveBeenCalledWith(mergeFields);
  });
  it.each(["workspace.prView", "workspace.prFailedLogs"] as const)(
    "%s is read-only, bounded by read concurrency, rerunnable and has no pending mutation marker",
    async (type) => {
      const f = fixture();
      const wait = gate<any>();
      const method = type === "workspace.prView" ? f.github.refresh : f.github.failedLogs;
      method.mockImplementation(() => wait.promise);
      const command =
        type === "workspace.prView" ? { type, path: fields.path } : { type, ...fields };
      const running = f.router.handle("read", command);
      await vi.waitFor(() => expect(method).toHaveBeenCalledTimes(1));
      expect(f.db.get("SELECT * FROM receipts WHERE command_id = ?", ["read"])).toBeUndefined();
      expect(READ_ONLY_COMMANDS.has(type)).toBe(true);
      expect(queueKey(command)).toBeNull();
      // Reads do not queue behind a merge on the same workspace.
      expect((await f.router.handle("other", merge)).ok).toBe(true);
      wait.resolve({});
      await running;
    },
  );
  it("serializes merge mutations on the workspace path, not host/session or the read lane", async () => {
    const f = fixture();
    const wait = gate<any>();
    f.github.merge.mockImplementationOnce(() => wait.promise);
    const first = f.router.handle("merge1", merge);
    await vi.waitFor(() => expect(f.github.merge).toHaveBeenCalledTimes(1));
    const second = f.router.handle("merge2", merge);
    const elsewhere = await f.router.handle("elsewhere", { ...merge, path: "/other" });
    expect(elsewhere.ok).toBe(true);
    expect(f.github.merge).toHaveBeenCalledTimes(2);
    expect(
      (await f.router.handle("view", { type: "workspace.prView", path: fields.path })).ok,
    ).toBe(true);
    expect(
      f.db.getJson("SELECT json FROM receipts WHERE command_id = ?", ["merge1"]),
    ).toMatchObject({ pending: true, type: "workspace.prMerge" });
    wait.resolve({ status: "outcome_unknown" });
    await first;
    await second;
    expect(f.github.merge).toHaveBeenCalledTimes(3);
    expect(READ_ONLY_COMMANDS.has("workspace.prMerge")).toBe(false);
    expect(queueKey(merge)).toBe("workspace:/workspace");
  });
  it("replays the original result for duplicate command IDs, including lost and in-flight receipts", async () => {
    const f = fixture();
    const wait = gate<any>();
    f.github.merge.mockImplementationOnce(() => wait.promise);
    const first = f.router.handle("merge1", merge);
    const duplicate = f.router.handle("merge1", merge);
    await vi.waitFor(() => expect(f.github.merge).toHaveBeenCalledTimes(1));
    wait.resolve({ status: "outcome_unknown", reason: "lost response" });
    expect(await duplicate).toEqual(await first);
    const restarted = f.make();
    expect(await restarted.handle("merge1", merge)).toEqual(await first);
    expect(f.github.merge).toHaveBeenCalledTimes(1);
  });
  it("recovers pending merge mutations as errors, never reruns them after restart", async () => {
    const f = fixture();
    f.db.run("INSERT INTO receipts (command_id, json, created_at) VALUES (?, ?, ?)", [
      "interrupted",
      JSON.stringify({ commandId: "interrupted", pending: true, type: merge.type }),
      new Date().toISOString(),
    ]);
    expect(f.router.recoverPending()).toBe(1);
    const r = await f.router.handle("interrupted", merge);
    expect(r).toMatchObject({ ok: false, error: { message: RESTARTED_WHILE_RUNNING } });
    expect(f.github.merge).not.toHaveBeenCalled();
  });
  it("preserves specific preflight errors and rejects unsupported old hosts", async () => {
    const f = fixture();
    f.github.merge.mockRejectedValue(new SwitchyardError("conflict", "PR head changed"));
    expect(await f.router.handle("stale", merge)).toMatchObject({
      ok: false,
      error: { code: "conflict", message: "PR head changed" },
    });
    // Construct an old-host router without the optional service.
    const opts = {
      db: f.db,
      supervisor: {} as CommandRouterOptions["supervisor"],
      dispatcher: {} as CommandRouterOptions["dispatcher"],
      workspaces: {} as CommandRouterOptions["workspaces"],
      log: silentLogger(),
      sendReceipt: (_r: Receipt) => {},
    };
    expect(await new CommandRouter(opts).handle("old", merge)).toMatchObject({
      ok: false,
      error: { code: "unsupported_capability" },
    });
  });
  it("rejects command injection fields, invalid repositories and SHA before invoking gh", async () => {
    const f = fixture();
    for (const [i, command] of [
      { ...merge, expectedHeadOid: "--admin" },
      { ...merge, repository: "owner/repo;echo bad" },
      { ...merge, strategy: "admin" },
      { ...merge, expectedPullRequestNodeId: "" },
      { type: "workspace.prMerge", ...fields },
    ].entries()) {
      expect(await f.router.handle(String(i), command)).toMatchObject({
        ok: false,
        error: { code: "invalid_request" },
      });
    }
    expect(f.github.merge).not.toHaveBeenCalled();
  });
});

describe("supervisor GitHub push hints", () => {
  it("captures nested and adapter-free raw tool output before the adapter early return without awaiting work", async () => {
    const observe = vi.fn();
    // No Pi, adapters or DB needed: exercise the actual event-dispatch branch directly.
    const supervisor = Object.create(SessionSupervisor.prototype) as SessionSupervisor;
    Object.defineProperty(supervisor, "opts", { value: { observeToolOutput: observe } });
    const output = {
      content: [{ type: "text", text: "remote: https://github.com/owner/repo/pull/12" }],
    };
    // biome-ignore lint/complexity/useLiteralKeys: Exercise the private event dispatch without a Pi process.
    await supervisor["onPiEvent"](
      { adapters: null, ms: null, rec: { cwd: fields.path } } as any,
      { type: "tool_execution_end", parentToolCallId: "parent", result: output } as any,
    );
    expect(observe).toHaveBeenCalledWith(fields.path, output);
  });
});

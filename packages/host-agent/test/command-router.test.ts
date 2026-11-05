import { join } from "node:path";
import type { Receipt } from "@switchyard/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { CommandRouter } from "../src/commands.js";
import { type HostDb, openHostDb } from "../src/db/index.js";
import { silentLogger } from "../src/logger.js";
import { sleep, tempDir } from "./helpers.js";

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function router(supervisor: object, workspaces: object): CommandRouter {
  const dir = tempDir();
  const db: HostDb = openHostDb(join(dir.path, "host.db"));
  cleanups.push(() => {
    db.close();
    dir.cleanup();
  });
  return new CommandRouter({
    db,
    supervisor: supervisor as any,
    dispatcher: {} as any,
    workspaces: workspaces as any,
    log: silentLogger(),
    sendReceipt: () => {},
  });
}

describe("CommandRouter lanes", () => {
  it("a slow read does not block other reads", async () => {
    const slow = deferred<unknown[]>();
    const r = router(
      { importable: () => slow.promise, readNative: async () => ({ items: [] }) },
      {},
    );
    let slowDone = false;
    const first = r.handle("c1", { type: "session.importable" }).then((x) => {
      slowDone = true;
      return x;
    });
    const second = await r.handle("c2", { type: "session.readNative", sessionFile: "x" });
    expect(second.ok).toBe(true);
    expect(slowDone).toBe(false);
    slow.resolve([]);
    expect((await first).ok).toBe(true);
  });

  it("mutations queue per checkout", async () => {
    const gate = deferred<void>();
    const order: string[] = [];
    const r = router(
      {},
      {
        create: async (checkoutPath: string) => {
          await gate.promise;
          order.push(`create ${checkoutPath}`);
          return { path: `${checkoutPath}/.worktrees/b`, setupDone: Promise.resolve() };
        },
        remove: async (path: string, checkoutPath: string) => {
          order.push(`remove ${checkoutPath}`);
          return { ok: true, path };
        },
      },
    );
    const remove = (id: string, checkoutPath: string): Promise<Receipt> =>
      r.handle(id, {
        type: "workspace.remove",
        path: `${checkoutPath}/.worktrees/b`,
        checkoutPath,
        base: null,
        force: { dirty: false, unmerged: false },
      });
    const created = r.handle("c1", {
      type: "workspace.create",
      checkoutPath: "/a",
      branch: "b",
      base: "main",
      setupCommand: null,
    });
    const removedB = remove("c2", "/b");
    const removedA = remove("c3", "/a");
    expect((await removedB).ok).toBe(true);
    await sleep(50);
    expect(order).toEqual(["remove /b"]);
    gate.resolve();
    expect((await created).ok).toBe(true);
    expect((await removedA).ok).toBe(true);
    expect(order).toEqual(["remove /b", "create /a", "remove /a"]);
  });
});

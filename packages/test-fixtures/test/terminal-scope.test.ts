import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeTerminalScope } from "../src/terminal-scope.js";

describe("terminal fixture scope", () => {
  it("waits for launches, stops attached sessions first and isolates simultaneous scopes", async () => {
    const stopped: string[] = [];
    const options = {
      socketDirs: (runtime: string) => [runtime, `${runtime}-fallback`],
      stopSocket: async (path: string) => {
        stopped.push(path);
        rmSync(path);
      },
    };
    const first = makeTerminalScope(options);
    const second = makeTerminalScope(options);
    let release!: () => void;
    const pending = first.launch(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      mkdirSync(`${first.runtimeDir}-fallback`, { recursive: true });
      writeFileSync(join(`${first.runtimeDir}-fallback`, "term-one.sock"), "");
    });
    await Promise.resolve();
    mkdirSync(second.runtimeDir, { recursive: true });
    const other = join(second.runtimeDir, "term-two.sock");
    writeFileSync(other, "");
    first.onStop(async () => {
      stopped.push("attached");
    });
    const disposing = first.dispose();
    expect(first.dispose()).toBe(disposing);
    expect(() => first.launch(async () => {})).toThrow("disposing");
    expect(stopped).toEqual([]);
    release();
    await pending;
    await disposing;
    expect(stopped).toEqual(["attached", join(`${first.runtimeDir}-fallback`, "term-one.sock")]);
    expect(existsSync(first.root)).toBe(false);
    expect(existsSync(other)).toBe(true);
    await second.dispose();
    expect(stopped).toContain(other);
  });

  it("rejects late registration and drains rejected launches", async () => {
    const scope = makeTerminalScope({
      socketDirs: (runtime) => [runtime],
      stopSocket: async () => {},
    });
    const launch = scope.launch(async () => {
      throw new Error("launch failed");
    });
    await expect(launch).rejects.toThrow("launch failed");
    const disposal = scope.dispose();
    expect(() => scope.onStop(async () => {})).toThrow("disposing");
    await disposal;
  });

  it("bounds pending starts, attempts later cleanup and retains the root", async () => {
    const calls: string[] = [];
    const scope = makeTerminalScope({
      timeoutMs: 25,
      socketDirs: (runtime) => [runtime],
      stopSocket: async (path) => {
        calls.push(path);
        rmSync(path);
      },
    });
    mkdirSync(scope.runtimeDir, { recursive: true });
    const socket = join(scope.runtimeDir, "term-one.sock");
    writeFileSync(socket, "");
    let release!: () => void;
    const pending = scope.launch(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    scope.onStop(async () => {
      calls.push("stop");
      throw new Error("stop failed");
    });
    scope.onStop(async () => {
      calls.push("later");
    });
    const disposal = scope.dispose();
    try {
      await expect(disposal).rejects.toThrow(/pending launches/);
      expect(scope.dispose()).toBe(disposal);
      await expect(scope.dispose()).rejects.toThrow(/stop failed/);
      expect(calls).toEqual(["stop", "later", socket]);
      expect(existsSync(scope.root)).toBe(true);
    } finally {
      release();
      await pending;
      rmSync(scope.root, { recursive: true, force: true });
    }
  });

  it("checks both socket directories and does not target other files", async () => {
    const seen: string[] = [];
    const scope = makeTerminalScope({
      runtimeSubpath: `long/${"x".repeat(90)}`,
      socketDirs: (runtime) => [runtime, `${runtime}-fallback`],
      stopSocket: async (path) => {
        seen.push(path);
        rmSync(path);
      },
    });
    for (const dir of [scope.runtimeDir, `${scope.runtimeDir}-fallback`]) {
      mkdirSync(dir, { recursive: true });
      for (const name of ["term-test.sock", "ext-test.sock", "term-test.log"])
        writeFileSync(join(dir, name), "");
    }
    await scope.dispose();
    expect(seen).toEqual([
      join(scope.runtimeDir, "term-test.sock"),
      join(`${scope.runtimeDir}-fallback`, "term-test.sock"),
    ]);
    expect(() =>
      makeTerminalScope({
        runtimeSubpath: "../outside",
        socketDirs: () => [],
        stopSocket: async () => {},
      }),
    ).toThrow("relative path");
  });

  it("fails if a stop callback leaves a socket behind", async () => {
    const scope = makeTerminalScope({
      socketDirs: (runtime) => [runtime],
      stopSocket: async () => {},
    });
    mkdirSync(scope.runtimeDir, { recursive: true });
    writeFileSync(join(scope.runtimeDir, "term-stale.sock"), "");
    try {
      await expect(scope.dispose()).rejects.toThrow("socket remains");
    } finally {
      rmSync(scope.root, { recursive: true, force: true });
    }
  });

  it("retains diagnostics and rejects teardown if a holder cannot be verified", async () => {
    const stopSocket = vi.fn(async () => {
      throw new Error("still running");
    });
    const scope = makeTerminalScope({ socketDirs: (runtime) => [runtime], stopSocket });
    mkdirSync(scope.runtimeDir, { recursive: true });
    const path = join(scope.runtimeDir, "term-broken.sock");
    writeFileSync(path, "diagnostic");
    try {
      await expect(scope.dispose()).rejects.toThrow("retained");
      expect(stopSocket).toHaveBeenCalledWith(path);
      expect(existsSync(path)).toBe(true);
    } finally {
      rmSync(scope.root, { recursive: true, force: true });
    }
  });
});

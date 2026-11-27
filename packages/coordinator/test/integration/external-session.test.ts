// @module-tag slow
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Session, sessionInScope } from "@switchyard/protocol";
import {
  fixtureExtensionPath,
  makePiEnv,
  type PiEnv,
  piBin,
  skipRealPi,
} from "@switchyard/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { Integration, steps, waitFor } from "./harness.js";

const runtimeRoot = new URL("../../../pi-runtime/", import.meta.url);
const extension = fileURLToPath(new URL("dist/bridge/switchyard-terminal.js", runtimeRoot));
let pty: typeof import("node-pty") | null = null;
try {
  pty = createRequire(fileURLToPath(new URL("package.json", runtimeRoot)))("node-pty");
} catch {
  // no terminal sessions on this machine
}
const supported = !skipRealPi && pty !== null;
const existingIt = it.skipIf(!supported);
const realPiIt = it.skipIf(skipRealPi);

async function stopPty(proc: import("node-pty").IPty, exited: Promise<void>): Promise<void> {
  const done = exited.then(() => true);
  for (const [signal, timeoutMs] of [
    ["SIGTERM", 3000],
    ["SIGKILL", 2000],
  ] as const) {
    try {
      proc.kill(signal);
    } catch {
      // The process may have exited; still require its exit notification.
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timedOut = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      });
      if (await Promise.race([done, timedOut])) return;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`External Pi PTY (PID ${proc.pid}) did not exit after SIGKILL`);
}

/** A Pi the user starts by hand in their own terminal (here a pty), with the extension loaded. */
describe("a Pi started in your own terminal", { timeout: 180_000 }, () => {
  let env: Integration;
  let proc: import("node-pty").IPty | null = null;
  let exited: Promise<void> | undefined;
  let externalPi: PiEnv | undefined;

  function trackExit(terminal: import("node-pty").IPty): void {
    exited = new Promise((resolve) => {
      terminal.onExit(() => {
        if (proc === terminal) exited = undefined;
        resolve();
      });
    });
  }

  afterEach(async () => {
    try {
      if (proc && exited) await stopPty(proc, exited);
    } finally {
      try {
        await env?.dispose();
      } finally {
        externalPi?.cleanup();
        proc = null;
        exited = undefined;
        externalPi = undefined;
      }
    }
  });

  realPiIt("leaves an independently owned enrolled Pi alive after fixture disposal", async () => {
    if (!pty) throw new Error("node-pty is required for the external-session regression");
    env = await Integration.create({ terminalSessions: true });
    externalPi = makePiEnv({ mockUrl: env.mock!.url, extensions: [fixtureExtensionPath()] });
    const { SWITCHYARD_CONTROL_SOCKET: _c, SWITCHYARD_BRIDGE_SOCKET: _b, ...base } = process.env;
    proc = pty.spawn(piBin(), [...externalPi.args, "-e", extension], {
      cols: 100,
      rows: 30,
      cwd: externalPi.cwd,
      env: {
        ...base,
        ...externalPi.env,
        SWITCHYARD_ENROLL_STATE_DIR: env.stateDir,
      } as Record<string, string>,
    });
    trackExit(proc);
    let output = "";
    proc.onData((data) => {
      output += data;
    });
    await waitFor(
      () => env.c.store.sessions.list().some((s) => s.external && s.runtime === "idle"),
      "external Pi enrolled",
      60_000,
    );
    const pid = proc.pid;
    await env.dispose();
    expect(() => process.kill(pid, 0)).not.toThrow();
    // The fixture command responds locally; the coordinator and mock model are gone.
    output = "";
    proc.write("/fixture-hello after-disposal\r");
    await waitFor(
      () => output.includes("fixture hello after-disposal"),
      "external Pi responds after fixture disposal",
    );
    expect(() => process.kill(pid, 0)).not.toThrow();
  });

  existingIt("enrols, joins its project's views, answers prompts and stops on quit", async () => {
    env = await Integration.create({ terminalSessions: true });
    const { terminal } = env.devices!;
    const client = `herdr:daily@${hostname()}`;
    const view = await env.ok("POST", "/api/scopes", {
      as: terminal,
      body: { name: "work", projectIds: [env.project.id] },
    });

    const cwd = join(env.repo!.path, "src");
    mkdirSync(cwd, { recursive: true });
    const { SWITCHYARD_CONTROL_SOCKET: _c, SWITCHYARD_BRIDGE_SOCKET: _b, ...base } = process.env;
    proc = pty!.spawn(piBin(), [...env.pi!.args, "-e", extension], {
      cols: 100,
      rows: 30,
      cwd,
      env: {
        ...base,
        ...env.pi!.env,
        SWITCHYARD_ENROLL_STATE_DIR: env.stateDir,
        HERDR_ENV: "1",
        HERDR_SOCKET_PATH: "/h/sessions/daily/herdr.sock",
        HERDR_PANE_ID: "w1:p2",
      } as Record<string, string>,
    });

    trackExit(proc);

    const found = await waitFor(
      () => env.c.store.sessions.list().some((s) => s.external && s.runtime === "idle"),
      "enrolled session",
      60_000,
    ).then(() => env.c.store.sessions.list().find((s) => s.external)!);
    const s: Session = env.c.store.sessions.require(found.id);
    expect(s.terminal).toBe(false);
    expect(s.projectId).toBe(env.project.id);
    expect(s.workspaceId).not.toBeNull();
    expect(s.external).toEqual({ client });
    expect(s.place).toEqual({ terminalId: client, pane: "w1:p2" });
    const workspaces = Object.fromEntries(env.c.store.workspaces.list().map((w) => [w.id, w]));
    expect(sessionInScope(env.c.store.scopes.require(view.id), s, workspaces)).toBe(true);

    await env.ok("POST", `/api/sessions/${s.id}/prompt`, {
      as: terminal,
      body: { text: `Say hi ${steps("done")}` },
    });
    await env.waitSession(
      s.id,
      (x) => x.runtime === "idle" && /SWITCHYARD: DONE/.test(x.lastAssistantText ?? ""),
      "reply",
    );

    // Stop never quits the user's Pi.
    await env.ok("POST", `/api/sessions/${s.id}/stop`, { as: terminal });
    expect(env.c.store.sessions.require(s.id).runtime).toBe("idle");

    proc.write("/quit\r");
    await env.waitSession(s.id, (x) => x.runtime === "stopped", "stopped after /quit");
    // Where it ran stays known after it stops, so a mirror there opens no tab for it.
    expect(env.c.store.sessions.require(s.id)).toMatchObject({
      external: null,
      place: { terminalId: client, pane: "w1:p2" },
    });
  });
});

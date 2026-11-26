import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clientId, enrollRuntimeDir, isEnrollMeta, paneId } from "../src/bridge/enroll.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function stateDir(withRuntime = true): string {
  const d = mkdtempSync(join(tmpdir(), "sy-enroll-"));
  dirs.push(d);
  if (withRuntime) mkdirSync(join(d, "runtime"));
  return d;
}

describe("clientId", () => {
  it("names the herdr session from its socket, then HERDR_SESSION, then default", () => {
    expect(clientId({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/h/herdr.sock" }, "mac")).toBe(
      "herdr:default@mac",
    );
    expect(
      clientId({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/h/sessions/vo/herdr.sock" }, "mac"),
    ).toBe("herdr:vo@mac");
    expect(clientId({ HERDR_ENV: "1", HERDR_SESSION: "fg" }, "mac")).toBe("herdr:fg@mac");
    expect(clientId({}, "mac", () => null)).toBeNull();
  });
});

describe("tmux", () => {
  it("names the tmux session, and herdr wins inside tmux", () => {
    const tmux = { TMUX: "/tmp/tmux-501/default,1,0", TMUX_PANE: "%3" };
    const name = (env: Record<string, string | undefined>) => (env.TMUX ? "work" : null);
    expect(clientId(tmux, "mac", name)).toBe("tmux:work@mac");
    expect(clientId({ ...tmux, HERDR_ENV: "1", HERDR_SESSION: "vo" }, "mac", name)).toBe(
      "herdr:vo@mac",
    );
    expect(clientId(tmux, "mac", () => null)).toBeNull();
  });

  it("records the pane in its terminal's ids", () => {
    expect(paneId({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2", TMUX_PANE: "%3" })).toBe("w1:p2");
    expect(paneId({ TMUX: "/t", TMUX_PANE: "%3" })).toBe("%3");
    expect(paneId({ TMUX_PANE: "%3" })).toBeNull();
  });
});

describe("enrollRuntimeDir", () => {
  it("uses the host agent's runtime directory when it exists", () => {
    const d = stateDir();
    expect(enrollRuntimeDir({ SWITCHYARD_STATE_DIR: d }, true)).toBe(join(d, "runtime"));
    const other = stateDir();
    expect(
      enrollRuntimeDir({ SWITCHYARD_STATE_DIR: d, SWITCHYARD_ENROLL_STATE_DIR: other }, true),
    ).toBe(join(other, "runtime"));
  });

  it("does not enrol Pi that Switchyard started, opted out, without a terminal or agent", () => {
    const d = stateDir();
    const env = { SWITCHYARD_STATE_DIR: d };
    expect(enrollRuntimeDir({ ...env, SWITCHYARD_CONTROL_SOCKET: "/x" }, true)).toBeNull();
    expect(enrollRuntimeDir({ ...env, SWITCHYARD_BRIDGE_SOCKET: "/x" }, true)).toBeNull();
    expect(enrollRuntimeDir({ ...env, SWITCHYARD_ENROLL: "0" }, true)).toBeNull();
    expect(enrollRuntimeDir(env, false)).toBeNull();
    expect(enrollRuntimeDir({ SWITCHYARD_STATE_DIR: stateDir(false) }, true)).toBeNull();
  });
});

describe("isEnrollMeta", () => {
  it("accepts complete meta only", () => {
    const meta = {
      pid: 12,
      cwd: "/repo",
      client: null,
      sessionId: "s",
      sessionFile: "/s.jsonl",
      startedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(isEnrollMeta(meta)).toBe(true);
    expect(isEnrollMeta({ ...meta, cwd: "repo" })).toBe(false);
    expect(isEnrollMeta({ ...meta, pid: 0 })).toBe(false);
    expect(isEnrollMeta({ ...meta, pane: "w1:p2" })).toBe(true);
    expect(isEnrollMeta({ ...meta, pane: 3 })).toBe(false);
    expect(isEnrollMeta(null)).toBe(false);
  });
});

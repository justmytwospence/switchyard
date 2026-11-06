import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const LAUNCHER = fileURLToPath(
  new URL("../../../integrations/tmux/switchyard-tmux.sh", import.meta.url),
);

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sy-tmux-launcher-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync("sh", [LAUNCHER, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, ...env },
  });
}

describe("switchyard-tmux.sh", () => {
  it("exports the paired session's settings, including the view", () => {
    const dir = join(home, ".config", "switchyard-tmux");
    mkdirSync(dir, { recursive: true });
    const fake = join(home, "fake-switchyard");
    writeFileSync(
      fake,
      '#!/bin/sh\nprintf "%s|" "$SWITCHYARD_CLIENT_CONFIG" "$SWITCHYARD_VIEW" "$SWITCHYARD_TMUX_SESSION" "$@"\n',
      { mode: 0o755 },
    );
    writeFileSync(
      join(dir, "work.env"),
      `SWITCHYARD_CLI="sh ${fake}"\nSWITCHYARD_CLIENT_CONFIG="/cfg/dev.json"\nSWITCHYARD_VIEW="work"\n`,
    );
    const r = run(["status"], { SWITCHYARD_TMUX_SESSION: "work" });
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("/cfg/dev.json|work|work|tmux|status|");
  });

  it("runs with defaults in sessions without an env file", () => {
    const fake = join(home, "switchyard");
    writeFileSync(fake, '#!/bin/sh\nprintf "%s|" "$SWITCHYARD_TMUX_SESSION" "$@"\n', {
      mode: 0o755,
    });
    const r = run(["daemon", "--ensure"], {
      SWITCHYARD_TMUX_SESSION: "none",
      PATH: `${home}:${process.env.PATH}`,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("none|tmux|daemon|--ensure|");
  });
});

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const LAUNCHER = fileURLToPath(
  new URL("../../../integrations/herdr/switchyard-herdr.sh", import.meta.url),
);

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sy-launcher-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync("sh", [LAUNCHER, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, ...env },
  });
}

function pair(name: string) {
  const dir = join(home, ".config", "switchyard-herdr");
  mkdirSync(dir, { recursive: true });
  // A fake switchyard that prints the client config, the herdr session and its arguments.
  const fake = join(home, "fake-switchyard");
  writeFileSync(
    fake,
    '#!/bin/sh\nprintf "%s|" "$SWITCHYARD_CLIENT_CONFIG" "$SWITCHYARD_VIEW" "$SWITCHYARD_HERDR_SESSION" "$@"\n',
    { mode: 0o755 },
  );
  writeFileSync(
    join(dir, `${name}.env`),
    `SWITCHYARD_CLI="sh ${fake}"\nSWITCHYARD_CLIENT_CONFIG="/cfg/dev.json"\nSWITCHYARD_VIEW="work"\n`,
  );
}

describe("switchyard-herdr.sh", () => {
  it("runs switchyard herdr with the paired session's settings", () => {
    pair("switchyard-dev");
    const r = run(["status"], {
      HERDR_SOCKET_PATH: join(home, ".config/herdr/sessions/switchyard-dev/herdr.sock"),
    });
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("/cfg/dev.json|work|switchyard-dev|herdr|status|");
  });

  it("maps new-here to new --here", () => {
    pair("switchyard-dev");
    const r = run(["new-here"], { HERDR_SESSION: "switchyard-dev" });
    expect(r.stdout).toBe("/cfg/dev.json|work|switchyard-dev|herdr|new|--here|");
  });

  it("runs with defaults in sessions without an env file", () => {
    const fake = join(home, "switchyard");
    writeFileSync(fake, '#!/bin/sh\nprintf "%s|" "$SWITCHYARD_HERDR_SESSION" "$@"\n', {
      mode: 0o755,
    });
    const r = run(["daemon", "--ensure"], {
      HERDR_SOCKET_PATH: join(home, ".config/herdr/herdr.sock"),
      PATH: `${home}:${process.env.PATH}`,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("default|herdr|daemon|--ensure|");
  });
});

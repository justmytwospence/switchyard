import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeCapabilities } from "@switchyard/protocol";
import { piBin, requirePi, skipRealPi } from "@switchyard/test-fixtures";
import { afterAll, describe, expect, it } from "vitest";
import {
  assertCompatible,
  detectPi,
  incompatibleMessage,
  isSupportedVersion,
  SUPPORTED_RANGE,
} from "../src/index.js";

const dir = mkdtempSync(join(tmpdir(), "sy-fakepi-"));
function fakePi(output: string, exitCode = 0): string {
  const file = join(dir, `pi-${Math.random().toString(36).slice(2)}`);
  writeFileSync(file, `#!/bin/sh\necho "${output}"\nexit ${exitCode}\n`);
  chmodSync(file, 0o755);
  return file;
}
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("capabilities", () => {
  it("has the tested range", () => {
    expect(SUPPORTED_RANGE).toBe(">=1.4.0 <1.6.0");
    expect(isSupportedVersion("1.4.0")).toBe(true);
    expect(isSupportedVersion("1.5.9")).toBe(true);
    expect(isSupportedVersion("1.6.0")).toBe(false);
    expect(isSupportedVersion("1.3.9")).toBe(false);
    expect(isSupportedVersion("1.6.0-beta.1")).toBe(false);
  });

  it("refuses versions outside the range with the documented message", async () => {
    const d = await detectPi(fakePi("1.6.2"));
    expect(d).toMatchObject({ version: "1.6.2", compatible: false });
    expect(d.reason).toBe("Pi 1.6.2 is outside the tested range >=1.4.0 <1.6.0");
    expect(incompatibleMessage("1.6.2")).toBe(d.reason);
    expect(() => assertCompatible(d)).toThrow(expect.objectContaining({ code: "pi_incompatible" }));
  });

  it("reports a missing or failing Pi", async () => {
    const missing = await detectPi(join(dir, "does-not-exist"));
    expect(missing.compatible).toBe(false);
    expect(missing.version).toBeNull();
    const failing = await detectPi(fakePi("boom", 1));
    expect(failing.compatible).toBe(false);
  });

  it.skipIf(skipRealPi)("detects the installed Pi with honest capabilities", async () => {
    const version = requirePi();
    const d = await detectPi(piBin());
    expect(d.version).toBe(version);
    expect(d.compatible).toBe(true);
    expect(() => RuntimeCapabilities.parse(d.capabilities)).not.toThrow();
    expect(d.capabilities).toMatchObject({
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
    });
    expect(d.capabilities.unsupported).toEqual([
      { capability: "customUi", reason: "ctx.ui.custom() returns undefined in RPC mode" },
      {
        capability: "widgetsComponent",
        reason: "component widget factories are ignored in RPC mode",
      },
    ]);
  });
});

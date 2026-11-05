import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PiRpcError, PiRpcProcess } from "../src/rpc-process.js";
import { piErrorToSwitchyard } from "../src/session-runtime.js";

const fakePi = fileURLToPath(new URL("./fixtures/fake-rpc-pi.mjs", import.meta.url));
chmodSync(fakePi, 0o755);

const procs: PiRpcProcess[] = [];
const dirs: string[] = [];

async function startFake(env: Record<string, string> = {}): Promise<PiRpcProcess> {
  const cwd = mkdtempSync(join(tmpdir(), "sy-fakepi-"));
  dirs.push(cwd);
  const p = await PiRpcProcess.start({ piBin: fakePi, cwd, bridge: false, env });
  procs.push(p);
  return p;
}

afterEach(() => {
  for (const p of procs.splice(0)) p.kill("SIGKILL");
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("Pi request errors", () => {
  it("maps Pi rejections to invalid_request and transport failures to internal", () => {
    expect(piErrorToSwitchyard(new PiRpcError("x", "nope", "rejected")).code).toBe(
      "invalid_request",
    );
    expect(piErrorToSwitchyard(new PiRpcError("x", "slow", "timeout")).code).toBe("internal");
    const t = piErrorToSwitchyard(new PiRpcError("x", "gone", "transport"));
    expect(t.code).toBe("internal");
    expect(t.details).toMatchObject({ command: "x", kind: "transport" });
  });

  it("tags timeouts, rejections and transport failures", async () => {
    const p = await startFake();
    await expect(p.request({ type: "get_commands" }, 100)).rejects.toMatchObject({
      kind: "timeout",
    });
    await expect(p.request({ type: "get_available_models" })).rejects.toMatchObject({
      kind: "rejected",
      message: "no models",
    });
    const pending = p.request({ type: "get_commands" }, 5000);
    const assertion = expect(pending).rejects.toMatchObject({ kind: "transport" });
    p.kill("SIGKILL");
    await assertion;
    await expect(p.request({ type: "get_state" })).rejects.toMatchObject({ kind: "transport" });
  });
});

import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiRpcError, PiRpcProcess } from "../src/rpc-process.js";
import { ManagedSession, piErrorToSwitchyard } from "../src/session-runtime.js";

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

describe("requests without a timeout", () => {
  it("timeoutMs 0 never times out", async () => {
    const p = await startFake();
    let settled = false;
    const pending = p.request({ type: "get_commands" }, 0);
    const assertion = expect(pending).rejects.toMatchObject({ kind: "transport" });
    pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(settled).toBe(false);
    p.kill("SIGKILL");
    await assertion;
  });

  it("RPC slash-command prompts wait for their dialogs, other prompts time out at 60 s", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "sy-fakepi-"));
    dirs.push(cwd);
    const ms = new ManagedSession({
      sessionId: "ses_fake",
      cwd,
      title: "Fake",
      profile: {
        provider: "mock",
        model: "mock-1",
        thinking: null,
        projectTrust: "ask",
        extraArgs: [],
      },
      nativeHandle: null,
      piBin: fakePi,
      transport: "rpc",
    });
    await ms.start();
    try {
      const request = vi.spyOn(ms.process as PiRpcProcess, "request");
      void ms.prompt("/slow x").catch(() => {});
      await ms.prompt("hi");
      expect(request).toHaveBeenCalledWith(expect.objectContaining({ type: "prompt" }), 0);
      expect(request).toHaveBeenCalledWith(expect.objectContaining({ type: "prompt" }), 60000);
    } finally {
      await ms.stop({ graceMs: 100, termMs: 500 });
    }
  });
});

describe("aborting a start", () => {
  it("stops Pi and ends stopped", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "sy-fakepi-"));
    dirs.push(cwd);
    const ms = new ManagedSession({
      sessionId: "ses_hang",
      cwd,
      title: "Hang",
      profile: {
        provider: "mock",
        model: "mock-1",
        thinking: null,
        projectTrust: "ask",
        extraArgs: [],
      },
      nativeHandle: null,
      piBin: fakePi,
      env: { FAKE_PI_HANG: "1" },
      transport: "rpc",
    });
    const ac = new AbortController();
    const started = ms.start(ac.signal);
    setTimeout(() => ac.abort(), 200);
    await started;
    expect(ms.runtime).toBe("stopped");
    expect(ms.process?.exited).toMatchObject({ requested: true });
  });
});

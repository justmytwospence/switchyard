import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type BridgeAgentRequest,
  type BridgeConfiguration,
  type BridgeFeatures,
  deliveryOfferHash,
} from "../src/bridge-wire.js";
import { JsonlReader, writeJsonl } from "../src/jsonl.js";
import { PiRpcError, PiRpcProcess } from "../src/rpc-process.js";
import { ManagedSession, piErrorToSwitchyard } from "../src/session-runtime.js";
import { PiTerminalProcess } from "../src/terminal-process.js";
import type { PiTransport } from "../src/transport.js";

const fakePi = fileURLToPath(new URL("./fixtures/fake-rpc-pi.mjs", import.meta.url));
chmodSync(fakePi, 0o755);

const procs: PiRpcProcess[] = [];
const dirs: string[] = [];

async function startFake(env: Record<string, string> = {}, bridge = false): Promise<PiRpcProcess> {
  const cwd = mkdtempSync(join(tmpdir(), "sy-fakepi-"));
  dirs.push(cwd);
  const p = await PiRpcProcess.start({ piBin: fakePi, cwd, bridge, env });
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

const features: BridgeFeatures = {
  type: "agent.hello",
  version: 1,
  runtimeId: "runtime-a",
  nativeSessionId: "native-a",
  sessionFile: null,
  pid: 123,
  mode: "rpc",
  capabilities: {
    agentTools: true,
    messageDelivery: true,
    editorDraftGuard: true,
    toolPolicy: true,
  },
  context: { humanInputId: null, causalMessageId: null },
};
const configuration: BridgeConfiguration = {
  version: 1,
  sessionId: "ses_fake",
  runtimeId: features.runtimeId,
  nativeSessionId: features.nativeSessionId,
  bindingId: "binding-a",
  features: ["agentRequests.v1", "policies.v1"],
  coordinatorConnected: true,
  policyRequired: true,
  sessionUrl: "https://switchyard.example/code/ses_fake",
};
const configured = {
  configured: true,
  agentTools: true,
  messageDelivery: true,
  policyRequired: true,
  policyState: "active",
  policyPhases: ["tool_call", "request"],
};
const offer = {
  deliveryId: "m",
  kind: "message" as const,
  text: "header",
  mode: "queue" as const,
  holdUntil: "2026-11-01T00:00:00.000Z",
};
const acceptArgs = {
  offer,
  offerHash: deliveryOfferHash(offer),
  attempt: {
    id: "a2d81a40-55cb-4665-a094-39ff3fdc1835",
    runtimeId: features.runtimeId,
    nativeSessionId: features.nativeSessionId,
  },
};
const statusArgs = {
  deliveryId: offer.deliveryId,
  offerHash: acceptArgs.offerHash,
  attempt: acceptArgs.attempt,
};
const agentRequest: BridgeAgentRequest = {
  type: "agent.request",
  requestId: "agent-a",
  bindingId: configuration.bindingId,
  sessionId: "ses_fake",
  runtimeId: features.runtimeId,
  nativeSessionId: features.nativeSessionId,
  method: "inbox.read",
  args: {},
  context: features.context,
};

async function connected(path: string): Promise<Socket> {
  const socket = createConnection(path);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return socket;
}

function receipt(command: any, body: Record<string, unknown> = { ok: true, result: {} }) {
  return {
    type: "bridge.receipt",
    requestId: command.requestId,
    runtimeId: command.runtimeId,
    nativeSessionId: command.nativeSessionId,
    bindingId: command.bindingId,
    ...body,
  };
}

async function configureHarness(
  h: { proc: PiTransport; peer: Socket; records: any[] },
  config = configuration,
) {
  const previousIds = new Set(h.records.map((r) => r.requestId));
  const pending = h.proc.bridgeRequest("configure", config);
  void pending.catch(() => {});
  const findCommand = () =>
    h.records.findLast(
      (r) =>
        r.type === "bridge.command" &&
        r.method === "configure" &&
        r.runtimeId === config.runtimeId &&
        r.bindingId === config.bindingId &&
        !previousIds.has(r.requestId),
    );
  await vi.waitFor(() => expect(findCommand()).toBeDefined());
  await writeJsonl(h.peer, receipt(findCommand(), { ok: true, result: configured }));
  await pending;
}

async function bridgeHarness(transport: "rpc" | "terminal", announce = true) {
  const records: any[] = [];
  let proc: PiTransport;
  let peer: Socket;
  let cleanup: () => void;
  if (transport === "rpc") {
    const rpc = await startFake({}, true);
    peer = await connected(rpc.bridgeSocket!);
    proc = rpc;
    cleanup = () => peer.destroy();
  } else {
    const dir = mkdtempSync(join(tmpdir(), "sy-control-"));
    dirs.push(dir);
    const path = join(dir, "c.sock");
    let accept!: (socket: Socket) => void;
    const accepted = new Promise<Socket>((resolve) => {
      accept = resolve;
    });
    const server = createServer(accept);
    await new Promise<void>((resolve) => server.listen(path, resolve));
    const terminal = await PiTerminalProcess.attach(path);
    proc = terminal;
    peer = await accepted;
    cleanup = () => {
      terminal.detach();
      peer.destroy();
      server.close();
    };
  }
  JsonlReader.attach(peer, (record) => records.push(record));
  if (announce) {
    const announced = new Promise<void>((resolve) => proc.once("bridge_features", () => resolve()));
    await writeJsonl(peer, features);
    await announced;
    await configureHarness({ proc, peer, records });
    records.length = 0;
  }
  return { proc, peer, records, cleanup };
}

for (const transport of ["rpc", "terminal"] as const) {
  describe(`${transport} local bridge lane`, () => {
    it("does not infer agent support from a legacy hello", async () => {
      const h = await bridgeHarness(transport, false);
      try {
        const seen: unknown[] = [];
        h.proc.on("bridge_features", (frame) => seen.push(frame));
        const hello = new Promise<void>((resolve) => h.proc.once("bridge", () => resolve()));
        await writeJsonl(h.peer, {
          type: transport === "rpc" ? "hello" : "extension_hello",
          remoteDialogs: true,
        });
        await hello;
        expect(h.proc.bridgeConnected).toBe(true);
        expect(seen).toEqual([]);
        await expect(h.proc.bridgeRequest("configure", {})).rejects.toMatchObject({
          kind: "transport",
        });
      } finally {
        h.cleanup();
      }
    });

    it("cancels pending local requests when the bridge detaches", async () => {
      const h = await bridgeHarness(transport);
      const pending = h.proc.bridgeRequest("delivery.accept", acceptArgs);
      const assertion = expect(pending).rejects.toMatchObject({ code: "host_unreachable" });
      h.cleanup();
      await assertion;
    });

    it("correlates receipts outside pending Pi commands and agent requests", async () => {
      const h = await bridgeHarness(transport);
      try {
        const command = h.proc.request({ type: "get_commands" }, 0);
        const commandAssertion = expect(command).rejects.toBeInstanceOf(Error);
        const request = h.proc.bridgeRequest("delivery.status", statusArgs);
        await vi.waitFor(() =>
          expect(h.records.some((r) => r.type === "bridge.command")).toBe(true),
        );
        const local = h.records.find((r) => r.type === "bridge.command");
        expect(local).toMatchObject({
          method: "delivery.status",
          args: statusArgs,
          runtimeId: features.runtimeId,
          nativeSessionId: features.nativeSessionId,
          bindingId: configuration.bindingId,
        });
        expect(local.requestId).not.toBe(h.records.find((r) => r.type === "get_commands")?.id);
        await writeJsonl(h.peer, receipt(local, { ok: true, result: { state: "queued" } }));
        await expect(request).resolves.toEqual({ state: "queued" });
        const emitted = new Promise<BridgeAgentRequest>((resolve) =>
          h.proc.once("agent_request", resolve),
        );
        await writeJsonl(h.peer, agentRequest);
        await expect(emitted).resolves.toEqual(agentRequest);
        h.proc.replyAgent({
          type: "agent.result",
          requestId: agentRequest.requestId,
          runtimeId: "stale",
          bindingId: configuration.bindingId,
          ok: true,
          result: {},
        });
        h.proc.replyAgent({
          type: "agent.result",
          requestId: agentRequest.requestId,
          runtimeId: features.runtimeId,
          bindingId: configuration.bindingId,
          ok: true,
          result: { messages: [] },
        });
        await vi.waitFor(() =>
          expect(h.records.filter((r) => r.type === "agent.result")).toHaveLength(1),
        );
        expect(h.records.find((r) => r.type === "agent.result")).toMatchObject({
          runtimeId: features.runtimeId,
          result: { messages: [] },
        });
        h.cleanup();
        h.proc.kill("SIGKILL");
        await commandAssertion;
      } finally {
        h.cleanup();
      }
    });

    it("ignores wrong-identity receipts and agent frames until a fresh binding is configured", async () => {
      const h = await bridgeHarness(transport);
      try {
        const local = h.proc.bridgeRequest("delivery.status", statusArgs);
        await vi.waitFor(() =>
          expect(h.records.some((r) => r.type === "bridge.command")).toBe(true),
        );
        const command = h.records.find((r) => r.type === "bridge.command");
        let settled = false;
        void local.then(() => {
          settled = true;
        });
        await writeJsonl(h.peer, receipt(command, { ok: true, result: "stale", bindingId: "old" }));
        await writeJsonl(
          h.peer,
          receipt(command, { ok: true, result: "stale", nativeSessionId: "old" }),
        );
        await writeJsonl(h.peer, receipt(command, { ok: true, result: "stale", runtimeId: "old" }));
        // An independent receipt is a deterministic socket-reader barrier.
        const barrier = h.proc.bridgeRequest("input.human", { humanInputId: "human" });
        await vi.waitFor(() =>
          expect(h.records.filter((r) => r.type === "bridge.command")).toHaveLength(2),
        );
        await writeJsonl(
          h.peer,
          receipt(h.records.filter((r) => r.type === "bridge.command").at(-1)),
        );
        await barrier;
        expect(settled).toBe(false);
        await writeJsonl(h.peer, receipt(command, { ok: true, result: "current" }));
        await expect(local).resolves.toBe("current");

        const seen: unknown[] = [];
        h.proc.on("agent_request", (frame) => seen.push(frame));
        const reannounced = new Promise<void>((resolve) =>
          h.proc.once("bridge_features", () => resolve()),
        );
        await writeJsonl(h.peer, features);
        await reannounced;
        await expect(
          h.proc.bridgeRequest("input.human", { humanInputId: "human" }),
        ).rejects.toMatchObject({ code: "conflict" });
        await writeJsonl(h.peer, agentRequest);
        await configureHarness(h, { ...configuration, bindingId: "binding-new" });
        await writeJsonl(h.peer, agentRequest);
        const current = { ...agentRequest, bindingId: "binding-new" };
        const emitted = new Promise<BridgeAgentRequest>((resolve) =>
          h.proc.once("agent_request", resolve),
        );
        await writeJsonl(h.peer, current);
        await expect(emitted).resolves.toEqual(current);
        expect(seen).toEqual([current]);
        h.proc.replyAgent({
          type: "agent.result",
          requestId: current.requestId,
          runtimeId: current.runtimeId,
          bindingId: configuration.bindingId,
          ok: true,
          result: "old",
        });
        h.proc.replyAgent({
          type: "agent.result",
          requestId: current.requestId,
          runtimeId: current.runtimeId,
          bindingId: current.bindingId,
          ok: true,
          result: "new",
        });
        await vi.waitFor(() =>
          expect(h.records.filter((r) => r.type === "agent.result")).toHaveLength(1),
        );
        expect(h.records.find((r) => r.type === "agent.result")).toMatchObject({
          bindingId: "binding-new",
          result: "new",
        });
      } finally {
        h.cleanup();
      }
    });

    it("handles cancellation, timeout, rejected receipts and runtime replacement", async () => {
      const h = await bridgeHarness(transport);
      try {
        await expect(
          h.proc.bridgeRequest("input.human", { humanInputId: "human" }, { timeoutMs: 10 }),
        ).rejects.toMatchObject({ code: "timeout" });
        const ac = new AbortController();
        const canceled = h.proc.bridgeRequest("delivery.status", statusArgs, { signal: ac.signal });
        const canceledAssertion = expect(canceled).rejects.toMatchObject({ code: "conflict" });
        ac.abort();
        await canceledAssertion;
        const failed = h.proc.bridgeRequest("delivery.accept", acceptArgs);
        const failedAssertion = expect(failed).rejects.toMatchObject({
          code: "conflict",
          message: "denied",
        });
        await vi.waitFor(() =>
          expect(h.records.filter((r) => r.type === "bridge.command")).toHaveLength(3),
        );
        const local = h.records.filter((r) => r.type === "bridge.command").at(-1);
        await writeJsonl(
          h.peer,
          receipt(local, { ok: false, error: { code: "conflict", message: "denied" } }),
        );
        await failedAssertion;
        const pending = h.proc.bridgeRequest("configure", configuration);
        const assertion = expect(pending).rejects.toMatchObject({ code: "host_unreachable" });
        await writeJsonl(h.peer, { ...features, runtimeId: "runtime-b" });
        await assertion;
        const seen: unknown[] = [];
        h.proc.on("agent_request", (frame) => seen.push(frame));
        await writeJsonl(h.peer, agentRequest);
        // A receipt on this same reader gives a deterministic barrier after the stale request.
        await configureHarness(h, {
          ...configuration,
          runtimeId: "runtime-b",
          bindingId: "binding-b",
        });
        expect(seen).toEqual([]);
      } finally {
        h.cleanup();
      }
    });
  });
}

it("RPC controller replacement fences replies from a previous socket", async () => {
  const h = await bridgeHarness("rpc");
  const rpc = h.proc as PiRpcProcess;
  const second = await connected(rpc.bridgeSocket!);
  const otherRecords: unknown[] = [];
  JsonlReader.attach(second, (record) => otherRecords.push(record));
  try {
    const emitted = new Promise<void>((resolve) => h.proc.once("agent_request", () => resolve()));
    await writeJsonl(h.peer, agentRequest);
    await emitted;
    // The same extension can reconnect before a still-open originating socket has closed.
    const reannounced = new Promise<void>((resolve) =>
      h.proc.once("bridge_features", () => resolve()),
    );
    await writeJsonl(second, features);
    await reannounced;
    h.proc.replyAgent({
      type: "agent.result",
      requestId: agentRequest.requestId,
      runtimeId: features.runtimeId,
      bindingId: configuration.bindingId,
      ok: true,
      result: "origin",
    });
    // The old reply cannot cross controller replacement, even for the same runtime/native id.
    expect(h.records.some((r) => r.type === "agent.result")).toBe(false);
    expect(otherRecords).toEqual([]);
  } finally {
    second.destroy();
    h.cleanup();
  }
});

it("policy waits preserve busy state and actual bridge protection needs a configure receipt", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sy-state-"));
  dirs.push(cwd);
  const ms = new ManagedSession({
    sessionId: "ses_fake",
    cwd,
    title: "Fake",
    piBin: fakePi,
    profile: {
      provider: "mock",
      model: "mock-1",
      thinking: null,
      projectTrust: "ask",
      extraArgs: [],
    },
  });
  await ms.start();
  try {
    expect(ms.snapshot().bridge).toBeNull();
    const proc = ms.process!;
    proc.emit("bridge_features", features);
    expect(ms.snapshot().bridge?.policyState).toBe("initializing");
    vi.spyOn(proc, "bridgeRequest").mockResolvedValue(configured);
    await ms.configureAgent(configuration);
    expect(ms.snapshot().bridge?.policyState).toBe("active");
    proc.emit("event", { type: "agent_start" });
    ms.setPolicyWaiting("decision-a", true);
    ms.setPolicyWaiting("decision-b", true);
    expect(ms.runtime).toBe("waiting_input");
    expect(ms.snapshot().policyWaiting).toEqual(["decision-a", "decision-b"]);
    ms.setPolicyWaiting("decision-a", false);
    expect(ms.runtime).toBe("waiting_input");
    ms.setPolicyWaiting("decision-b", false);
    expect(ms.runtime).toBe("running");
    ms.setPolicyWaiting("decision-a", true);
    proc.emit("event", {
      type: "switchyard_native",
      sessionId: "native-new",
      sessionFile: "/tmp/native-new.jsonl",
    });
    expect(ms.snapshot().bridge?.policyState).toBe("lost");
    expect(ms.snapshot().policyWaiting).toEqual([]);
    const requests: unknown[] = [];
    ms.on("agent_request", (frame) => requests.push(frame));
    proc.emit("agent_request", agentRequest);
    expect(requests).toEqual([]);
  } finally {
    await ms.stop({ graceMs: 100, termMs: 500 });
  }
});

it.each(["idle", "running", "waiting_input"] as const)(
  "terminal detach preserves live runtime from %s and reattachment requires a new configure receipt",
  async (runtime) => {
    const dir = mkdtempSync(join(tmpdir(), "sy-reattach-"));
    dirs.push(dir);
    const path = join(dir, "holder.sock");
    const peers: Socket[] = [];
    let announce = true;
    const server = createServer((socket) => {
      peers.push(socket);
      JsonlReader.attach(socket, (record) => {
        const rec = record as any;
        if (rec.role === "control") {
          void writeJsonl(socket, { type: "extension_hello", remoteDialogs: true });
          if (announce) void writeJsonl(socket, features);
        } else if (rec.type === "get_state") {
          void writeJsonl(socket, {
            type: "response",
            id: rec.id,
            success: true,
            data: {
              sessionId: features.nativeSessionId,
              sessionFile: "/tmp/native-a.jsonl",
              isStreaming: false,
            },
          });
        } else if (rec.type === "bridge.command") {
          void writeJsonl(socket, receipt(rec, { ok: true, result: configured }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(path, resolve));
    const ms = new ManagedSession({
      sessionId: "ses_fake",
      cwd: dir,
      title: "Fake",
      transport: "terminal",
      terminalSocket: path,
      profile: {
        provider: "mock",
        model: "mock-1",
        thinking: null,
        projectTrust: "ask",
        extraArgs: [],
      },
    });
    try {
      await ms.start();
      expect(ms.snapshot().bridge?.policyState).toBe("initializing");
      await ms.configureAgent(configuration);
      expect(ms.snapshot().bridge?.policyState).toBe("active");
      if (runtime !== "idle") ms.process!.emit("event", { type: "agent_start" });
      if (runtime === "waiting_input") ms.setPolicyWaiting("decision-detach", true);
      expect(ms.runtime).toBe(runtime);
      const changes = vi.fn();
      const lost = vi.fn();
      ms.on("runtime", changes);
      ms.on("bridge_lost", lost);
      ms.detach();
      expect(ms.isAlive).toBe(false);
      expect(ms.runtime).toBe(runtime === "idle" ? "idle" : "running");
      expect(changes.mock.calls.every(([change]) => change.runtime !== "starting")).toBe(true);
      expect(ms.snapshot().bridge?.policyState).toBe("lost");
      expect(ms.bridgeFeatures).toBeNull();
      expect(ms.snapshot().policyWaiting).toEqual([]);
      expect(lost).toHaveBeenCalledTimes(1);
      announce = false;
      await ms.start();
      expect(ms.snapshot().bridge).toBeNull();
      await expect(ms.configureAgent(configuration)).rejects.toMatchObject({
        code: "unsupported_capability",
      });
      const reannounced = new Promise<void>((resolve) =>
        ms.once("bridge_features", () => resolve()),
      );
      await writeJsonl(peers.at(-1)!, features);
      await reannounced;
      expect(ms.snapshot().bridge?.policyState).toBe("initializing");
      await ms.configureAgent({ ...configuration, bindingId: "binding-reattached" });
      expect(ms.snapshot().bridge?.policyState).toBe("active");
    } finally {
      if (ms.process) ms.detach();
      for (const peer of peers) peer.destroy();
      server.close();
    }
  },
);

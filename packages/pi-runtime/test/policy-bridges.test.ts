import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import bridge from "../src/bridge/switchyard-bridge.js";
import terminal from "../src/bridge/switchyard-terminal.js";
import { parseBridgeRecord } from "../src/bridge-wire.js";
import { JsonlReader } from "../src/jsonl.js";

// Exercise both real entry points over their actual socket lane: no competing test protocol.
describe.each([
  ["rpc", "SWITCHYARD_BRIDGE_SOCKET", bridge],
  ["terminal", "SWITCHYARD_CONTROL_SOCKET", terminal],
] as const)("%s policy integration", (mode, variable, extension) => {
  it.each(["DENY", "ASK_ALLOW", "ASK_DENY"])(
    "installs before configure and awaits %s on the actual socket lane",
    async (verdict) => {
      const dir = mkdtempSync(join(tmpdir(), "sy-policy-"));
      const socketPath = join(dir, "p.sock");
      const records: any[] = [];
      const sockets: Socket[] = [];
      const server = createServer((socket) => {
        sockets.push(socket);
        JsonlReader.attach(socket, (record) => records.push(record));
      });
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      const previousSocket = process.env[variable];
      const previousRequired = process.env.SWITCHYARD_POLICY_REQUIRED;
      const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
      const controller = new AbortController();
      const notify = vi.fn();
      const ctx = {
        signal: controller.signal,
        ui: { getEditorText: () => "", notify },
        sessionManager: {
          getSessionId: () => "native",
          getSessionFile: () => null,
          getEntries: () => [],
          getBranch: () => [],
        },
      };
      const emit = async (name: string, event: any) => {
        for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
      };
      try {
        process.env[variable] = socketPath;
        process.env.SWITCHYARD_POLICY_REQUIRED = "1";
        extension({
          on: (name: string, handler: (event: any, ctx: any) => any) => {
            handlers.set(name, [...(handlers.get(name) ?? []), handler]);
            return () => {};
          },
          registerTool: vi.fn(),
          registerCommand: vi.fn(),
          appendEntry: vi.fn(),
          sendMessage: vi.fn(),
        });
        expect(handlers.get("tool_call")).toHaveLength(1);
        expect(handlers.get("cache_warming_decision")![0]!({}, ctx)).toEqual({ action: "stop" });
        // Start before any configuration: this must be a real awaited block, not a void wrapper.
        const policy = handlers.get("tool_call")![0]!(
          { toolCallId: "call", toolName: "bash", input: { command: "echo hi" } },
          ctx,
        );
        let finished = false;
        void policy.then(() => {
          finished = true;
        });
        await emit("session_start", { reason: "startup" });
        await vi.waitFor(() => expect(records.some((r) => r.type === "agent.hello")).toBe(true));
        const hello = records.find((r) => r.type === "agent.hello");
        expect(parseBridgeRecord(hello)).toEqual(hello);
        expect(hello).toMatchObject({
          mode,
          nativeSessionId: "native",
          capabilities: { toolPolicy: true },
        });
        expect(finished).toBe(false);
        const send = (record: unknown) => sockets[0]!.write(`${JSON.stringify(record)}\n`);
        send({
          type: "bridge.command",
          requestId: "configure",
          runtimeId: hello.runtimeId,
          nativeSessionId: "native",
          bindingId: "binding",
          method: "configure",
          args: {
            version: 1,
            sessionId: "session",
            runtimeId: hello.runtimeId,
            nativeSessionId: "native",
            bindingId: "binding",
            features: ["agentRequests.v1", "policies.v1"],
            coordinatorConnected: true,
            policyRequired: true,
            sessionUrl: "http://localhost/code/session",
          },
        });
        await vi.waitFor(() => expect(records.some((r) => r.type === "agent.request")).toBe(true));
        const receipt = records.find((r) => r.type === "bridge.receipt");
        expect(parseBridgeRecord(receipt)).toEqual(receipt);
        expect(receipt.result).toMatchObject({
          configured: true,
          policyRequired: true,
          policyState: "active",
          policyPhases: ["tool_call", "request"],
        });
        const request = records.find((r) => r.type === "agent.request");
        expect(parseBridgeRecord(request)).toEqual(request);
        expect(request).toMatchObject({
          method: "policy.evaluate",
          toolCallId: "call",
          args: { toolCallId: "call", tool: { name: "bash", args: { command: "echo hi" } } },
        });
        const reply = (request: any, result: unknown) =>
          send({
            type: "agent.result",
            requestId: request.requestId,
            runtimeId: hello.runtimeId,
            bindingId: "binding",
            ok: true,
            result,
          });
        if (verdict === "DENY") {
          reply(request, { verdict: "DENY", reason: "Protected command" });
        } else {
          reply(request, {
            verdict: "ASK",
            decisionId: "decision",
            interactionId: "interaction",
            interactionUrl: "https://switchyard.test/code/session",
          });
          await vi.waitFor(() =>
            expect(records.some((r) => r.method === "policy.status")).toBe(true),
          );
          reply(
            records.find((r) => r.method === "policy.status"),
            { state: "allowed" },
          );
          await vi.waitFor(() =>
            expect(records.filter((r) => r.method === "policy.evaluate")).toHaveLength(2),
          );
          expect(finished).toBe(false);
          const refreshed = records.filter((r) => r.method === "policy.evaluate")[1];
          expect(parseBridgeRecord(refreshed)).toEqual(refreshed);
          expect(refreshed.args).toEqual(request.args);
          expect(refreshed.toolCallId).toBe(request.toolCallId);
          expect(notify).toHaveBeenCalledTimes(1);
          reply(
            refreshed,
            verdict === "ASK_ALLOW"
              ? { verdict: "ALLOW" }
              : { verdict: "DENY", reason: "Protected command" },
          );
        }
        if (verdict === "ASK_ALLOW") await expect(policy).resolves.toBeUndefined();
        else
          await expect(policy).resolves.toEqual({
            block: true,
            terminate: true,
            reason: "Protected command",
          });
      } finally {
        controller.abort();
        await emit("session_shutdown", {});
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        if (previousSocket === undefined) delete process.env[variable];
        else process.env[variable] = previousSocket;
        if (previousRequired === undefined) delete process.env.SWITCHYARD_POLICY_REQUIRED;
        else process.env.SWITCHYARD_POLICY_REQUIRED = previousRequired;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

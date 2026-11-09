import { createHash } from "node:crypto";
import type { AgentBindingIdentity, AgentChannel } from "./agent-channel.js";
import {
  type AgentToolPreflightOwner,
  agentToolMethod,
  beginAgentToolPreflight,
  clearAgentToolPreflights,
  DuplicateAgentToolPreflightError,
  releaseAgentToolPreflight,
  rememberAgentToolPreflight,
  requireAgentToolPreflight,
  sweepUnclaimedAgentToolPreflights,
  toolArgs,
} from "./tool-preflight.js";

type ToolCall = { toolCallId: string; toolName: string; input: unknown };
type PolicyContext = {
  signal?: AbortSignal;
  isIdle?(): boolean;
  sessionManager?: { getSessionId(): string };
  ui?: { notify(message: string, type?: string): void };
};
type Block = { block: true; reason: string; terminate: boolean };
type PolicyPi = {
  on(
    name: "tool_call",
    handler: (event: ToolCall, ctx: PolicyContext) => Promise<Block | undefined>,
  ): unknown;
  on(name: "cache_warming_decision", handler: () => { action: "stop" }): unknown;
  on(name: "agent_settled", handler: (event: unknown, ctx: PolicyContext) => void): unknown;
  on(name: "session_shutdown", handler: () => void): unknown;
};
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid policy reply.");
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value.length) throw new Error("Invalid policy reply.");
  return value;
}

/**
 * Install synchronously, before sockets/configuration or prompts. Pi 1.5 awaits tool_call and
 * exposes the streaming abort signal on ctx.signal (including Escape in the terminal).
 * No provider authorization is claimed. These are guardrails: a later trusted extension can
 * mutate tool input after us or override the cache-warming stop decision.
 */
export function installPolicyHooks(pi: PolicyPi, channel: AgentChannel): true {
  if (typeof pi.on !== "function")
    throw new Error("Switchyard policies require Pi's awaited tool_call hook API (Pi 1.5).");

  let protectedActionSeen = false;
  pi.on("tool_call", async (event, ctx) => {
    let decisionId: string | null = null;
    let binding: AgentBindingIdentity | null = null;
    let cancelSent = false;
    let owner: AgentToolPreflightOwner | undefined;
    const cancel = () => {
      if (!decisionId || !binding || cancelSent) return;
      cancelSent = true;
      // Cancellation never waits for a disconnected coordinator or reuses the aborted signal.
      void channel
        .request("policy.cancel", { decisionId }, { timeoutMs: 1000, binding })
        .catch(() => {});
    };
    const signal = ctx.signal;
    try {
      const state = channel.snapshot();
      if (state.configuration) {
        const { sessionId, runtimeId, nativeSessionId, bindingId } = state.configuration;
        binding = { sessionId, runtimeId, nativeSessionId, bindingId };
      }
      protectedActionSeen ||= state.policyState === "active" || state.policyState === "lost";
      if (
        !state.policyRequired &&
        !protectedActionSeen &&
        (state.policyState === "initializing" || state.policyState === "unsupported")
      )
        return;

      requireAgentToolPreflight(channel);
      const toolCallId = text(event.toolCallId);
      const name = text(event.toolName);
      const args = toolArgs(event.input);
      const method = agentToolMethod(channel, name);
      if (method) owner = beginAgentToolPreflight(channel, method, toolCallId, args, signal);
      const normalized = JSON.stringify(args);
      const nativeAtStart = ctx.sessionManager?.getSessionId();
      const deadline = Date.now() + 30000;
      signal?.addEventListener("abort", cancel, { once: true });
      const configuration = await channel.waitReady({
        require: "policies",
        binding: binding ?? undefined,
        signal,
        timeoutMs: 30000,
      });
      if (!binding) {
        const { sessionId, runtimeId, nativeSessionId, bindingId } = configuration;
        binding = { sessionId, runtimeId, nativeSessionId, bindingId };
      }
      if (nativeAtStart && nativeAtStart !== binding.nativeSessionId)
        throw new Error("Policy native session changed.");
      protectedActionSeen = true;
      const evaluationId = `pol_${createHash("sha256")
        .update(
          JSON.stringify([binding.sessionId, binding.nativeSessionId, "tool_call", toolCallId]),
        )
        .digest("hex")}`;
      const request = { evaluationId, toolCallId, tool: { name, args } };
      const checkAction = () => {
        if (signal?.aborted) throw new Error("Policy approval canceled.");
        const current = channel.snapshot();
        if (
          !binding ||
          current.policyState !== "active" ||
          current.configuration?.sessionId !== binding.sessionId ||
          current.configuration.runtimeId !== binding.runtimeId ||
          current.configuration.nativeSessionId !== binding.nativeSessionId ||
          current.configuration.bindingId !== binding.bindingId ||
          (ctx.sessionManager && ctx.sessionManager.getSessionId() !== binding.nativeSessionId)
        )
          throw new Error("Policy binding changed or coordinator communication was lost.");
        if (
          event.toolCallId !== toolCallId ||
          event.toolName !== name ||
          JSON.stringify(toolArgs(event.input)) !== normalized
        )
          throw new Error(
            "Tool input changed during policy authorization; the action was blocked.",
          );
      };
      const remaining = () => {
        const ms = deadline - Date.now();
        if (ms <= 0) throw new Error("Coordinator communication timed out.");
        return ms;
      };
      checkAction();
      if (owner) {
        const method = owner.method;
        const peek = record(
          await channel.request(
            "receipt.peek",
            { method, args },
            { toolCallId, signal, binding, timeoutMs: remaining() },
          ),
        );
        if (
          (peek.found !== false && peek.found !== true) ||
          Object.keys(peek).length !== (peek.found ? 2 : 1) ||
          (peek.found &&
            (typeof peek.requestHash !== "string" || !/^[a-f0-9]{64}$/.test(peek.requestHash)))
        )
          throw new Error("Invalid tool receipt lookup reply.");
        checkAction();
        if (peek.found) {
          rememberAgentToolPreflight(channel, owner, {
            method,
            toolCallId,
            binding,
            mode: "receipt",
            requestHash: peek.requestHash as string,
          });
          checkAction();
          return;
        }
      }
      const evaluation = record(
        await channel.request("policy.evaluate", request, {
          toolCallId,
          signal,
          binding,
          timeoutMs: remaining(),
        }),
      );

      if (evaluation.verdict === "DENY") throw new Error(text(evaluation.reason));
      if (evaluation.verdict === "ASK") {
        decisionId = text(evaluation.decisionId);
        text(evaluation.interactionId);
        const url = new URL(text(evaluation.interactionUrl));
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
          throw new Error("Invalid policy approval URL.");
        if (signal?.aborted) throw new Error("Policy approval canceled.");
        ctx.ui?.notify(`Approval required in Switchyard: ${evaluation.interactionUrl}`, "warning");
        while (true) {
          // Each successful 25-second long poll is healthy communication. There is no deadline
          // on the human's answer; the channel bounds each communication loss to 30 seconds.
          const status = record(
            await channel.request(
              "policy.status",
              { decisionId, waitMs: 25000 },
              { signal, timeoutMs: 30000, binding },
            ),
          );
          // This is the whole authorization: successive ASK rules remain pending under the
          // same decisionId. Never treat an individual interaction answer as permission.
          if (status.state === "allowed") break;
          if (status.state === "denied" || status.state === "canceled")
            throw new Error(text(status.reason));
          if (status.state !== "pending") throw new Error("Invalid policy status reply.");
        }
        checkAction();
        // Refresh host proof once after the WHOLE authorization completes. Reuse the exact
        // logical action so the service replays ALLOW without another permission/counter update.
        // A changed authorization must fail closed, not start another ASK/refresh loop.
        const refreshed = record(
          await channel.request("policy.evaluate", request, {
            toolCallId,
            signal,
            binding,
            timeoutMs: 30000,
          }),
        );
        if (refreshed.verdict === "DENY") throw new Error(text(refreshed.reason));
        if (refreshed.verdict === "ASK")
          throw new Error("Policy authorization changed after approval; the action was blocked.");
        if (refreshed.verdict !== "ALLOW") throw new Error("Invalid policy evaluation reply.");
      } else if (evaluation.verdict !== "ALLOW") {
        throw new Error("Invalid policy evaluation reply.");
      }

      checkAction();
      if (owner)
        rememberAgentToolPreflight(channel, owner, {
          method: owner.method,
          toolCallId,
          binding,
          mode: "normal",
        });
      return;
    } catch (error) {
      if (owner) releaseAgentToolPreflight(channel, owner);
      if (error instanceof DuplicateAgentToolPreflightError)
        return { block: true, reason: "Tool preflight is already active", terminate: false };
      cancel();
      return {
        block: true,
        terminate: true,
        reason: signal?.aborted
          ? "Policy approval canceled."
          : error instanceof Error
            ? error.message
            : "Policy enforcement is unavailable.",
      };
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  });
  pi.on("agent_settled", (_event, ctx) => {
    // End events cannot identify an invocation. Only a proven final idle retires handoffs
    // abandoned by a later trusted hook, and never an adapter still awaiting its result.
    if (ctx.isIdle?.() === true) sweepUnclaimedAgentToolPreflights(channel);
  });
  pi.on("session_shutdown", () => clearAgentToolPreflights(channel));
  // Synchronous and network-free. Last override wins in Pi; trusted extensions can override us.
  pi.on("cache_warming_decision", () => ({ action: "stop" }));
  return true;
}

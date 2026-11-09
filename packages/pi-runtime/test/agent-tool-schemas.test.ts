import { afterEach, describe, expect, it } from "vitest";
import { createAgentChannel } from "../src/bridge/agent-channel.js";
import { registerAgentTools } from "../src/bridge/agent-tools.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

// Assert the schemas handed to Pi, not the separate protocol/Zod argument schemas.
function registeredTools(mode: "rpc" | "terminal") {
  const channel = createAgentChannel({
    send: () => true,
    getContext: () => null,
    appendEntry: () => {},
    mode,
    getCapabilities: () => ({
      agentTools: true,
      messageDelivery: true,
      editorDraftGuard: true,
      toolPolicy: true,
    }),
    policyRequired: false,
  });
  cleanup.push(() => channel.close());
  const tools: any[] = [];
  registerAgentTools({ registerTool: (tool: any) => tools.push(tool) }, channel);
  expect(tools.map((tool) => tool.name)).toEqual([
    "switchyard_create_task",
    "switchyard_send",
    "switchyard_inbox",
  ]);
  for (const tool of tools) {
    expect(tool.execute).toHaveLength(5);
    expect(JSON.parse(JSON.stringify(tool.parameters))).toEqual(tool.parameters);
  }
  return Object.fromEntries(tools.map((tool) => [tool.name, tool.parameters]));
}

const boundedId = { type: "string", minLength: 1, maxLength: 200 };

describe.each(["rpc", "terminal"] as const)("registered agent tool JSON schemas (%s)", (mode) => {
  it("requires only the objective and preserves all create bounds/defaults and nullable parent", () => {
    const schemas = registeredTools(mode);
    expect(schemas.switchyard_create_task).toEqual({
      type: "object",
      properties: {
        objective: { type: "string", minLength: 1, maxLength: 16000 },
        acceptance: {
          type: "array",
          maxItems: 100,
          items: { type: "string", minLength: 1, maxLength: 2000 },
          default: [],
        },
        dependencies: { type: "array", maxItems: 100, items: boundedId, default: [] },
        parentTaskId: { anyOf: [boundedId, { type: "null" }] },
        hostId: boundedId,
        profileId: boundedId,
        notifyOnFinish: { type: "boolean", default: true },
      },
      required: ["objective"],
      additionalProperties: false,
    });
  });

  it("requires recipient, body and mode, bounds reply identity, and exposes only steer/queue", () => {
    const schemas = registeredTools(mode);
    expect(schemas.switchyard_send).toEqual({
      type: "object",
      properties: {
        sessionId: boundedId,
        body: { type: "string", minLength: 1, maxLength: 16000 },
        mode: { type: "string", enum: ["steer", "queue"] },
        replyTo: boundedId,
      },
      required: ["sessionId", "body", "mode"],
      additionalProperties: false,
    });
  });

  it("keeps inbox pagination optional with integer lower/upper bounds and defaults", () => {
    const schemas = registeredTools(mode);
    expect(schemas.switchyard_inbox).toEqual({
      type: "object",
      properties: {
        after: { type: "integer", minimum: 0, default: 0 },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      },
      additionalProperties: false,
    });
  });
});

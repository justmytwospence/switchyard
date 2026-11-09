import { describe, expect, it } from "vitest";
import {
  CAPABILITY_KEYS,
  ClientToServer,
  CoordinatorToHost,
  DEFAULT_TASK_POLICY,
  EVENT_TYPES,
  EventDataSchemas,
  EventTypeSchema,
  Host,
  HostToCoordinator,
  Interaction,
  PROTOCOL_VERSION,
  RuntimeCapabilities,
  ServerToClient,
  Session,
  Task,
  Workspace,
} from "../src/index.js";

const at = "2026-01-01T00:00:00.000Z";
const capabilities = {
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
  unsupported: [],
} satisfies RuntimeCapabilities;
const host = {
  id: "host",
  name: "Legacy host",
  platform: "darwin",
  agentVersion: "0.11.0",
  piVersion: "1.4.0",
  piCompatible: true,
  capabilities,
  connectivity: "connected",
  lastSeenAt: at,
  revokedAt: null,
  createdAt: at,
} satisfies Host;
const workspace = {
  id: "workspace",
  checkoutId: "checkout",
  projectId: "project",
  hostId: host.id,
  path: "/repo",
  branch: "dev",
  baseBranch: "main",
  provenance: "managed",
  git: { dirty: false, changedFiles: 0, ahead: 0, behind: 0, unmerged: false },
  setup: { state: "none", log: "" },
  archivedAt: null,
  updatedAt: at,
} satisfies Workspace;
const session = {
  id: "session",
  title: "Legacy session",
  subtitle: null,
  hostId: host.id,
  workspaceId: workspace.id,
  projectId: workspace.projectId,
  cwd: workspace.path,
  nativeHandle: null,
  profileSnapshot: {
    id: "profile",
    name: "Default",
    provider: null,
    model: null,
    thinking: null,
    projectTrust: "ask",
    extraArgs: [],
  },
  runtime: "idle",
  runtimeDetail: null,
  connectivity: "connected",
  runId: null,
  taskId: null,
  provenance: "created",
  readOnly: false,
  lastActivityAt: at,
  archivedAt: null,
  queue: { steering: [], followUp: [] },
  stats: null,
  lastAssistantText: null,
  createdAt: at,
} satisfies Session;
const task = {
  id: "task",
  projectId: workspace.projectId,
  title: "Legacy task",
  objective: "Test compatibility",
  acceptanceCriteria: [],
  dependencies: [],
  priority: 2,
  position: 0,
  state: "ready",
  blocked: null,
  notBefore: null,
  policy: DEFAULT_TASK_POLICY,
  origin: { kind: "manual" },
  groupingKey: null,
  currentRunId: null,
  sessionId: null,
  review: { feedback: [], changesRequested: false },
  hiddenFromBoard: false,
  lastActivityAt: at,
  createdAt: at,
  updatedAt: at,
} satisfies Task;
const interaction = {
  id: "interaction",
  sessionId: session.id,
  revision: 1,
  source: { kind: "extension_ui", method: "confirm", piRequestIds: [] },
  adapterId: null,
  title: "Confirm",
  presentation: { t: "text", text: "Continue?" },
  state: "pending",
  resolution: null,
  createdAt: at,
} satisfies Interaction;

const extensions = {
  capabilities: { agentRequests: true, messageDelivery: true, policies: true },
  host: { github: { available: true, reason: null } },
  workspace: {
    github: {
      repository: "owner/repo",
      headRepository: "owner/repo",
      branch: "dev",
      fetchedAt: at,
      attemptedAt: at,
      status: "ready",
      reason: null,
      pullRequest: null,
      checks: [],
      checksComplete: true,
      threads: [],
      threadsComplete: true,
      truncated: false,
    },
  },
  session: {
    bridge: {
      version: 1,
      runtimeId: "runtime",
      nativeSessionId: "native",
      agentTools: true,
      messageDelivery: true,
      policyState: "active",
      policyPhases: ["tool_call", "request"],
    },
  },
  task: {
    parentTaskId: "parent",
    agentOrigin: { sessionId: session.id, toolCallId: "tool" },
    githubIssue: {
      repository: "owner/repo",
      number: 42,
      url: "https://github.com/owner/repo/issues/42",
      launchPrompt:
        "https://github.com/owner/repo/issues/42\n\nRead it with `gh issue view https://github.com/owner/repo/issues/42`.",
    },
  },
  interaction: {
    permission: {
      kind: "policy",
      decisionId: "decision",
      rootTaskId: task.id,
      ruleId: "rule",
      ruleRevision: 1,
      fingerprint: "a".repeat(64),
    },
  },
};

const entityCases = [
  { type: "host.updated", schema: Host, legacy: host, additions: extensions.host },
  {
    type: "workspace.updated",
    schema: Workspace,
    legacy: workspace,
    additions: extensions.workspace,
  },
  { type: "session.updated", schema: Session, legacy: session, additions: extensions.session },
  { type: "task.updated", schema: Task, legacy: task, additions: extensions.task },
  {
    type: "interaction.updated",
    schema: Interaction,
    legacy: interaction,
    additions: extensions.interaction,
  },
] as const;

describe("optional orchestration protocol extensions", () => {
  it("keeps the global wire version unchanged", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it("parses legacy hello/welcome without inventing negotiated features or GitHub availability", () => {
    const hello = {
      type: "hello",
      hostId: host.id,
      credential: "test-only-credential",
      name: host.name,
      agentVersion: host.agentVersion,
      piVersion: host.piVersion,
      piCompatible: host.piCompatible,
      platform: host.platform,
      capabilities,
      protocolVersion: 1,
    };
    const welcome = { type: "welcome", coordinatorVersion: "0.11.0", ackedHostSeq: 7 };
    expect(HostToCoordinator.parse(hello)).toEqual(hello);
    expect(CoordinatorToHost.parse(welcome)).toEqual(welcome);
    for (const features of [[], ["agentRequests.v1", "policies.v1"]]) {
      const extendedHello = {
        ...hello,
        features,
        capabilities: { ...capabilities, ...extensions.capabilities },
        ...extensions.host,
      };
      expect(HostToCoordinator.parse(extendedHello)).toEqual(extendedHello);
      expect(CoordinatorToHost.parse({ ...welcome, features })).toEqual({ ...welcome, features });
    }
    // gh availability is independent of Pi compatibility and feature negotiation.
    const withoutPi = {
      ...hello,
      piVersion: null,
      piCompatible: false,
      capabilities: null,
      ...extensions.host,
    };
    expect(HostToCoordinator.parse(withoutPi)).toEqual(withoutPi);
  });

  it("accepts absent, explicitly disabled and enabled optional runtime capabilities", () => {
    expect(RuntimeCapabilities.parse(capabilities)).toEqual(capabilities);
    for (const enabled of [false, true]) {
      const extended = {
        ...capabilities,
        agentRequests: enabled,
        messageDelivery: enabled,
        policies: enabled,
      };
      expect(RuntimeCapabilities.parse(extended)).toEqual(extended);
    }
    for (const key of ["agentRequests", "messageDelivery", "policies"]) {
      expect(RuntimeCapabilities.safeParse({ ...capabilities, [key]: "true" }).success).toBe(false);
      expect(CAPABILITY_KEYS).not.toContain(key);
    }
  });

  it.each(entityCases)(
    "parses old and extended $type entities on the existing event lane",
    ({ type, schema, legacy, additions }) => {
      expect(schema.parse(legacy)).toEqual(legacy);
      const extended = { ...legacy, ...additions };
      expect(schema.parse(extended)).toEqual(extended);
      for (const data of [legacy, extended]) {
        expect(EventDataSchemas[type].parse(data)).toEqual(data);
        const frame = {
          type: "event",
          event: { seq: 1, id: "event", type, at, data },
        };
        expect(ServerToClient.parse(frame)).toEqual(frame);
      }
    },
  );

  it("keeps missing GitHub state distinct from confirmed unavailability and parent null explicit", () => {
    const unavailable = { ...host, github: { available: false, reason: "gh is not installed" } };
    expect(Host.parse(unavailable)).toEqual(unavailable);
    expect(Host.parse(host)).not.toHaveProperty("github");
    expect(Workspace.parse(workspace)).not.toHaveProperty("github");
    expect(Task.parse(task)).not.toHaveProperty("parentTaskId");
    expect(Task.parse({ ...task, parentTaskId: null })).toEqual({ ...task, parentTaskId: null });
    expect(Task.parse({ ...task, ...extensions.task }).origin).toEqual({ kind: "manual" });
    expect(Interaction.parse({ ...interaction, ...extensions.interaction }).source).toEqual(
      interaction.source,
    );
  });
});

describe("stable client discriminants", () => {
  it("keeps client and server frame types unchanged", () => {
    expect(ClientToServer.options.map((option) => option.shape.type.value).sort()).toEqual([
      "hello",
      "ping",
      "presence",
    ]);
    expect(ServerToClient.options.map((option) => option.shape.type.value).sort()).toEqual([
      "event",
      "force_logout",
      "pong",
      "replay",
      "snapshot",
      "stream",
    ]);
  });

  it("keeps the durable event type set unchanged", () => {
    const expected = [
      "host.updated",
      "project.updated",
      "project.deleted",
      "checkout.updated",
      "workspace.updated",
      "workspace.deleted",
      "profile.updated",
      "profile.deleted",
      "view.updated",
      "view.deleted",
      "session.updated",
      "transcript.item",
      "transcript.reset",
      "interaction.updated",
      "panel.updated",
      "adapters.updated",
      "diagnostic",
      "task.updated",
      "task.deleted",
      "run.updated",
      "automation.updated",
      "automation.deleted",
      "occurrence.created",
      "occurrence.updated",
      "attention.updated",
      "device.updated",
      "settings.updated",
    ];
    expect([...EVENT_TYPES].sort()).toEqual(expected.sort());
    for (const type of expected) expect(EventTypeSchema.parse(type)).toBe(type);
    for (const type of [
      "agent.request",
      "agent.result",
      "message.created",
      "policy.updated",
      "github.updated",
    ]) {
      expect(EventTypeSchema.safeParse(type).success).toBe(false);
    }
  });
});

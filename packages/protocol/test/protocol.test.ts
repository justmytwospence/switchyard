import { describe, expect, it } from "vitest";
import {
  branchSlug,
  CAPABILITY_KEYS,
  CoordinatorToHost,
  DEFAULT_WORKTREE_DIR,
  DeviceKind,
  HostCommand,
  isFieldVisible,
  isPlaceholderTitle,
  newId,
  Profile,
  parseFrameMessage,
  RuntimeCapabilities,
  Session,
  SwitchyardError,
  titleFrom,
  type UINode,
  validateUINode,
} from "../src/index.js";

describe("ids", () => {
  it("prefixes and sorts", () => {
    const a = newId("ses");
    const b = newId("ses");
    expect(a.startsWith("ses_")).toBe(true);
    expect(a < b).toBe(true);
  });
  it("slugs branches", () => {
    expect(branchSlug("feat/x/y")).toBe("feat-x-y");
  });
});

describe("ui", () => {
  it("round-trips a form", () => {
    const node: UINode = {
      t: "section",
      title: "Q",
      children: [
        {
          t: "form",
          formId: "f",
          submitLabel: "Submit",
          fields: [
            { kind: "select", name: "a", label: "A", options: [{ value: "x", label: "X" }] },
            {
              kind: "multiselect",
              name: "b",
              label: "B",
              options: [{ value: "y", label: "Y" }],
              showIf: { field: "a", values: ["x"] },
            },
          ],
        },
      ],
    };
    expect(validateUINode(node)).toEqual(node);
  });
  it("rejects deep trees", () => {
    let node: UINode = { t: "text", text: "leaf" };
    for (let i = 0; i < 13; i++) node = { t: "section", children: [node] };
    expect(() => validateUINode(node)).toThrow(SwitchyardError);
  });
  it("rejects huge trees", () => {
    const items: UINode[] = Array.from({ length: 2001 }, () => ({ t: "text", text: "x" }));
    expect(() => validateUINode({ t: "list", items })).toThrow(/2000/);
  });
  it("evaluates showIf", () => {
    const f = {
      kind: "text" as const,
      name: "c",
      label: "C",
      showIf: { field: "a", values: ["x"] },
    };
    expect(isFieldVisible(f, { a: "x" })).toBe(true);
    expect(isFieldVisible(f, { a: "z" })).toBe(false);
    expect(isFieldVisible(f, { a: ["z", "x"] })).toBe(true);
    expect(isFieldVisible(f, {})).toBe(false);
  });
});

describe("wire", () => {
  it("parses commands", () => {
    const cmd = HostCommand.parse({
      type: "session.prompt",
      sessionId: "ses_1",
      text: "hi",
      mode: "steer",
      origin: "human",
      controlRevision: 1,
    });
    expect(cmd.type).toBe("session.prompt");
    const frame = CoordinatorToHost.parse({ type: "command", commandId: "cmd_1", command: cmd });
    expect(frame.type).toBe("command");
  });
  it("rejects managed profile flags", () => {
    const base = {
      id: "prf_1",
      name: "p",
      provider: null,
      model: null,
      thinking: null,
      projectTrust: "ask",
    };
    expect(Profile.safeParse({ ...base, extraArgs: ["--verbose"] }).success).toBe(true);
    expect(Profile.safeParse({ ...base, extraArgs: ["--session=x"] }).success).toBe(false);
    expect(Profile.safeParse({ ...base, extraArgs: ["--mode"] }).success).toBe(false);
  });
});

describe("session controls", () => {
  const base = {
    id: "ses_1",
    title: "t",
    subtitle: null,
    hostId: "hst_1",
    workspaceId: null,
    projectId: null,
    cwd: "/x",
    nativeHandle: null,
    profileSnapshot: {
      id: "prf_1",
      name: "p",
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
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    queue: { steering: [], followUp: [] },
    stats: { tokens: 1, costUsd: 0 },
    lastAssistantText: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  it("parses sessions with and without live model fields", () => {
    expect(Session.safeParse(base).success).toBe(true);
    const live = {
      ...base,
      stats: { tokens: 1, costUsd: 0, context: { tokens: null, window: 1000, percent: null } },
      model: {
        provider: "mock",
        id: "m",
        name: null,
        contextWindow: 1000,
        reasoning: true,
        thinkingLevels: ["off", "high"],
      },
      thinking: "high",
      compacting: false,
    };
    expect(Session.safeParse(live).success).toBe(true);
  });
  it("parses the session control commands", () => {
    for (const c of [
      { type: "session.models", sessionId: "s" },
      { type: "session.commands", sessionId: "s" },
      { type: "session.complete", sessionId: "s", text: "/model " },
      { type: "session.tree", sessionId: "s" },
      { type: "session.branch", sessionId: "s", entryId: null, fork: false },
      { type: "session.reload", sessionId: "s" },
      { type: "session.export", sessionId: "s" },
      { type: "session.setModel", sessionId: "s", provider: "a", modelId: "b" },
      { type: "session.setThinking", sessionId: "s", level: "high" },
      { type: "session.compact", sessionId: "s", instructions: null },
    ]) {
      expect(HostCommand.safeParse(c).success).toBe(true);
    }
    expect(
      HostCommand.safeParse({ type: "session.setThinking", sessionId: "s", level: "bogus" })
        .success,
    ).toBe(false);
  });
});

describe("titles", () => {
  it("titleFrom takes the first line, truncates at 80 and falls back", () => {
    expect(titleFrom("")).toBe("New session");
    expect(titleFrom(" \n ")).toBe("New session");
    expect(titleFrom("Fix bug\nmore")).toBe("Fix bug");
    const eighty = "x".repeat(80);
    expect(titleFrom(eighty)).toBe(eighty);
    const long = titleFrom("y".repeat(81));
    expect(long).toBe(`${"y".repeat(77)}...`);
    expect(long).toHaveLength(80);
    expect(titleFrom("", "Untitled")).toBe("Untitled");
    expect(isPlaceholderTitle("New session")).toBe(true);
    expect(isPlaceholderTitle("Untitled session")).toBe(true);
    expect(isPlaceholderTitle("New session 2")).toBe(false);
  });
});

describe("shared schemas", () => {
  it("derives CAPABILITY_KEYS from the core capabilities, in display order", () => {
    expect([...CAPABILITY_KEYS]).toEqual([
      "prompt",
      "steer",
      "followUp",
      "abort",
      "resume",
      "rename",
      "importInactive",
      "extensionDialogs",
      "customUi",
      "widgetsText",
      "widgetsComponent",
      "tokenAccounting",
      "costAccounting",
    ]);
    const caps = Object.fromEntries(CAPABILITY_KEYS.map((k) => [k, true]));
    expect(RuntimeCapabilities.safeParse({ ...caps, unsupported: [] }).success).toBe(true);
  });

  it("names the shared enums and defaults", () => {
    expect(DEFAULT_WORKTREE_DIR).toBe(".worktrees");
    expect(DeviceKind.extract(["browser", "pwa"]).safeParse("cli").success).toBe(false);
    const cmd = HostCommand.parse({ type: "workspace.discover", checkoutPath: "/r" });
    expect(cmd).toMatchObject({ worktreeDir: ".worktrees" });
  });
});

describe("frame bridge", () => {
  it("validates frame messages", () => {
    expect(parseFrameMessage({ type: "resize", height: 120 })).toEqual({
      type: "resize",
      height: 120,
    });
    expect(parseFrameMessage({ type: "action", actionId: "go", payload: 1 })).toMatchObject({
      actionId: "go",
    });
    for (const bad of [
      { type: "resize", height: 1e9 },
      { type: "resize", height: Number.NaN },
      { type: "resize", height: -1 },
      { type: "resize", height: Number.POSITIVE_INFINITY },
      { type: "action", actionId: "" },
      { type: "action", actionId: "x".repeat(201) },
      { type: "navigate", url: "https://x" },
      null,
      "str",
    ]) {
      expect(parseFrameMessage(bad)).toBeUndefined();
    }
  });
});

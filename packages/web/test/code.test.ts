import type {
  Checkout,
  Host,
  Project,
  Session,
  TrackedIssue,
  TranscriptItem,
  Workspace,
} from "@switchyard/protocol";
import { describe, expect, it } from "vitest";
import { normalizeEntries, normalizeFile } from "../src/features/code/api";
import { prefillDecision } from "../src/features/code/branching";
import {
  activeArgumentHint,
  applyCompletion,
  branchFromPrompt,
  branchProblem,
  buildSessionList,
  buildTimeline,
  CLIENT_COMMANDS,
  clientCommandProblem,
  completionEligible,
  composerBlockReason,
  contextMeter,
  countAfter,
  currentSuggestion,
  effortIndex,
  entrySpacing,
  type FoldedEntry,
  favoriteModels,
  filterCommands,
  fitPanes,
  foldTimeline,
  formatWorkSummary,
  groupModels,
  HOST_OFFLINE_DANGER_MS,
  isSubagentView,
  mergeCommands,
  modelSummary,
  navNeedsInput,
  navOutsideRow,
  navRowCount,
  newSessionDefaults,
  newSessionProject,
  orderProjectsForScope,
  outputPreview,
  parseClientCommand,
  parseDataUrl,
  pendingTitles,
  piControlsAvailable,
  pillModelLabel,
  queuedMessages,
  readNavPresentation,
  rowPreview,
  STATUS_BUCKETS,
  scopeNote,
  sendModes,
  sendPlan,
  sessionHostIds,
  sessionPlace,
  sessionStatus,
  sessionUsage,
  statusBucket,
  summarizeWork,
  TERMINAL_COMMANDS,
  type TimelineEntry,
  type TranscriptDetail,
  transcriptEntries,
  uniqueBranch,
  workingSince,
  worktreePath,
} from "../src/features/code/model";
import type { StreamBuffer } from "../src/sync/store";
import { assistant, attention, interaction, session } from "./fixtures";

const T0 = "2026-11-01T10:00:00.000Z";

function host(id: string, patch: Partial<Host> = {}): Host {
  return {
    id,
    name: `Host ${id}`,
    platform: "darwin",
    agentVersion: "0.1.0",
    piVersion: "1.4.2",
    piCompatible: true,
    capabilities: null,
    connectivity: "connected",
    lastSeenAt: T0,
    revokedAt: null,
    createdAt: T0,
    ...patch,
  };
}

function project(id: string, name: string): Project {
  return {
    id,
    name,
    repoIdentity: `github.com/x/${name}`,
    defaultProfileId: null,
    defaultHostId: null,
    maxConcurrentRuns: 1,
    automationEnabled: true,
    setupCommand: null,
    checks: [],
    workspaceSharing: "single_writer",
    worktreeDir: ".worktrees",
    createdAt: T0,
    updatedAt: T0,
  };
}

function workspace(id: string, patch: Partial<Workspace> = {}): Workspace {
  return {
    id,
    checkoutId: "chk_1",
    projectId: "prj_1",
    hostId: "hst_1",
    path: `/repo/.worktrees/${id}`,
    branch: `feat/${id}`,
    baseBranch: "main",
    provenance: "managed",
    git: { dirty: false, changedFiles: 0, ahead: 0, behind: 0, unmerged: false },
    setup: { state: "none", log: "" },
    archivedAt: null,
    updatedAt: T0,
    ...patch,
  };
}

function stream(itemId: string, patch: Partial<StreamBuffer> = {}): StreamBuffer {
  return {
    sessionId: "ses_1",
    itemId,
    order: null,
    text: "",
    thinking: "",
    toolArgs: "",
    toolOutput: "",
    ...patch,
  };
}

describe("worktree preview", () => {
  it("replaces slashes in the branch and joins under .worktrees", () => {
    expect(worktreePath("/Users/me/repo/", "feat/login/retry")).toBe(
      "/Users/me/repo/.worktrees/feat-login-retry",
    );
  });

  it("uses the project's worktree folder, defaulting to .worktrees", () => {
    expect(worktreePath("/r", "feat/x", "wt")).toBe("/r/wt/feat-x");
    expect(worktreePath("/r/", "feat/x", ".git/worktrees-switchyard")).toBe(
      "/r/.git/worktrees-switchyard/feat-x",
    );
    expect(worktreePath("/r", "feat/x", undefined)).toBe("/r/.worktrees/feat-x");
  });

  it("flags invalid branch names", () => {
    expect(branchProblem("")).toMatch(/Enter/);
    expect(branchProblem("has space")).toMatch(/spaces/);
    expect(branchProblem("a..b")).toMatch(/\.\./);
    expect(branchProblem("x.lock")).toMatch(/lock/);
    expect(branchProblem("x~1")).toMatch(/cannot contain/);
    expect(branchProblem("fix/login-retry")).toBeNull();
  });
});

describe("session navigator", () => {
  const input = {
    projects: { prj_1: project("prj_1", "Beta"), prj_2: project("prj_2", "Alpha") },
    workspaces: { w1: workspace("w1") } as Record<string, Workspace>,
    hosts: { hst_1: host("hst_1"), hst_2: host("hst_2", { name: "A host" }) },
    sessions: {
      a: session("a", { workspaceId: "w1", hostId: "hst_1", runtime: "running" }),
      b: session("b", { workspaceId: "w1", hostId: "hst_2", runtime: "stopped" }),
      c: session("c", { workspaceId: "w1", hostId: "hst_1", runtime: "waiting_input" }),
      d: session("d", { archivedAt: T0 }),
    } as Record<string, Session>,
    attention: { att: attention("att", { sessionId: "c" }) },
    interactions: {},
  };
  const base = { filter: "all" as const, query: "" };
  const rows = (list: ReturnType<typeof buildSessionList>) => [
    ...list.rows,
    ...list.sections.flatMap((section) => section.rows),
  ];
  const ids = (list: ReturnType<typeof buildSessionList>) => rows(list).map((r) => r.session.id);

  it("lists each session on a branch independently in every grouping", () => {
    for (const groupBy of ["none", "project", "host", "status"] as const) {
      const list = buildSessionList(input, { ...base, groupBy });
      expect(ids(list).sort()).toEqual(["a", "b", "c"]);
      expect(navRowCount(list)).toBe(3);
    }
    const hostGroups = buildSessionList(input, { ...base, groupBy: "host" }).sections;
    expect(hostGroups.map((g) => [g.hostId, g.rows.length])).toEqual([
      ["hst_2", 1],
      ["hst_1", 2],
    ]);
    const status = buildSessionList(input, { ...base, groupBy: "status" }).sections;
    expect(status.map((g) => g.label)).toEqual(["Needs input", "Working", "Other sessions"]);
    expect(buildSessionList(input, base).sections).toEqual([]);
  });

  it("does not hide ordinary sessions", () => {
    const sessions = Object.fromEntries(
      Array.from({ length: 36 }, (_, n) => [
        String(n),
        session(String(n), { workspaceId: "w1", runtime: "running" }),
      ]),
    );
    for (const groupBy of ["none", "project", "host", "status"] as const) {
      expect(navRowCount(buildSessionList({ ...input, sessions }, { ...base, groupBy }))).toBe(36);
    }
  });

  it("keeps subagents flat and uses parent scope membership, not parent location", () => {
    const child = session("sub", { provenance: "subagent", parentSessionId: "a", hostId: "hst_2" });
    const withSub = { ...input, sessions: { ...input.sessions, sub: child } };
    const scope = {
      id: "v",
      name: "v",
      mode: "pinned",
      projectIds: null,
      hostIds: null,
      sessionIds: ["a"],
      source: null,
      createdAt: "",
      updatedAt: "",
    } as const;
    expect(ids(buildSessionList(withSub, { ...base, scope: scope as never }))).toEqual(["a"]);
    expect(
      ids(
        buildSessionList(withSub, {
          ...base,
          scope: scope as never,
          showSubagents: true,
          where: { kind: "host", id: "hst_2" },
        }),
      ),
    ).toEqual(["sub"]);
    expect(ids(buildSessionList(withSub, { ...base, keepId: "sub" }))).not.toContain("sub");
  });

  it("retains open filtered sessions without counting them, but not archived or search misses", () => {
    const scope = {
      id: "v",
      name: "v",
      mode: "pinned",
      projectIds: null,
      hostIds: null,
      sessionIds: [],
      source: null,
      createdAt: "",
      updatedAt: "",
    } as const;
    for (const [options, reason] of [
      [{ scope: scope as never }, "scope"],
      [{ where: { kind: "host" as const, id: "missing" } }, "where"],
      [{ filter: "attention" as const }, "status"],
    ] as const) {
      const list = buildSessionList(input, { ...base, ...options, keepId: "b" });
      expect(navOutsideRow(list)?.outside).toBe(reason);
      expect(navRowCount(list)).toBe(rows(list).filter((r) => r.session.id !== "b").length);
    }
    expect(ids(buildSessionList(input, { ...base, query: "no match", keepId: "b" }))).toEqual([]);
    expect(ids(buildSessionList(input, { ...base, keepId: "d" }))).not.toContain("d");
  });

  it("sorts independently within sections and breaks ties by session ID", () => {
    const sessions = {
      z: session("z", { title: "Same", workspaceId: "w1", lastActivityAt: "2026-01-01" }),
      a: session("a", { title: "Same", workspaceId: "w1", lastActivityAt: "2026-02-01" }),
      b: session("b", { title: "Before", workspaceId: "w1", lastActivityAt: "2026-03-01" }),
    };
    const data = { ...input, sessions, attention: {} };
    for (const groupBy of ["none", "project", "host", "status"] as const) {
      expect(ids(buildSessionList(data, { ...base, groupBy, sort: "name" }))).toEqual([
        "b",
        "a",
        "z",
      ]);
      expect(ids(buildSessionList(data, { ...base, groupBy, sort: "activity" }))).toEqual([
        "b",
        "a",
        "z",
      ]);
    }
  });

  it("searches tracked issues and applies issue scope membership", () => {
    const issue = {
      id: "i1",
      scopeId: "trk_1",
      projectId: "prj_1",
      workspaceId: "w1",
      branch: null,
      branches: [],
      number: 12,
      title: "Fix altitude",
      url: "https://example.test/12",
    } as unknown as TrackedIssue;
    const scope = {
      id: "trk_1",
      name: "tracked",
      mode: "all",
      projectIds: ["prj_1"],
      hostIds: null,
      sessionIds: [],
      source: { kind: "github", owner: "acme" },
      createdAt: "",
      updatedAt: "",
    } as never;
    const data = { ...input, issues: { i1: issue } };
    const list = buildSessionList(data, { ...base, scope, query: "#12" });
    expect(ids(list).sort()).toEqual(["a", "b", "c"]);
    expect(rows(list)[0]?.issue).toEqual({ number: 12, title: "Fix altitude", url: issue.url });
    expect(ids(buildSessionList(data, { ...base, scope, query: "altitude" })).sort()).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("navigates to the latest matching input, never a retained exception", () => {
    const sessions = {
      a: session("a", { lastActivityAt: "2026-01-01" }),
      b: session("b", { lastActivityAt: "2026-02-01" }),
    };
    const data = {
      ...input,
      sessions,
      attention: {
        a: attention("a", { sessionId: "a" }),
        b: attention("b", { sessionId: "b" }),
      },
    };
    expect(navNeedsInput(buildSessionList(data, base))).toEqual({ count: 2, first: "b" });
    expect(
      navNeedsInput(
        buildSessionList(data, { ...base, where: { kind: "host", id: "none" }, keepId: "b" }),
      ),
    ).toEqual({ count: 0, first: null });
  });

  it("keeps context in every grouping but shows only live terminals", () => {
    const data = {
      ...input,
      sessions: {
        live: session("live", { runtime: "running", external: { client: "term:main@mac" } }),
        stopped: session("stopped", { runtime: "stopped", external: { client: "term:old@mac" } }),
      },
      attention: {},
    };
    const hostRows = rows(buildSessionList(data, { ...base, groupBy: "host" }));
    expect(hostRows.find((row) => row.session.id === "live")?.where).toEqual({
      kind: "terminal",
      label: "term main on Host hst_1",
    });
    expect(hostRows.find((row) => row.session.id === "stopped")?.where?.kind).toBe("host");
    const projectRows = rows(buildSessionList(data, { ...base, groupBy: "project" }));
    expect(projectRows[0]?.project).toBe("Beta");
    const ungrouped = rows(buildSessionList(data, base));
    expect(ungrouped.find((row) => row.session.id === "stopped")?.where?.kind).toBe("host");
  });

  it("puts missing projects and hosts last", () => {
    const data = {
      ...input,
      sessions: {
        a: session("a", { projectId: "missing", hostId: "missing" }),
        b: session("b", { projectId: "prj_1", hostId: "hst_1" }),
      },
    };
    expect(
      buildSessionList(data, { ...base, groupBy: "project" }).sections.map((s) => s.label),
    ).toEqual(["Beta", "Unknown project"]);
    expect(
      buildSessionList(data, { ...base, groupBy: "host" }).sections.map((s) => s.label),
    ).toEqual(["Host hst_1", "Unknown host"]);
  });

  it("converts old presentation preferences and preserves independent choices", () => {
    for (const [layout, groupBy] of [
      ["recent", "none"],
      ["projects", "project"],
      ["where", "host"],
      ["hosts", "host"],
      ["status", "status"],
      ["unknown", "none"],
      ["constructor", "none"],
      ["__proto__", "none"],
    ] as const) {
      expect(
        readNavPresentation({ layout, sorts: { [layout === "hosts" ? "where" : layout]: "name" } }),
      ).toEqual({ groupBy, sort: "name" });
    }
    expect(readNavPresentation({ groupBy: "host", sort: "created", layout: "projects" })).toEqual({
      groupBy: "host",
      sort: "created",
    });
    expect(readNavPresentation({ groupBy: "bad", sort: "bad" })).toEqual({
      groupBy: "none",
      sort: "activity",
    });
    expect(readNavPresentation(null)).toEqual({ groupBy: "none", sort: "activity" });
  });
});

describe("composer", () => {
  it("treats subagent sessions as scope-only scopes refreshed on open", () => {
    expect(isSubagentView(session("s", { provenance: "subagent", readOnly: true }))).toBe(true);
    expect(isSubagentView(session("s"))).toBe(false);
  });

  it("explains why sending is unavailable", () => {
    const base = { hostLink: "connected" as const, hostName: "mac" };
    expect(composerBlockReason({ ...base, session: session("s") })).toBeNull();
    expect(
      composerBlockReason({ ...base, session: session("s", { readOnly: true }) })?.reason,
    ).toBe("Subagent: view only. Live control is not supported.");
    expect(
      composerBlockReason({ ...base, hostLink: "unreachable", session: session("s") })?.reason,
    ).toMatch(/^Host offline/);
    const starting = composerBlockReason({
      ...base,
      session: session("s", { runtime: "starting" }),
    });
    expect(starting?.reason).toMatch(/^Starting…/);
    expect(starting?.pending).toBe(true);
    const stopped = composerBlockReason({
      ...base,
      session: session("s", {
        runtime: "stopped",
        nativeHandle: { sessionId: "n", sessionFile: "/f.jsonl" },
      }),
    });
    expect(stopped).toBeNull();
    expect(
      composerBlockReason({
        ...base,
        session: session("s", { runtime: "stopped", nativeHandle: null }),
      })?.reason,
    ).toContain("no native Pi session");
  });

  it("offers Steer only with the capability", () => {
    expect(sendModes({ runtime: "idle" }, null)).toEqual({
      prompt: true,
      steer: false,
      followUp: false,
    });
    expect(sendModes({ runtime: "running" }, null)).toEqual({
      prompt: false,
      steer: false,
      followUp: true,
    });
    const caps = { steer: true, followUp: true } as Parameters<typeof sendModes>[1];
    expect(sendModes({ runtime: "running" }, caps).steer).toBe(true);
  });

  it("splits data URLs", () => {
    expect(parseDataUrl("data:image/png;base64,AAAA")).toEqual({
      mimeType: "image/png",
      data: "AAAA",
    });
    expect(parseDataUrl("data:text/plain,hi")).toBeNull();
  });
});

describe("transcript timeline", () => {
  it("merges deltas into their item, appends orphan streams and unlisted interactions", () => {
    const items = [
      assistant("i1", 1, "Hello"),
      {
        id: "i2",
        sessionId: "ses_1",
        order: 2,
        at: T0,
        kind: "interaction" as const,
        data: { interactionId: "q1" },
      },
    ];
    const entries = buildTimeline(
      items,
      [stream("i1", { text: " world" }), stream("i9", { text: "new", order: 9 }), stream("i8")],
      [interaction("q1"), interaction("q2")],
    );
    expect(entries.map((e) => e.key)).toEqual(["i1", "i2", "stream:i9", "interaction:q2"]);
    const first = entries[0]!;
    expect(first.type === "item" && first.stream?.text).toBe(" world");
  });

  it("collapses consecutive identical notices into one row with a count", () => {
    const notice = (
      id: string,
      order: number,
      level: "info" | "warning" = "warning",
    ): TranscriptItem => ({
      id,
      sessionId: "ses_1",
      order,
      at: T0,
      kind: "notice",
      data: { level, text: "Host agent restarted; resume to continue" },
    });
    const entries = buildTimeline(
      [
        notice("n1", 1),
        notice("n2", 2),
        notice("n3", 3),
        notice("n4", 4, "info"),
        assistant("a1", 5, "hi"),
        notice("n5", 6),
      ],
      [],
      [],
    );
    expect(entries.map((e) => e.key)).toEqual(["n1", "n4", "a1", "n5"]);
    expect(entries.map((e) => (e.type === "item" ? (e.repeat ?? 1) : 0))).toEqual([3, 1, 1, 1]);
  });

  it("counts entries after the baseline", () => {
    const e = [{ key: "a" }, { key: "b" }, { key: "c" }];
    expect(countAfter(e, "a")).toBe(2);
    expect(countAfter(e, "c")).toBe(0);
    expect(countAfter(e, "zz")).toBe(0);
  });

  it("previews the tail of long output", () => {
    const long = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const p = outputPreview(long, 3);
    expect(p.truncated).toBe(true);
    expect(p.text).toBe("line 17\nline 18\nline 19");
    expect(outputPreview("short").truncated).toBe(false);
  });
});

describe("pane fitting", () => {
  it("keeps the conversation at 420 px by shrinking the inspector, then the navigator", () => {
    expect(fitPanes(1440 - 64, 264, 380)).toEqual({ nav: 264, insp: 380 });
    // 1136 available, 360 + 600 + 12 + 420 = 1392: the inspector gives 256.
    expect(fitPanes(1136, 360, 600)).toEqual({ nav: 360, insp: 344 });
    // 1000 available: the inspector stops at 320, the navigator gives the remaining 112.
    expect(fitPanes(1000, 360, 600)).toEqual({ nav: 248, insp: 320 });
    expect(fitPanes(704, 264, null)).toEqual({ nav: 264, insp: null });
  });
});

describe("workspace file responses", () => {
  it("normalizes listings and file reads from the host", () => {
    const list = normalizeEntries({
      dir: "",
      entries: [
        { name: "b.ts", path: "b.ts", kind: "file", size: 3 },
        { name: "src", path: "src", kind: "dir", size: null },
      ],
    });
    expect(list.map((e) => e.name)).toEqual(["src", "b.ts"]);
    expect(normalizeFile({ content: "x", encoding: "utf8", binary: false, size: 1 })).toEqual({
      text: "x",
      binary: false,
      truncated: false,
      size: 1,
      base64: null,
    });
    const bin = normalizeFile({ content: "AA==", encoding: "base64", binary: true });
    expect(bin.binary).toBe(true);
    expect(bin.base64).toBe("AA==");
  });
});

const mockModel = (id: string, over = {}) => ({
  provider: "mock",
  id,
  name: null,
  contextWindow: 1000,
  reasoning: false,
  thinkingLevels: ["off" as const],
  ...over,
});

describe("slash commands", () => {
  it("parses Switchyard's commands", () => {
    expect(parseClientCommand("/model")).toEqual({ kind: "model-picker" });
    expect(parseClientCommand("/model openrouter/anthropic/claude")).toEqual({
      kind: "model",
      provider: "openrouter",
      modelId: "anthropic/claude",
    });
    expect(parseClientCommand("/model foo")?.kind).toBe("invalid");
    expect(parseClientCommand("/thinking HIGH")).toEqual({ kind: "thinking", level: "high" });
    expect(parseClientCommand("/thinking loud")?.kind).toBe("invalid");
    expect(parseClientCommand("/compact keep tests")).toEqual({
      kind: "compact",
      instructions: "keep tests",
    });
    expect(parseClientCommand("/name")?.kind).toBe("invalid");
    expect(parseClientCommand("/name New title")).toEqual({ kind: "name", title: "New title" });
    expect(parseClientCommand("/tree")).toEqual({ kind: "tree" });
    expect(parseClientCommand("/settings")).toEqual({ kind: "terminal-only", name: "settings" });
    expect(parseClientCommand("/new fix it")).toEqual({ kind: "new", prompt: "fix it" });
    for (const k of ["fork", "clone", "resume", "reload", "export", "session", "copy"]) {
      expect(parseClientCommand(`/${k}`)).toEqual({ kind: k });
    }
    expect(parseClientCommand("/fixture-hello")).toBeNull();
    expect(parseClientCommand("plain text")).toBeNull();
  });

  it("explains problems", () => {
    const compact = parseClientCommand("/compact")!;
    expect(clientCommandProblem(compact, true)).toContain("Wait for the run");
    expect(clientCommandProblem(compact, false)).toBeNull();
    expect(clientCommandProblem(parseClientCommand("/settings")!, false)).toContain("terminal");
    expect(clientCommandProblem(parseClientCommand("/fork")!, false, false)).toContain(
      "no Pi session file",
    );
    expect(clientCommandProblem(parseClientCommand("/fork")!, false, true)).toBeNull();
    expect(clientCommandProblem(parseClientCommand("/reload")!, true)).toContain(
      "Wait for the run",
    );
  });

  it("filters, ranks and merges", () => {
    const merged = mergeCommands(CLIENT_COMMANDS, [
      { name: "model", description: null, source: "extension" },
      { name: "zeta", description: "does mod things", source: "skill" },
      { name: "alpha", description: null, source: "extension" },
      { name: "rev", description: null, source: "prompt", argumentHint: "<file>" },
    ]);
    expect(merged.find((e) => e.name === "rev")?.argumentHint).toBe("<file>");
    expect(merged.find((e) => e.name === "alpha")?.argumentHint).toBeNull();
    expect(merged.map((e) => e.name)).toEqual([
      "model",
      "thinking",
      "compact",
      "name",
      ...CLIENT_COMMANDS.slice(4).map((c) => c.name),
      "alpha",
      "rev",
      "zeta",
      ...TERMINAL_COMMANDS.map((c) => c.name).sort(),
    ]);
    expect(filterCommands(merged, "mo")[0]?.name).toBe("model");
    expect(filterCommands(merged, "mod").map((e) => e.name)).toEqual([
      "model",
      "scoped-models",
      "zeta",
    ]);
    expect(filterCommands(merged, "", 2)).toHaveLength(2);
    expect(filterCommands(merged, "nothing")).toEqual([]);
  });
});

describe("argument completions", () => {
  it("is eligible only for a single-line command with a space", () => {
    expect(completionEligible("/model ")).toBe(true);
    expect(completionEligible("/model")).toBe(false);
    expect(completionEligible("hi there")).toBe(false);
    expect(completionEligible("/m a\nb")).toBe(false);
  });
  it("applies a completion over the prefix", () => {
    expect(applyCompletion("/model cl", "cl", "anthropic/claude")).toBe("/model anthropic/claude ");
    expect(applyCompletion("/x ab", "zz", "v")).toBe("/x ab");
  });
});

describe("activeArgumentHint", () => {
  const entries = mergeCommands(CLIENT_COMMANDS, [
    { name: "plain", description: null, source: "extension" },
  ]);
  it("shows the hint once arguments start", () => {
    expect(activeArgumentHint("/model ", entries)).toEqual({
      name: "model",
      hint: "<provider>/<model>",
    });
    expect(activeArgumentHint("/model", entries)).toBeNull();
    expect(activeArgumentHint("/unknown x", entries)).toBeNull();
    expect(activeArgumentHint("/model a\nb", entries)).toBeNull();
    expect(activeArgumentHint("/plain x", entries)).toBeNull();
  });
});

describe("terminal built-ins", () => {
  it("are listed but blocked", () => {
    const merged = mergeCommands(CLIENT_COMMANDS, []);
    expect(merged).toContainEqual(
      expect.objectContaining({ name: "settings", source: "terminal" }),
    );
    for (const n of [
      "model",
      "thinking",
      "compact",
      "name",
      "new",
      "fork",
      "clone",
      "tree",
      "resume",
      "reload",
      "export",
      "session",
      "copy",
    ]) {
      expect(TERMINAL_COMMANDS.some((c) => c.name === n)).toBe(false);
    }
    expect(parseClientCommand("/settings")?.kind).toBe("terminal-only");
  });
  it("pill labels drop the provider prefix", () => {
    expect(pillModelLabel(mockModel("m", { name: "Mock One" }))).toBe("Mock One");
    expect(pillModelLabel(mockModel("mock/big"))).toBe("big");
    expect(pillModelLabel(mockModel("other/big"))).toBe("big");
    expect(
      pillModelLabel(mockModel("anthropic/claude-fable-5", { name: "Anthropic: Claude Fable 5" })),
    ).toBe("Fable 5");
    expect(pillModelLabel(mockModel("anthropic/claude-fable-5"))).toBe("claude-fable-5");
    expect(pillModelLabel(mockModel("x", { name: "Claude Opus 5.5" }))).toBe("Opus 5.5");
    expect(pillModelLabel(mockModel("x", { name: "Anthropic: Claude Fable 5" }))).toBe("Fable 5");
    expect(pillModelLabel(mockModel("x", { name: "GPT-6 Astra" }))).toBe("GPT-6 Astra");
    expect(pillModelLabel(mockModel("x", { name: "Qwen3.8 27B — Quality Q8 / MTP (local)" }))).toBe(
      "Qwen3.8 27B — Quality Q8 / MTP (local)",
    );
  });
  it("favoriteModels keeps scoped models and the current one in order", () => {
    const a = mockModel("a", { scoped: true });
    const b = mockModel("b", { scoped: false });
    const c = mockModel("c", { scoped: false });
    const d = mockModel("d", { scoped: true });
    expect(favoriteModels([a, b, c, d], null).map((m) => m.id)).toEqual(["a", "d"]);
    expect(favoriteModels([a, b, c, d], c).map((m) => m.id)).toEqual(["a", "c", "d"]);
  });
  it("effortIndex", () => {
    expect(effortIndex(["off", "low", "high"], "high")).toBe(2);
    expect(effortIndex(["off", "low", "high"], "zzz")).toBe(0);
    expect(effortIndex(["off", "low", "high"], null)).toBe(0);
  });
});

describe("model controls", () => {
  it("groups models by provider with every search token", () => {
    const models = [
      mockModel("a"),
      mockModel("b", { name: "Big One" }),
      { ...mockModel("c"), provider: "other" },
    ];
    expect(groupModels(models, "").map((g) => [g.provider, g.models.length])).toEqual([
      ["mock", 2],
      ["other", 1],
    ]);
    expect(groupModels(models, "mock big")[0]?.models.map((m) => m.id)).toEqual(["b"]);
  });

  it("summarizes the model, falling back to the profile", () => {
    expect(modelSummary(session("s"))).toBe("Default");
    const withModel = session("s", {
      model: mockModel("m", { name: "Mock", thinkingLevels: ["off", "high"] }),
      thinking: "high",
    });
    expect(modelSummary(withModel)).toBe("Mock · effort high");
  });

  it("meters context use", () => {
    const ctx = (tokens: number | null, percent: number | null, compacting = false) =>
      contextMeter({
        stats: { tokens: 0, costUsd: 0, context: { tokens, window: 1000, percent } },
        compacting,
      });
    expect(contextMeter({ stats: null, compacting: false })).toBeNull();
    expect(ctx(100, 10, true)?.label).toBe("Compacting…");
    expect(ctx(null, null)).toMatchObject({ label: "—", percent: null });
    expect(ctx(null, null)?.detail).toContain("Known after the next reply");
    expect(ctx(800, 80)).toMatchObject({
      label: "80%",
      tone: "warning",
      detail: "800 of 1,000 tokens",
    });
    expect(ctx(950, 95)?.tone).toBe("danger");
    expect(ctx(100, 10)?.tone).toBe("muted");
  });

  it("blocks sending while compacting and gates the controls on the capability", () => {
    expect(
      composerBlockReason({
        hostLink: "connected",
        hostName: "mac",
        session: session("s", { compacting: true }),
      })?.reason,
    ).toContain("Compacting");
    const caps = { sessionControls: true } as never;
    expect(piControlsAvailable(host("h", { capabilities: caps }), null)).toBe(true);
    expect(piControlsAvailable(host("h", { capabilities: caps }), { reason: "x" })).toBe(false);
    expect(piControlsAvailable(host("h"), null)).toBe(false);
    expect(piControlsAvailable(undefined, null)).toBe(false);
  });
});

describe("rowPreview", () => {
  const s = (patch: Partial<Session>) => session("s", patch);
  it("says what a session waits for before what it last said", () => {
    expect(rowPreview(s({ lastAssistantText: "Done." }), "Pick a fruit")).toBe(
      "Asks: Pick a fruit",
    );
    expect(rowPreview(s({ runtime: "failed", runtimeDetail: "exit 1\nstack" }), null)).toBe(
      "exit 1",
    );
    expect(rowPreview(s({ runtime: "failed", runtimeDetail: null }), null)).toBe(
      "Pi exited with an error",
    );
    expect(rowPreview(s({ compacting: true, lastAssistantText: "x" }), null)).toBe(
      "Compacting context…",
    );
  });
  it("uses the first line of the last reply as plain text", () => {
    expect(rowPreview(s({ lastAssistantText: "\n## **Fixed** the `cart`\n\nMore." }), null)).toBe(
      "Fixed the cart",
    );
    expect(rowPreview(s({ lastAssistantText: "---\n- one  item" }), null)).toBe("one item");
    expect(rowPreview(s({ lastAssistantText: "x".repeat(200) }), null)).toHaveLength(140);
    expect(rowPreview(s({ lastAssistantText: null }), null)).toBeNull();
    expect(rowPreview(s({ runtime: "interrupted", runtimeDetail: null }), null)).toBeNull();
  });
});

describe("pendingTitles", () => {
  it("keeps each session's oldest pending question", () => {
    const titles = pendingTitles({
      a: interaction("a", { title: "newer", createdAt: "2026-01-02T00:00:00Z" }),
      b: interaction("b", { title: "older", createdAt: "2026-01-01T00:00:00Z" }),
      c: interaction("c", { title: "done", state: "resolved" }),
      d: interaction("d", { sessionId: "ses_2", title: "other" }),
    });
    expect(titles.get("ses_1")).toBe("older");
    expect(titles.get("ses_2")).toBe("other");
    expect(titles.size).toBe(2);
  });
});

describe("session status bar", () => {
  const base = {
    hostLink: "connected" as const,
    hostName: "mac",
    hostLastSeenAt: T0 as string | null,
    control: "none" as const,
    canResume: false,
    now: Date.parse(T0),
  };
  const st = (patch: Partial<Session>, over: Partial<typeof base> = {}) =>
    sessionStatus({ ...base, ...over, session: session("s", patch) });

  it("is null for an idle manual session", () => {
    expect(st({})).toBeNull();
  });

  it("orders by what most needs the user", () => {
    expect(st({ readOnly: true, archivedAt: T0, runtime: "failed" })?.kind).toBe("subagent");
    const archived = st({ archivedAt: T0 }, { hostLink: "unreachable" });
    expect(archived?.kind).toBe("archived");
    expect(archived?.action?.kind).toBe("unarchive");
    const host = st({}, { hostLink: "reconnecting" });
    expect(host).toMatchObject({ kind: "host", tone: "warning", pending: true });
  });

  it("an unreachable host turns danger after five minutes or when last seen is unknown", () => {
    const at = (ms: number) => st({}, { hostLink: "unreachable", now: Date.parse(T0) + ms });
    expect(at(60_000)?.tone).toBe("warning");
    expect(at(HOST_OFFLINE_DANGER_MS + 60_000)?.tone).toBe("danger");
    expect(st({}, { hostLink: "unreachable", hostLastSeenAt: null })?.tone).toBe("danger");
  });

  it("failed, interrupted and stopped", () => {
    const failed = st({ runtime: "failed", runtimeDetail: "boom" }, { canResume: true });
    expect(failed).toMatchObject({
      tone: "danger",
      text: "This session failed: boom",
      action: { kind: "resume" },
      link: { to: "/settings/diagnostics" },
    });
    expect(st({ runtime: "failed" })?.action).toBeNull();
    expect(st({ runtime: "interrupted", runtimeDetail: "host restarted" })).toMatchObject({
      tone: "neutral",
      text: "Interrupted: host restarted",
    });
    expect(st({ runtime: "stopped", nativeHandle: "h" })?.text).toBe(
      "Stopped. Sending a message resumes it.",
    );
    expect(st({ runtime: "stopped", nativeHandle: null })?.text).toBe(
      "Stopped: no native Pi session to resume.",
    );
  });

  it("transitional and control states", () => {
    expect(st({ runtime: "starting" })?.pending).toBe(true);
    expect(st({ compacting: true })?.pending).toBe(true);
    expect(st({}, { control: "automation" })?.action?.kind).toBe("takeover");
    expect(st({}, { control: "human" })?.action?.kind).toBe("return");
  });
});

describe("new session helpers", () => {
  it("lists the scope's projects first", () => {
    const ps = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(orderProjectsForScope(ps, ["c", "a"]).map((p) => p.id)).toEqual(["a", "c", "b"]);
    expect(orderProjectsForScope(ps, null)).toBe(ps);
  });

  it("defaults to the last project only when the scope covers it", () => {
    const ordered = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const base = { initial: null, last: "b", selected: null, ordered };
    expect(newSessionProject({ ...base, scopeProjectIds: null })).toBe("b");
    expect(newSessionProject({ ...base, scopeProjectIds: ["a"] })).toBe("a");
    expect(newSessionProject({ ...base, selected: "c", scopeProjectIds: ["a", "c"] })).toBe("c");
    expect(newSessionProject({ ...base, initial: "c", scopeProjectIds: ["a"] })).toBe("c");
    expect(newSessionProject({ ...base, last: "zz", ordered: [], scopeProjectIds: null })).toBe("");
  });

  it("suggests a kebab-case branch from the prompt", () => {
    expect(branchFromPrompt("Fix the login retry bug now please")).toBe("fix-the-login-retry-bug");
    expect(branchFromPrompt("  Réparer l'écran: d'accueil!! ")).toBe("reparer-l-ecran-d-accueil");
    expect(
      branchFromPrompt("Implementation of internationalization infrastructure everywhere"),
    ).toBe("implementation-of-internationalization-i");
    expect(branchFromPrompt("", new Date(2026, 10, 2, 9, 5))).toBe("session-1102-0905");
    expect(branchFromPrompt("!!!", new Date(2026, 10, 2, 9, 5))).toBe("session-1102-0905");
    for (const p of ["Fix #12: crash", "a/b c..d", "x".repeat(80)]) {
      expect(branchProblem(branchFromPrompt(p))).toBeNull();
    }
  });
  it("avoids branches already used by workspaces", () => {
    expect(uniqueBranch("fix", [])).toBe("fix");
    expect(uniqueBranch("fix", ["fix", "fix-2", null])).toBe("fix-3");
  });
  it("defaults to the main checkout on an online host", () => {
    const co = (id: string, hostId: string): Checkout => ({
      id,
      projectId: "prj_1",
      hostId,
      path: `/r-${hostId}`,
      commonDir: `/r-${hostId}/.git`,
      defaultBranch: "main",
      createdAt: T0,
    });
    const p = { ...project("prj_1", "app"), defaultHostId: "hst_a" };
    const hosts = { hst_a: host("hst_a", { connectivity: "unreachable" }), hst_b: host("hst_b") };
    const cos = [co("chk_a", "hst_a"), co("chk_b", "hst_b")];
    const wss = [
      workspace("w_feat_b", { hostId: "hst_b", checkoutId: "chk_b" }),
      workspace("w_main_b", {
        hostId: "hst_b",
        checkoutId: "chk_b",
        provenance: "main",
        branch: "main",
      }),
    ];
    expect(newSessionDefaults(p, cos, wss, hosts)).toEqual({
      hostId: "hst_b",
      workspaceId: "w_main_b",
      checkoutId: "chk_b",
    });
    expect(newSessionDefaults(p, cos, wss, hosts, "hst_a")).toEqual({
      hostId: "hst_a",
      workspaceId: null,
      checkoutId: "chk_a",
    });
    expect(newSessionDefaults(p, [], [], hosts)).toEqual({
      hostId: "",
      workspaceId: null,
      checkoutId: null,
    });
  });
});

describe("catalog checkout placement", () => {
  const repository = { ...project("prj_1", "app"), catalog: { state: "listed" } } as const;
  const mac = host("mac", { checkoutRoot: "~/Projects", checkoutProvision: true });
  const nuc = host("nuc", { checkoutRoot: null, checkoutProvision: false });
  const hosts = { mac, nuc };
  const checkout: Checkout = {
    id: "checkout",
    projectId: repository.id,
    hostId: nuc.id,
    path: "/srv/app",
    commonDir: "/srv/app/.git",
    defaultBranch: "main",
    createdAt: T0,
  };

  it("can use the catalog without any host and defaults to the host that can prepare", () => {
    expect(newSessionDefaults(repository, [], [], {})).toEqual({
      hostId: "",
      checkoutId: null,
      workspaceId: null,
    });
    expect(newSessionDefaults(repository, [], [], hosts)).toEqual({
      hostId: mac.id,
      checkoutId: null,
      workspaceId: null,
    });
  });

  it("allows a different host even when an older host has a usable checkout", () => {
    expect(sessionHostIds(repository, [checkout], hosts)).toEqual([mac.id, nuc.id]);
    expect(newSessionDefaults(repository, [checkout], [], hosts).checkoutId).toBe(checkout.id);
    expect(newSessionDefaults(repository, [checkout], [], hosts, mac.id)).toEqual({
      hostId: mac.id,
      checkoutId: null,
      workspaceId: null,
    });
  });
});

describe("session place", () => {
  const w = { w1: workspace("w1"), w2: workspace("w2") } as Record<string, Workspace>;
  const issues = [
    {
      id: "i1",
      scopeId: "trk_1",
      projectId: "prj_1",
      workspaceId: "w1",
      branch: null,
      branches: [],
      number: 7,
      title: "T",
      url: "u",
    } as unknown as TrackedIssue,
  ];
  const tv = {
    id: "trk_1",
    name: "personal",
    mode: "all",
    projectIds: ["prj_1"],
    hostIds: null,
    sessionIds: [],
    source: { kind: "github", owner: "acme" },
    createdAt: "",
    updatedAt: "",
  } as never;
  const place = (s: Session, sessions: Record<string, Session> = { [s.id]: s }, scope = tv) =>
    sessionPlace({ session: s, sessions, workspaces: w, issues, scope });

  it("names the issue and why the session is in the scope", () => {
    expect(place(session("a", { workspaceId: "w1", runtime: "stopped" }))).toMatchObject({
      issue: { number: 7 },
      reason: "issue",
    });
    expect(place(session("b", { workspaceId: "w2" }))).toMatchObject({
      issue: null,
      reason: "live",
    });
    expect(place(session("c", { workspaceId: "w2", runtime: "stopped" })).reason).toBeNull();
    const parent = session("p", { workspaceId: "w1", runtime: "stopped" });
    const sub = session("s", { provenance: "subagent", parentSessionId: "p", runtime: "stopped" });
    expect(place(sub, { p: parent, s: sub }).reason).toBe("issue");
  });

  it("scopeNote explains outside and live-only, and is silent otherwise", () => {
    const out = session("c", { workspaceId: "w2", runtime: "stopped" });
    expect(scopeNote(place(out), out)).toEqual({
      label: "Not in personal",
      title:
        "Outside the selected scope. Pin it to personal from the session menu to keep it there.",
    });
    const live = session("b", { workspaceId: "w2" });
    expect(scopeNote(place(live), live)).toEqual({
      label: "No issue",
      title: "In personal only while it is live. Pin it or link an issue to keep it.",
    });
    const linked = session("a", { workspaceId: "w1" });
    expect(scopeNote(place(linked), linked)).toBeNull();
    const archived = session("x", { archivedAt: "2026-01-01T00:00:00Z" });
    expect(scopeNote(place(archived), archived)).toBeNull();
    expect(scopeNote(place(out, { c: out }, null as never), out)).toBeNull();
  });
});

describe("session menu scope pins", () => {
  it("lists a checkable pin item per scope and toggles through setPinned", async () => {
    const { sessionMenuItems } = await import("../src/features/code/ConversationHeader");
    const calls: [string, boolean][] = [];
    const ctx = { session: { id: "ses_1", readOnly: false, archivedAt: null } } as never;
    const actions = { setPinned: (v: string, p: boolean) => calls.push([v, p]) } as never;
    const scope = (id: string, sessionIds: string[]) => ({ id, name: id, sessionIds }) as never;
    const items = sessionMenuItems(ctx, actions, [scope("a", ["ses_1"]), scope("b", [])]);
    const pins = items.filter((i) => i.id.startsWith("scope-"));
    expect(pins.map((i) => [i.label, i.checked])).toEqual([
      ["Pin to a", true],
      ["Pin to b", false],
    ]);
    for (const p of pins) p.onSelect();
    expect(calls).toEqual([
      ["a", false],
      ["b", true],
    ]);
  });
});

describe("session menu branch items", () => {
  it("offers Primary session and New session in this branch", async () => {
    const { sessionMenuItems } = await import("../src/features/code/ConversationHeader");
    const calls: string[] = [];
    const ctx = {
      session: { id: "ses_1", readOnly: false, archivedAt: null, provenance: "created" },
    } as never;
    const actions = {
      isPrimary: false,
      setPrimary: (p: boolean) => calls.push(`primary:${p}`),
      newInBranch: () => calls.push("new"),
    } as never;
    const items = sessionMenuItems(ctx, actions, []);
    const primary = items.find((i) => i.id === "primary")!;
    expect(primary).toMatchObject({ label: "Primary session of this branch", checked: false });
    primary.onSelect();
    items.find((i) => i.id === "another")!.onSelect();
    expect(calls).toEqual(["primary:true", "new"]);
    const sub = { session: { id: "s", archivedAt: null, provenance: "subagent" } } as never;
    expect(
      sessionMenuItems(sub, { ...(actions as object), newInBranch: null } as never, []).some(
        (i) => i.id === "primary" || i.id === "another",
      ),
    ).toBe(false);
  });
});

describe("session menu issue links", () => {
  it("offers Link to issue with candidates and Unlink only when allowed", async () => {
    const { sessionMenuItems } = await import("../src/features/code/ConversationHeader");
    const ctx = {
      session: { id: "ses_1", readOnly: false, archivedAt: null, provenance: "created" },
    } as never;
    const calls: string[] = [];
    const base = {
      isPrimary: false,
      setPrimary: () => {},
      newInBranch: null,
    };
    const link = (over: object) =>
      ({
        ...base,
        issueLink: {
          linked: null,
          candidates: [],
          canUnlink: false,
          open: () => calls.push("open"),
          unlink: () => calls.push("unlink"),
          ...over,
        },
      }) as never;
    const ids = (a: never) =>
      sessionMenuItems(ctx, a, [])
        .filter((i) => i.id.endsWith("-issue"))
        .map((i) => i.label);
    const withCandidate = sessionMenuItems(ctx, link({ candidates: [{ number: 3 }] }), []);
    withCandidate.find((i) => i.id === "link-issue")!.onSelect();
    expect(ids(link({ candidates: [{ number: 3 }] }))).toEqual(["Link to issue…"]);
    expect(ids(link({ linked: { number: 3 }, canUnlink: true }))).toEqual(["Unlink from #3"]);
    expect(ids(link({ linked: { number: 3 }, canUnlink: false }))).toEqual([]);
    expect(ids({ ...base, issueLink: null } as never)).toEqual([]);
    expect(ids(link({}))).toEqual([]);
    expect(calls).toEqual(["open"]);
  });
});

describe("foldTimeline", () => {
  const at = "2026-11-01T10:00:00.000Z";
  const user = (id: string, order: number): TranscriptItem => ({
    id,
    sessionId: "ses_1",
    order,
    at,
    kind: "user",
    data: { text: "go" },
  });
  const tool = (
    id: string,
    order: number,
    name = "bash",
    status = "ok",
    ms = 1000,
    args: unknown = {},
  ): TranscriptItem =>
    ({
      id,
      sessionId: "ses_1",
      order,
      at,
      kind: "tool",
      data: {
        toolCallId: id,
        name,
        status,
        args,
        summary: "",
        output: "",
        startedAt: at,
        durationMs: status === "running" ? null : ms,
        card: null,
        adapterId: null,
      },
    }) as TranscriptItem;
  const thinking = (id: string, order: number): TranscriptItem => ({
    id,
    sessionId: "ses_1",
    order,
    at,
    kind: "thinking",
    data: { text: "hm" },
  });
  const notice = (id: string, order: number): TranscriptItem => ({
    id,
    sessionId: "ses_1",
    order,
    at,
    kind: "notice",
    data: { level: "info", text: "n" },
  });
  const fold = (items: TranscriptItem[], busy = false, level: TranscriptDetail = "normal") =>
    foldTimeline(buildTimeline(items, [], []), busy, level);
  const keys = (out: FoldedEntry[]) => out.map((e) => (e.type === "work" ? "work" : e.key));

  it("folds a closed turn into one work entry where the first tool was", () => {
    const out = fold([
      user("u1", 1),
      thinking("t1", 2),
      tool("a", 3, "edit"),
      tool("b", 4, "read"),
      assistant("r1", 5, "done"),
      user("u2", 6),
      assistant("r2", 7, "ok"),
    ]);
    expect(out.map((e) => (e.type === "work" ? "work" : e.key))).toEqual([
      "u1",
      "work",
      "r1",
      "u2",
      "r2",
    ]);
    const work = out[1];
    if (work?.type !== "work") throw new Error("expected work");
    expect(work.summary).toMatchObject({ editedFiles: 1, readFiles: 1, thinking: 1 });
    expect(work.key).toBe("work:t1");
  });

  it("detailed returns the entries unchanged", () => {
    const base = buildTimeline(
      [user("u1", 1), tool("a", 2), assistant("r1", 3, "done"), user("u2", 4)],
      [],
      [],
    );
    expect(foldTimeline(base, false, "detailed")).toBe(base);
  });

  it("a closed turn's work entry is not live", () => {
    const work = fold([user("u1", 1), tool("a", 2), assistant("r1", 3, "done")])[1];
    if (work?.type !== "work") throw new Error("expected work");
    expect(work.live).toBe(false);
    expect(work.startAt).toBe(at);
  });

  it("summary folds the open turn into a live work entry and keeps the trailing reply", () => {
    const items = [
      user("u1", 1),
      assistant("m1", 2, "looking"),
      tool("a", 3),
      thinking("t1", 4),
      tool("b", 5, "bash", "running"),
      assistant("r1", 6, "so far"),
    ];
    expect(keys(fold(items, true, "normal"))).toEqual(["u1", "m1", "a", "t1", "b", "r1"]);
    const out = fold(items, true, "summary");
    expect(keys(out)).toEqual(["u1", "work", "r1"]);
    const work = out[1];
    if (work?.type !== "work") throw new Error("expected work");
    expect(work.live).toBe(true);
    expect(work.key).toBe("work:m1");
    expect(work.entries.map((e) => e.key)).toEqual(["m1", "a", "t1", "b"]);
    expect(work.summary.commands).toBe(2);
  });

  it("summary leaves an open turn without tools unfolded", () => {
    const items = [user("u1", 1), thinking("t1", 2), assistant("r1", 3, "hi")];
    expect(keys(fold(items, true, "summary"))).toEqual(["u1", "t1", "r1"]);
  });

  it("keeps notices outside the fold and folds intermediate assistant text", () => {
    const out = fold([
      user("u1", 1),
      assistant("m1", 2, "looking"),
      notice("n1", 3),
      tool("a", 4),
      assistant("r1", 5, "done"),
      user("u2", 6),
    ]);
    expect(out.map((e) => (e.type === "work" ? "work" : e.key))).toEqual([
      "u1",
      "work",
      "n1",
      "r1",
      "u2",
    ]);
  });

  it("leaves the last turn open when busy, streaming or running a tool", () => {
    const items = [user("u1", 1), tool("a", 2), assistant("r1", 3, "x")];
    expect(fold(items, true).some((e) => e.type === "work")).toBe(false);
    expect(fold(items, false).some((e) => e.type === "work")).toBe(true);
    expect(
      fold([user("u1", 1), tool("a", 2, "bash", "running")]).some((e) => e.type === "work"),
    ).toBe(false);
    const streams = [
      { itemId: "a", text: "", thinking: "", toolArgs: "", toolOutput: "x" },
    ] as unknown as StreamBuffer[];
    expect(
      foldTimeline(buildTimeline(items, streams, []), false).some((e) => e.type === "work"),
    ).toBe(false);
  });

  it("does not fold a turn without tools", () => {
    const out = fold([user("u1", 1), thinking("t", 2), assistant("r1", 3, "x"), user("u2", 4)]);
    expect(out.some((e) => e.type === "work")).toBe(false);
  });

  it("folds turn 0 with no user item, summing tool durations", () => {
    const out = fold([
      tool("a", 1, "bash", "ok", 2000),
      tool("b", 2, "grep", "error", 3000),
      assistant("r", 3, "x"),
    ]);
    const work = out[0];
    if (work?.type !== "work") throw new Error("expected work");
    expect(work.summary.durationMs).toBe(5000);
    expect(work.summary).toMatchObject({ commands: 1, searches: 1, failed: 1 });
  });
});

describe("formatWorkSummary", () => {
  const base = {
    durationMs: 7000,
    editedFiles: 0,
    readFiles: 0,
    commands: 0,
    searches: 0,
    other: 0,
    thinking: 3,
    failed: 0,
  };
  it("says what was done, pluralizes and omits zero counts", () => {
    expect(
      formatWorkSummary({
        ...base,
        editedFiles: 2,
        readFiles: 1,
        commands: 1,
        searches: 2,
        other: 2,
        failed: 1,
      }),
    ).toBe(
      "Worked for 7s · edited 2 files · ran 1 command · read 1 file · 2 searches · 2 other tool calls · 1 failed",
    );
    expect(formatWorkSummary({ ...base, other: 1 })).toBe("Worked for 7s · 1 other tool call");
  });
  it("handles a null duration", () => {
    expect(formatWorkSummary({ ...base, durationMs: null, readFiles: 1 })).toBe(
      "Worked · read 1 file",
    );
  });
  it("reads as running when live", () => {
    expect(formatWorkSummary({ ...base, commands: 1 }, true)).toBe("Working… 7s · ran 1 command");
    expect(formatWorkSummary({ ...base, durationMs: null }, true)).toBe("Working…");
  });
});

describe("summarizeWork", () => {
  const at = "2026-11-01T10:00:00.000Z";
  const entry = (id: string, name: string, args: unknown): TimelineEntry => ({
    type: "item",
    key: id,
    stream: null,
    item: {
      id,
      sessionId: "ses_1",
      order: 1,
      at,
      kind: "tool",
      data: {
        toolCallId: id,
        name,
        status: "ok",
        args,
        summary: "",
        output: "",
        startedAt: at,
        durationMs: 10,
        card: null,
        adapterId: null,
      },
    },
  });
  it("counts distinct files", () => {
    const s = summarizeWork(
      [
        entry("a", "edit", { path: "src/a.ts", edits: [] }),
        entry("b", "edit", { path: "src/a.ts", edits: [] }),
        entry("c", "write", { path: "src/b.ts", content: "x" }),
        entry("d", "read", { path: "src/a.ts" }),
        entry("e", "read", { path: "src/a.ts", offset: 10 }),
        entry("f", "read", {}),
        entry("g", "read", {}),
        entry("h", "todo", { action: "list" }),
      ],
      null,
    );
    expect(s).toMatchObject({ editedFiles: 2, readFiles: 3, other: 1, commands: 0 });
  });
});

describe("entrySpacing", () => {
  const at = "2026-11-01T10:00:00.000Z";
  const item = (kind: "user" | "assistant" | "thinking" | "tool"): TimelineEntry =>
    ({
      type: "item",
      key: kind,
      stream: null,
      item: { id: kind, sessionId: "s", order: 1, at, kind, data: {} },
    }) as unknown as TimelineEntry;
  it("packs tool and thinking lines and sets a new turn apart", () => {
    expect(entrySpacing(null, item("user"))).toBe("none");
    expect(entrySpacing(item("tool"), item("tool"))).toBe("tight");
    expect(entrySpacing(item("thinking"), item("tool"))).toBe("tight");
    expect(entrySpacing(item("tool"), item("assistant"))).toBe("normal");
    expect(entrySpacing(item("assistant"), item("user"))).toBe("turn");
    expect(workingSince([item("user"), item("tool")])).toBe(at);
    expect(workingSince([item("tool")])).toBeNull();
  });
});

describe("status buckets", () => {
  const at = "2026-11-01T10:00:00.000Z";
  it("follows the precedence", () => {
    expect(statusBucket(session("a", { runtime: "idle" }), true)).toBe("needs_input");
    expect(statusBucket(session("a", { runtime: "waiting_input" }), false)).toBe("needs_input");
    expect(statusBucket(session("a", { runtime: "failed", unreadSince: at }), false)).toBe(
      "failed",
    );
    expect(statusBucket(session("a", { runtime: "failed" }), false)).toBe("idle");
    expect(statusBucket(session("a", { runtime: "running", unreadSince: at }), false)).toBe(
      "running",
    );
    expect(statusBucket(session("a", { runtime: "idle", compacting: true }), false)).toBe(
      "running",
    );
    expect(statusBucket(session("a", { runtime: "idle", unreadSince: at }), false)).toBe("review");
    expect(statusBucket(session("a", { runtime: "stopped" }), false)).toBe("idle");
  });

  it("lays out the status layout in bucket order", () => {
    const base = {
      projects: { prj_1: project("prj_1", "beta") },
      workspaces: {},
      hosts: { hst_1: host("hst_1") } as Record<string, Host>,
      sessions: {
        a: session("a", { runtime: "idle", unreadSince: at, cwd: "/a" }),
        b: session("b", { runtime: "running", cwd: "/b" }),
        c: session("c", { runtime: "waiting_input", cwd: "/c" }),
      } as Record<string, Session>,
      attention: {},
      interactions: {},
    };
    const list = buildSessionList(base, { filter: "all", query: "", groupBy: "status" });
    expect(list.sections.map((g) => g.label)).toEqual([
      "Needs input",
      "Working",
      "Ready to review",
    ]);
    expect(STATUS_BUCKETS[0]?.value).toBe("needs_input");
  });
});

describe("sessionUsage", () => {
  const usage = [
    {
      provider: "anthropic",
      status: "available",
      message: null,
      windows: [],
      fetchedAt: "2026-11-01T10:00:00.000Z",
    },
  ] as NonNullable<Host["usage"]>;
  const h = { ...host("hst_1"), usage } as Host;
  const model = (provider: string) => ({ provider, id: "m" }) as unknown as Session["model"];
  it("maps anthropic and openai-codex models and nothing else", () => {
    expect(sessionUsage(session("a", { model: model("anthropic") }), h)?.provider).toBe(
      "anthropic",
    );
    expect(sessionUsage(session("a", { model: model("openai-codex") }), h)).toBeNull();
    expect(sessionUsage(session("a", { model: model("google") }), h)).toBeNull();
    expect(sessionUsage(session("a", {}), undefined)).toBeNull();
  });
});

describe("prefillDecision", () => {
  it("sets into an empty draft, keeps a non-empty one, and ignores no prefill", () => {
    expect(prefillDecision("", "hi")).toBe("set");
    expect(prefillDecision("  \n", "hi")).toBe("set");
    expect(prefillDecision("typing", "hi")).toBe("kept");
    expect(prefillDecision("", null)).toBe("none");
  });
});

describe("sendPlan", () => {
  it("sends a prompt when idle, with no alternate", () => {
    expect(sendPlan({ prompt: true, steer: false, followUp: false }, "queue")).toEqual({
      primary: "prompt",
      alternate: null,
    });
  });
  it("follows the preference while Pi works and offers the other mode", () => {
    const both = { prompt: false, steer: true, followUp: true };
    expect(sendPlan(both, "queue")).toEqual({ primary: "followUp", alternate: "steer" });
    expect(sendPlan(both, "steer")).toEqual({ primary: "steer", alternate: "followUp" });
  });
  it("never offers a mode the runtime lacks", () => {
    expect(sendPlan({ prompt: false, steer: false, followUp: true }, "steer")).toEqual({
      primary: "followUp",
      alternate: null,
    });
    expect(sendPlan({ prompt: false, steer: false, followUp: false }, "queue")).toEqual({
      primary: null,
      alternate: null,
    });
  });
});

describe("queuedMessages", () => {
  it("lists steering messages first, each with its kind", () => {
    expect(queuedMessages({ steering: ["now"], followUp: ["later", "last"] })).toEqual([
      { kind: "Steering", text: "now" },
      { kind: "Queued", text: "later" },
      { kind: "Queued", text: "last" },
    ]);
    expect(queuedMessages({ steering: [], followUp: [] })).toEqual([]);
  });
});

describe("suggestions and docked interactions", () => {
  const at = "2026-11-01T10:00:00.000Z";
  const base = { sessionId: "ses_1", at };
  const user = (id: string, order: number): TranscriptItem => ({
    ...base,
    id,
    order,
    kind: "user",
    data: { text: "go" },
  });
  const system = (id: string, order: number, text: string, suggestion = true): TranscriptItem => ({
    ...base,
    id,
    order,
    kind: "system",
    data: suggestion ? { text, suggestion: true } : { text },
  });
  const asked = (id: string, order: number, interactionId: string): TranscriptItem => ({
    ...base,
    id,
    order,
    kind: "interaction",
    data: { interactionId },
  });
  const entry = (item: TranscriptItem): TimelineEntry => ({
    type: "item",
    key: item.id,
    item,
    stream: null,
  });

  it("currentSuggestion returns the last suggestion until you reply", () => {
    expect(currentSuggestion([])).toBeNull();
    expect(currentSuggestion([user("u", 1), system("a", 2, "first"), system("b", 3, "next")])).toBe(
      "next",
    );
    expect(currentSuggestion([system("a", 1, "old"), user("u", 2)])).toBeNull();
    expect(currentSuggestion([user("u", 1), system("a", 2, "   ")])).toBeNull();
    expect(currentSuggestion([user("u", 1), system("a", 2, "note", false)])).toBeNull();
  });

  it("transcriptEntries drops what the dock and the composer show", () => {
    const pending = interaction("int_p");
    const entries: TimelineEntry[] = [
      entry(asked("i1", 1, "int_p")),
      entry(asked("i2", 2, "int_d")),
      entry(system("s1", 3, "try this")),
      entry(system("s2", 4, "plain note", false)),
      { type: "interaction", key: "interaction:int_p", interaction: pending },
    ];
    expect(transcriptEntries(entries, [pending], () => false).map((e) => e.key)).toEqual([
      "i2",
      "s2",
    ]);
    expect(transcriptEntries(entries, [pending], () => true).map((e) => e.key)).toEqual([
      "i1",
      "i2",
      "s2",
      "interaction:int_p",
    ]);
  });
});

import type { Host, Project, Session, TranscriptItem, Workspace } from "@switchyard/protocol";
import { describe, expect, it } from "vitest";
import { normalizeEntries, normalizeFile } from "../src/features/code/api";
import {
  activeArgumentHint,
  applyCompletion,
  branchProblem,
  buildNavTree,
  buildTimeline,
  CLIENT_COMMANDS,
  clientCommandProblem,
  completionEligible,
  composerBlockReason,
  contextMeter,
  countAfter,
  effortIndex,
  favoriteModels,
  filterCommands,
  fitPanes,
  groupModels,
  HOST_OFFLINE_DANGER_MS,
  isSubagentView,
  mergeCommands,
  modelSummary,
  type NavGroup,
  type NavTree,
  navGroupKeys,
  navTreeIsEmpty,
  outputPreview,
  parseClientCommand,
  parseDataUrl,
  piControlsAvailable,
  pillModelLabel,
  sendModes,
  sessionStatus,
  TERMINAL_COMMANDS,
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

describe("navigator tree", () => {
  const input = {
    projects: { prj_1: project("prj_1", "beta"), prj_2: project("prj_2", "alpha") },
    workspaces: { w1: workspace("w1"), w2: workspace("w2") } as Record<string, Workspace>,
    hosts: { hst_1: host("hst_1") } as Record<string, Host>,
    sessions: {
      a: session("a", { workspaceId: "w1", runtime: "running", lastActivityAt: T0 }),
      b: session("b", { workspaceId: "w1", runtime: "stopped" }),
      c: session("c", { workspaceId: "w2", runtime: "stopped" }),
      d: session("d", { archivedAt: T0, runtime: "idle" }),
      e: session("e", { projectId: null, cwd: "/tmp/x", runtime: "idle" }),
    } as Record<string, Session>,
    attention: { att: attention("att", { sessionId: "c" }) },
    interactions: {},
  };
  const ids = (tree: NavTree): string[] => {
    const out = tree.rows.map((r) => r.session.id);
    const walk = (gs: NavGroup[]) => {
      for (const g of gs) {
        out.push(...g.rows.map((r) => r.session.id));
        walk(g.groups);
      }
    };
    walk(tree.groups);
    return out;
  };

  it("defaults to Projects, attention first, and puts a shared host on the header", () => {
    const tree = buildNavTree(input, { filter: "active", query: "" });
    expect(tree.rows).toEqual([]);
    expect(tree.groups.map((p) => p.label)).toEqual(["beta", "Other sessions"]);
    const beta = tree.groups[0]!;
    expect(beta.groups).toEqual([]);
    // b is stopped without attention; c is stopped but needs attention; d is archived.
    expect(beta.rows.map((r) => r.session.id)).toEqual(["c", "a"]);
    expect(beta.detail).toBe("Host hst_1");
    const a = beta.rows[1]!;
    expect(a).toMatchObject({ host: null, branch: "feat/w1", project: null });
    expect(tree.groups[1]!.rows[0]).toMatchObject({ branch: "x" });
  });

  it("Projects shows the host on each row when a project spans hosts", () => {
    const tree = buildNavTree(
      {
        ...input,
        hosts: { ...input.hosts, hst_2: host("hst_2") },
        workspaces: { ...input.workspaces, w3: workspace("w3", { hostId: "hst_2" }) },
        sessions: { ...input.sessions, f: session("f", { workspaceId: "w3", hostId: "hst_2" }) },
      },
      { filter: "active", query: "" },
    );
    const beta = tree.groups[0]!;
    expect(beta.detail).toBeNull();
    const hosts = Object.fromEntries(beta.rows.map((r) => [r.session.id, r.host]));
    expect(hosts).toEqual({ a: "Host hst_1", c: "Host hst_1", f: "Host hst_2" });
  });

  it("rows on the main checkout show no branch", () => {
    const tree = buildNavTree(
      {
        ...input,
        workspaces: {
          ...input.workspaces,
          wm: workspace("wm", { provenance: "main", branch: "main", projectId: "prj_2" }),
        },
        sessions: { m: session("m", { workspaceId: "wm", projectId: "prj_2" }) },
      },
      { filter: "active", query: "" },
    );
    expect(tree.groups[0]!.rows[0]).toMatchObject({ branch: null });
  });

  it("Worktrees keeps project -> workspace; all hides projects without sessions; search matches branches", () => {
    const tree = buildNavTree(input, { filter: "active", query: "", layout: "worktrees" });
    const beta = tree.groups[0]!;
    const w2 = beta.groups.find((w) => w.key === "w:w2")!;
    expect(w2.label).toBe("feat/w2");
    expect(w2.detail).toBe("Host hst_1");
    expect(w2.rows[0]!.attention).toBe(true);
    expect(beta.sessionCount).toBe(2);
    const all = buildNavTree(input, { filter: "all", query: "", layout: "worktrees" });
    expect(all.groups.map((p) => p.label)).toEqual(["beta", "Other sessions"]);
    const found = buildNavTree(input, { filter: "all", query: "W2", layout: "worktrees" });
    expect(found.groups).toHaveLength(1);
    expect(found.groups[0]!.groups.map((w) => w.key)).toEqual(["w:w2"]);
  });

  it("Projects with All hides projects without sessions", () => {
    const tree = buildNavTree(input, { filter: "all", query: "" });
    expect(tree.groups.map((g) => g.label)).toEqual(["beta", "Other sessions"]);
  });

  it("Worktrees flattens a project whose only workspace is the main checkout", () => {
    const tree = buildNavTree(
      {
        ...input,
        workspaces: {
          ...input.workspaces,
          wm: workspace("wm", { provenance: "main", branch: "main", projectId: "prj_2" }),
        },
        sessions: {
          ...input.sessions,
          m: session("m", { workspaceId: "wm", projectId: "prj_2", runtime: "stopped" }),
        },
      },
      { filter: "all", query: "", layout: "worktrees" },
    );
    const alpha = tree.groups.find((g) => g.label === "alpha")!;
    expect(alpha.groups).toEqual([]);
    expect(alpha.rows.map((r) => r.session.id)).toEqual(["m"]);
    expect(alpha.detail).toBe("Host hst_1");
    expect(tree.groups.find((g) => g.label === "beta")!.groups).toHaveLength(2);
  });

  it("Recent is one list, attention first, with full context", () => {
    const tree = buildNavTree(input, { filter: "all", query: "", layout: "recent" });
    expect(tree.groups).toEqual([]);
    expect(tree.rows.map((r) => r.session.id).sort()).toEqual(["a", "b", "c", "e"]);
    expect(tree.rows[0]!.session.id).toBe("c");
    for (const r of tree.rows) {
      expect(r.project).not.toBeNull();
      expect(r.host).not.toBeNull();
    }
    expect(tree.rows.find((r) => r.session.id === "e")!.project).toBe("Other sessions");
  });

  it("Hosts groups host -> project with the host's state", () => {
    const tree = buildNavTree(
      {
        ...input,
        hosts: { ...input.hosts, hst_2: host("hst_2", { connectivity: "unreachable" }) },
        workspaces: { ...input.workspaces, w3: workspace("w3", { hostId: "hst_2" }) },
        sessions: { ...input.sessions, f: session("f", { workspaceId: "w3", hostId: "hst_2" }) },
      },
      { filter: "active", query: "", layout: "hosts" },
    );
    expect(tree.groups.map((g) => g.label)).toEqual(["Host hst_1", "Host hst_2"]);
    expect(tree.groups[0]!.groups.map((g) => g.label)).toEqual(["beta", "Other sessions"]);
    expect(tree.groups[0]!.hostState).toBe("connected");
    expect(tree.groups[1]!.hostState).toBe("unreachable");
    expect(tree.groups[1]!.sessionCount).toBe(1);
  });

  it("hides subagents unless asked", () => {
    const withSub = {
      ...input,
      sessions: {
        ...input.sessions,
        s: session("s", { workspaceId: "w1", provenance: "subagent", readOnly: true }),
      },
    };
    expect(ids(buildNavTree(withSub, { filter: "all", query: "" }))).not.toContain("s");
    expect(ids(buildNavTree(withSub, { filter: "all", query: "", showSubagents: true }))).toContain(
      "s",
    );
  });

  it("attention filter keeps only sessions needing input", () => {
    const tree = buildNavTree(
      { ...input, interactions: { i1: interaction("i1", { sessionId: "a" }) } },
      { filter: "attention", query: "" },
    );
    expect(ids(tree).sort()).toEqual(["a", "c"]);
  });

  it("empty trees and group keys", () => {
    const empty = buildNavTree({ ...input, sessions: {} }, { filter: "all", query: "" });
    expect(empty.groups).toEqual([]);
    expect(navTreeIsEmpty(empty)).toBe(true);
    expect(navTreeIsEmpty(buildNavTree(input, { filter: "all", query: "" }))).toBe(false);
    const keys = navGroupKeys(
      buildNavTree(input, { filter: "active", query: "", layout: "worktrees" }),
    );
    expect(keys).toContain("p:prj_1");
    expect(keys).toContain("w:w1");
    expect(keys).toContain("w:w2");
  });
});

describe("composer", () => {
  it("treats subagent sessions as view-only views refreshed on open", () => {
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

describe("session status bar", () => {
  const base = {
    hostLink: "connected" as const,
    hostName: "mac",
    hostLastSeenAt: T0 as string | null,
    control: "none" as const,
    pending: [] as { title: string }[],
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
    const host = st({}, { hostLink: "reconnecting", pending: [{ title: "Q" }] });
    expect(host).toMatchObject({ kind: "host", tone: "warning", pending: true });
    const one = st({}, { control: "automation", pending: [{ title: "Pick a fruit" }] });
    expect(one).toMatchObject({ kind: "answer", text: "Needs input: Pick a fruit" });
    expect(st({}, { pending: [{ title: "a" }, { title: "b" }] })?.text).toBe(
      "2 questions need input",
    );
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

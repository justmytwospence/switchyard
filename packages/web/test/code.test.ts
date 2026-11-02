import type { Host, Project, Workspace } from "@switchyard/protocol";
import { describe, expect, it } from "vitest";
import { normalizeEntries, normalizeFile } from "../src/features/code/api";
import {
  branchProblem,
  buildNavTree,
  buildTimeline,
  composerBlockReason,
  countAfter,
  fitPanes,
  outputPreview,
  parseDataUrl,
  sendModes,
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
    workspaces: { w1: workspace("w1"), w2: workspace("w2") },
    hosts: { hst_1: host("hst_1") },
    sessions: {
      a: session("a", { workspaceId: "w1", runtime: "running", lastActivityAt: T0 }),
      b: session("b", { workspaceId: "w1", runtime: "stopped" }),
      c: session("c", { workspaceId: "w2", runtime: "stopped" }),
      d: session("d", { archivedAt: T0, runtime: "idle" }),
      e: session("e", { projectId: null, cwd: "/tmp/x", runtime: "idle" }),
    },
    attention: { att: attention("att", { sessionId: "c" }) },
    interactions: {},
  };

  it("groups project -> workspace -> sessions and filters active", () => {
    const tree = buildNavTree(input, { filter: "active", query: "" });
    expect(tree.map((p) => p.label)).toEqual(["beta", "Other sessions"]);
    const beta = tree[0]!;
    const ids = beta.workspaces.flatMap((w) => w.sessions.map((s) => s.session.id));
    // b is stopped without attention; c is stopped but needs attention; d is archived.
    expect(ids.sort()).toEqual(["a", "c"]);
    const w2 = beta.workspaces.find((w) => w.key === "w2")!;
    expect(w2.sessions[0]!.attention).toBe(true);
    expect(w2.label).toBe("feat/w2");
    expect(w2.hostName).toBe("Host hst_1");
  });

  it("all includes stopped sessions and empty projects; search matches branches", () => {
    const all = buildNavTree(input, { filter: "all", query: "" });
    expect(all.map((p) => p.label)).toEqual(["alpha", "beta", "Other sessions"]);
    const found = buildNavTree(input, { filter: "all", query: "W2" });
    expect(found).toHaveLength(1);
    expect(found[0]!.workspaces.map((w) => w.key)).toEqual(["w2"]);
  });

  it("attention filter keeps only sessions needing input", () => {
    const tree = buildNavTree(
      { ...input, interactions: { i1: interaction("i1", { sessionId: "a" }) } },
      { filter: "attention", query: "" },
    );
    const ids = tree.flatMap((p) =>
      p.workspaces.flatMap((w) => w.sessions.map((s) => s.session.id)),
    );
    expect(ids.sort()).toEqual(["a", "c"]);
  });
});

describe("composer", () => {
  it("explains why sending is unavailable", () => {
    const base = { hostLink: "connected" as const, hostName: "mac" };
    expect(composerBlockReason({ ...base, session: session("s") })).toBeNull();
    expect(
      composerBlockReason({ ...base, session: session("s", { readOnly: true }) })?.reason,
    ).toBe("Read-only subagent view");
    expect(
      composerBlockReason({ ...base, hostLink: "unreachable", session: session("s") })?.reason,
    ).toMatch(/^Host offline/);
    expect(
      composerBlockReason({ ...base, session: session("s", { runtime: "starting" }) })?.reason,
    ).toMatch(/^Starting…/);
    const stopped = composerBlockReason({
      ...base,
      session: session("s", {
        runtime: "stopped",
        nativeHandle: { sessionId: "n", sessionFile: "/f.jsonl" },
      }),
    });
    expect(stopped).toEqual({ reason: "Session stopped: Resume to send", action: "resume" });
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
    });
    expect(normalizeFile({ content: "AA==", encoding: "base64", binary: true }).binary).toBe(true);
  });
});

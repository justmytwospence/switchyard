import { EventEmitter } from "node:events";
import type { Checkout, Host, Project, Workspace } from "@switchyard/protocol";
import { describe, expect, it } from "vitest";
import type { MirrorState } from "../src/herdr/mirror.js";
import {
  branchSlug,
  chooseSession,
  newWorktreeItems,
  projectItems,
  tildePath,
  workspaceItems,
} from "../src/herdr/new-session.js";
import {
  filterItems,
  fuzzyMatch,
  parseKeys,
  renderPicker,
  Screen,
  type TerminalIO,
} from "../src/herdr/picker.js";
import { session } from "./herdr-fixtures.js";

const ESC_CHAR = String.fromCharCode(27);
const strip = (s: string) => s.replace(new RegExp(`${ESC_CHAR}\\[[0-9;?]*[A-Za-z]`, "g"), "");

function workspace(id: string, over: Partial<Workspace> = {}): Workspace {
  return {
    id,
    checkoutId: "chk_sy",
    projectId: "prj_sy",
    hostId: "hst_mac",
    path: "/Users/me/Projects/switchyard",
    branch: "main",
    baseBranch: null,
    provenance: "main",
    git: { dirty: false } as Workspace["git"],
    setup: { state: "none", log: "" },
    archivedAt: null,
    updatedAt: "2026-11-02T00:00:00Z",
    ...over,
  };
}

function state(over: Partial<MirrorState> = {}): MirrorState {
  return {
    sessions: [],
    workspaces: [
      workspace("wsp_main"),
      workspace("wsp_feat", {
        path: "/Users/me/Projects/switchyard/.worktrees/login-retry",
        branch: "login-retry",
        provenance: "managed",
      }),
      workspace("wsp_old", { projectId: "prj_old", hostId: "hst_old", checkoutId: "chk_old" }),
    ],
    projects: [
      { id: "prj_sy", name: "switchyard" },
      { id: "prj_29", name: "29ers" },
      { id: "prj_old", name: "legacy" },
    ] as Project[],
    hosts: [
      { id: "hst_mac", name: "mac", capabilities: { terminal: true } },
      { id: "hst_nuc", name: "nuc", capabilities: { terminal: true } },
      { id: "hst_old", name: "old", capabilities: { terminal: false } },
    ] as Host[],
    checkouts: [
      {
        id: "chk_sy",
        projectId: "prj_sy",
        hostId: "hst_mac",
        path: "/Users/me/Projects/switchyard",
        defaultBranch: "main",
      },
      {
        id: "chk_29",
        projectId: "prj_29",
        hostId: "hst_nuc",
        path: "/home/me/Projects/29ers",
        defaultBranch: "main",
      },
      { id: "chk_old", projectId: "prj_old", hostId: "hst_old", path: "/x", defaultBranch: "main" },
    ] as Checkout[],
    ...over,
  };
}

/** A fake terminal: keys are fed in order, each as its own chunk, once the picker listens. */
function fakeIO(chunks: string[]): TerminalIO & { screen: () => string } {
  const input = Object.assign(new EventEmitter(), {
    setRawMode: () => input,
    resume: () => input,
    pause: () => input,
  });
  let written = "";
  let fed = false;
  const output = {
    columns: 80,
    rows: 20,
    write: (s: string) => {
      written += s;
      if (!fed) {
        fed = true;
        const next = () => {
          const c = chunks.shift();
          if (c === undefined) return;
          input.emit("data", c);
          setImmediate(next);
        };
        setImmediate(next);
      }
      return true;
    },
  };
  return {
    input: input as never,
    output: output as never,
    color: false,
    screen: () => strip(written.slice(written.lastIndexOf("\x1b[H"))),
  };
}

const ENTER = "\r";
const ESC = "\x1b";
const DOWN = "\x1b[B";

describe("fuzzy matching", () => {
  it("matches subsequences, preferring word starts and runs", () => {
    expect(fuzzyMatch("swy", "switchyard")?.positions).toEqual([0, 1, 6]);
    expect(fuzzyMatch("xyz", "switchyard")).toBeNull();
    expect(fuzzyMatch("mon pymc", "pymc-monitor")).not.toBeNull();
    const ranked = filterItems(
      [
        { label: "summary-tool", value: 1 },
        { label: "pymc-monitor", value: 2 },
        { label: "plum", value: 3 },
      ],
      "mo",
    ).map((r) => r.item.value);
    expect(ranked).toEqual([2, 1]);
    const starts = filterItems(
      [
        { label: "xpxmx", value: "scattered" },
        { label: "pymc-monitor", value: "starts" },
      ],
      "pm",
    ).map((r) => r.item.value);
    expect(starts).toEqual(["starts", "scattered"]);
  });

  it("searches details and always appends extra items", () => {
    const r = filterItems(
      [
        { label: "main", detail: "nuc", value: "a" },
        { label: "feat", detail: "mac", value: "b" },
      ],
      "nuc",
      [{ label: "+ New worktree nuc", value: "new" }],
    );
    expect(r.map((x) => x.item.value)).toEqual(["a", "new"]);
    expect(r[0]!.detailPositions).toEqual([0, 1, 2]);
    // A token never spans the label and the detail.
    expect(filterItems([{ label: "signup", detail: "my mac", value: 1 }], "pym")).toEqual([]);
    // Different tokens may match in different fields.
    expect(filterItems([{ label: "signup", detail: "nuc", value: 1 }], "sig nuc")).toHaveLength(1);
  });
});

describe("keys", () => {
  it("moves with Ctrl+J/K/N/P, Tab and Shift+Tab", () => {
    expect(parseKeys("\n\x0b\x0e\x10\t\x1b[Z\r").map((k) => k.name)).toEqual([
      "down",
      "up",
      "down",
      "up",
      "down",
      "up",
      "enter",
    ]);
  });

  it("parses arrows, controls, Esc and text, dropping unknown sequences", () => {
    expect(parseKeys("\x1b[Aab\r\x1b\x03\x1b[1;5C\x7f").map((k) => k.name)).toEqual([
      "up",
      "char",
      "char",
      "enter",
      "esc",
      "cancel",
      "backspace",
    ]);
  });
});

describe("render", () => {
  it("shows the breadcrumb, the query, the count and the selection", () => {
    const ranked = filterItems(
      [
        { label: "switchyard", detail: "mac", value: 1 },
        { label: "29ers", detail: "nuc", value: 2 },
      ],
      "",
    );
    const { lines, cursorRow } = renderPicker(
      { color: false },
      { crumbs: ["New session"], heading: "Project", hint: "hint" },
      "sw",
      ranked,
      1,
      0,
      2,
      60,
      12,
    );
    const text = lines.join("\n");
    expect(text).toContain("Switchyard › New session");
    expect(lines[cursorRow]).toMatch(/^ ❯ sw +2\/2$/);
    expect(text).toMatch(/ ▌ 29ers +nuc/);
    expect(lines).toHaveLength(12);
    expect(lines.at(-1)).toBe(" hint");
  });
});

describe("items", () => {
  it("offers only projects and workspaces on terminal hosts, most recently active first", () => {
    const st = state({
      sessions: [
        session("ses_1", { projectId: "prj_29", workspaceId: null, lastActivityAt: "2026-11-03" }),
        session("ses_2", { projectId: "prj_sy", workspaceId: "wsp_feat" }),
      ],
    });
    expect(projectItems(st).map((p) => [p.label, p.detail])).toEqual([
      ["29ers", "nuc · 1 session"],
      ["switchyard", "mac · 1 session"],
    ]);
    expect(workspaceItems(st, "prj_sy").map((w) => [w.label, w.detail])).toEqual([
      ["login-retry", "mac · ~/Projects/switchyard/.worktrees/login-retry · 1 session"],
      ["main (main checkout)", "mac · ~/Projects/switchyard"],
    ]);
    expect(workspaceItems(st, "prj_29")).toEqual([]);
    expect(newWorktreeItems(st, "prj_29", "Fix login!")).toEqual([
      {
        label: "+ New worktree fix-login",
        detail: "nuc · from main · ~/Projects/29ers",
        value: { kind: "new", checkoutId: "chk_29", branch: "fix-login" },
      },
    ]);
  });

  it("slugs branch names and shortens home paths", () => {
    expect(branchSlug("  Login retry!! ")).toBe("login-retry");
    expect(branchSlug("feat/x--y.")).toBe("feat/x-y");
    expect(branchSlug("!!")).toBe("");
    expect(tildePath("/home/me/a")).toBe("~/a");
    expect(tildePath("/srv/a")).toBe("/srv/a");
  });
});

describe("chooseSession", () => {
  it("creates a worktree named by the query when a project has no workspaces", async () => {
    const io = fakeIO(["2", "9", ENTER, ..."login retry", ENTER, ENTER]);
    const screen = new Screen(io);
    const seen: string[] = [];
    const pick = screen.pick.bind(screen);
    screen.pick = async (frame, items, extra) => {
      seen.push(frame.heading);
      return pick(frame, items, extra);
    };
    const choice = await chooseSession(state(), screen);
    expect(seen).toEqual(["Project", "No workspaces yet: type a branch name for a new worktree"]);
    expect(io.screen()).toContain("Title (optional)");
    expect(choice).toEqual({
      projectId: "prj_29",
      workspace: { checkoutId: "chk_29", newBranch: "login-retry" },
    });
  });

  it("picks an existing workspace and a title", async () => {
    const io = fakeIO([..."swi", ENTER, ..."login", ENTER, ..."Fix it", ENTER]);
    const choice = await chooseSession(state(), new Screen(io));
    expect(choice).toEqual({
      projectId: "prj_sy",
      workspace: { existingId: "wsp_feat" },
      title: "Fix it",
    });
  });

  it("asks for a branch when the new-worktree entry is chosen without a query", async () => {
    // switchyard: two workspaces, then the new-worktree entry.
    const io = fakeIO([..."swi", ENTER, DOWN, DOWN, ENTER, ENTER, ..."x y", ENTER, ENTER]);
    const screen = new Screen(io);
    const choice = await chooseSession(state(), screen);
    expect(choice?.workspace).toEqual({ checkoutId: "chk_sy", newBranch: "x-y" });
  });

  it("goes back a step on Esc and returns null from the first step", async () => {
    const back = fakeIO([..."swi", ENTER, ESC, ESC]);
    expect(await chooseSession(state(), new Screen(back))).toBeNull();
    // Back from the workspace step keeps the project query: "swi" + "\x7f" -> "sw".
    const restore = fakeIO([..."swi", ENTER, ..."log", ESC, "\x7f", ENTER, ENTER, ENTER]);
    expect(await chooseSession(state(), new Screen(restore))).toEqual({
      projectId: "prj_sy",
      workspace: { existingId: "wsp_feat" },
    });
    const cancel = fakeIO([..."swi", ENTER, "\x03"]);
    expect(await chooseSession(state(), new Screen(cancel))).toBeNull();
  });

  it("offers the tab's workspace first, and another project from there", async () => {
    const here = fakeIO([ENTER, ENTER]);
    expect(await chooseSession(state(), new Screen(here), { workspaceId: "wsp_feat" })).toEqual({
      projectId: "prj_sy",
      workspace: { existingId: "wsp_feat" },
    });
    const other = fakeIO([DOWN, ENTER, ..."29", ENTER, ..."b", ENTER, ENTER]);
    expect(
      (await chooseSession(state(), new Screen(other), { workspaceId: "wsp_feat" }))?.workspace,
    ).toEqual({ checkoutId: "chk_29", newBranch: "b" });
  });

  it("refuses workspaces on hosts without terminal sessions", async () => {
    await expect(
      chooseSession(state(), new Screen(fakeIO([])), { workspaceId: "wsp_old" }),
    ).rejects.toThrow(/does not run terminal sessions/);
  });
});

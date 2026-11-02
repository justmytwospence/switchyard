import { describe, expect, it } from "vitest";
import { composerKey, globalAction } from "../src/keys.js";
import {
  backoffDelay,
  computePresence,
  FOREGROUND_MS,
  keypressShouldSend,
} from "../src/presence.js";
import { applySnapshot, applyStream, applyTranscriptPage, emptyState } from "../src/store.js";
import { markdownToText, uiToText } from "../src/uinode.js";
import {
  composerDisabledReason,
  groupSessions,
  statusLine,
  transcriptTail,
  wrapText,
} from "../src/view.js";
import { host, item, project, run, session, syncState } from "./fixtures.js";

const ctx = { busy: false, canSteer: true, disabledReason: null };

describe("composer keys", () => {
  it("Enter sends a prompt when idle; Alt+Enter inserts a newline", () => {
    expect(composerKey("hi", "", { return: true }, ctx)).toEqual({
      kind: "send",
      mode: "prompt",
      text: "hi",
    });
    expect(composerKey("hi", "", { return: true, meta: true }, ctx)).toEqual({
      kind: "edit",
      draft: "hi\n",
    });
  });

  it("while running Enter queues a follow-up and Ctrl+S steers only when supported", () => {
    const busy = { ...ctx, busy: true };
    expect(composerKey("x", "", { return: true }, busy)).toMatchObject({ mode: "followUp" });
    expect(composerKey("x", "s", { ctrl: true }, busy)).toMatchObject({ mode: "steer" });
    expect(composerKey("x", "s", { ctrl: true }, { ...busy, canSteer: false })).toEqual({
      kind: "blocked",
      reason: "This host does not support steering",
    });
    expect(composerKey("x", "s", { ctrl: true }, ctx)).toEqual({ kind: "none" });
  });

  it("does not send empty drafts and reports why sending is disabled", () => {
    expect(composerKey("  ", "", { return: true }, ctx)).toEqual({ kind: "none" });
    expect(
      composerKey("x", "", { return: true }, { ...ctx, disabledReason: "Host offline" }),
    ).toEqual({ kind: "blocked", reason: "Host offline" });
  });

  it("edits text with typing, paste and backspace", () => {
    expect(composerKey("a", "bc", {}, ctx)).toEqual({ kind: "edit", draft: "abc" });
    expect(composerKey("abc", "", { backspace: true }, ctx)).toEqual({ kind: "edit", draft: "ab" });
  });
});

describe("global keys", () => {
  it("Ctrl+C always quits (detach); Ctrl+T/Ctrl+X only in the session view", () => {
    expect(globalAction("c", { ctrl: true }, { screen: "session", typing: true })).toBe("quit");
    expect(globalAction("t", { ctrl: true }, { screen: "session", typing: true })).toBe("takeover");
    expect(globalAction("x", { ctrl: true }, { screen: "session", typing: false })).toBe("stop");
    expect(globalAction("t", { ctrl: true }, { screen: "list", typing: false })).toBeNull();
  });

  it("? opens help only when not typing; / searches on the list", () => {
    expect(globalAction("?", {}, { screen: "session", typing: false })).toBe("help");
    expect(globalAction("?", {}, { screen: "session", typing: true })).toBeNull();
    expect(globalAction("/", {}, { screen: "list", typing: false })).toBe("search");
    expect(globalAction("/", {}, { screen: "list", typing: false, searching: true })).toBeNull();
    expect(globalAction("", { escape: true }, { screen: "help", typing: false })).toBe("back");
  });
});

describe("presence", () => {
  it("is foreground for 45 s after a keypress", () => {
    const t0 = Date.parse("2026-11-02T10:00:00Z");
    expect(computePresence(t0, null, null)).toEqual({
      foreground: false,
      interactedAt: null,
      viewing: null,
    });
    const p = computePresence(t0 + 1000, t0, "ses_1");
    expect(p).toEqual({
      foreground: true,
      interactedAt: "2026-11-02T10:00:00.000Z",
      viewing: { sessionId: "ses_1" },
    });
    expect(computePresence(t0 + FOREGROUND_MS, t0, null).foreground).toBe(false);
  });

  it("throttles keypress presence unless foreground or viewing changes", () => {
    const a = computePresence(1000, 1000, "ses_1");
    const b = computePresence(2000, 2000, "ses_1");
    expect(keypressShouldSend(a, b, 2000, 1000)).toBe(false);
    expect(keypressShouldSend(a, b, 7000, 1000)).toBe(true);
    expect(keypressShouldSend(a, computePresence(2000, 2000, null), 2000, 1000)).toBe(true);
  });

  it("backs off 1, 2, 5, 10, 20, 30 s", () => {
    const mid = () => 0.5;
    expect([1, 2, 3, 4, 5, 6, 9].map((n) => backoffDelay(n, mid))).toEqual([
      1000, 2000, 5000, 10000, 20000, 30000, 30000,
    ]);
  });
});

describe("views", () => {
  it("groups sessions by project and searches", () => {
    const s = applySnapshot(
      emptyState(),
      1,
      syncState({
        projects: [project(), project({ id: "prj_2", name: "beta" })],
        sessions: [
          session(),
          session({ id: "ses_2", title: "Docs", projectId: "prj_2" }),
          session({ id: "ses_3", title: "Loose", projectId: null }),
          session({ id: "ses_4", title: "Old", archivedAt: "2026-11-01T00:00:00.000Z" }),
        ],
      }),
    );
    const groups = groupSessions(s);
    expect(groups.map((g) => [g.projectName, g.sessions.map((x) => x.id)])).toEqual([
      ["alpha", ["ses_1"]],
      ["beta", ["ses_2"]],
      ["No project", ["ses_3"]],
    ]);
    expect(groupSessions(s, "beta").flatMap((g) => g.sessions.map((x) => x.id))).toEqual(["ses_2"]);
  });

  it("renders tools as one line with status text and appends streaming text", () => {
    let s = applyTranscriptPage(
      applySnapshot(emptyState(), 1, syncState()),
      "ses_1",
      [
        item({ id: "itm_u", order: 1, kind: "user", data: { text: "do it" } }),
        item({
          id: "itm_t",
          order: 2,
          kind: "tool",
          data: {
            toolCallId: "c1",
            name: "bash",
            status: "ok",
            args: { command: "ls" },
            summary: "ls -la",
            output: "a\nb",
            startedAt: "2026-11-02T10:00:00.000Z",
            durationMs: 1200,
            card: null,
            adapterId: null,
          },
        }),
        item({ id: "itm_a", order: 3, kind: "assistant", data: { text: "Hel" } }),
      ],
      false,
    );
    s = applyStream(s, { sessionId: "ses_1", itemId: "itm_a", kind: "text", delta: "lo" });
    s = applyStream(s, { sessionId: "ses_1", itemId: "itm_z", kind: "text", delta: "next" });
    expect(transcriptTail(s, "ses_1", 10).map((l) => l.text)).toEqual([
      "you: do it",
      "tool bash: ls -la [done 1.2s]",
      "Hello",
      "next",
    ]);
  });

  it("status line shows runtime, control, host and connectivity", () => {
    const s = applySnapshot(
      emptyState(),
      1,
      syncState({
        hosts: [host({ connectivity: "reconnecting" })],
        sessions: [session({ runtime: "running", runId: "run_1" })],
        runs: [run({ controlMode: "human" })],
      }),
    );
    expect(statusLine(s, s.sessions.ses_1!)).toBe(
      "Running | control: you (taken over) | host: mac (reconnecting) | reconnecting to coordinator",
    );
    expect(composerDisabledReason(s, s.sessions.ses_1!)).toBe("Host offline");
  });

  it("renders UI nodes and markdown as text", () => {
    expect(markdownToText("# Title\n```ts\nx\n```\n**bold**")).toEqual(["Title", "x", "bold"]);
    expect(
      uiToText({
        t: "list",
        ordered: true,
        items: [
          { t: "text", text: "one" },
          { t: "progress", label: "Build", value: 0.5, status: "running" },
        ],
      }),
    ).toEqual(["1. one", "2. Build 50% (running)"]);
  });

  it("wraps long lines at spaces", () => {
    expect(wrapText("aaaa bbbb cccc", 10)).toEqual(["aaaa bbbb", "cccc"]);
  });
});

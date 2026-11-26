import type { Presence } from "@switchyard/protocol";
import { describe, expect, it } from "vitest";
import { herdrClientAttached, startFocusPresence } from "../src/mirror/focus.js";

const tick = () => new Promise((r) => setTimeout(r, 10));

describe("herdrClientAttached", () => {
  const ps = [
    "/opt/homebrew/bin/herdr server",
    "herdr --session vo",
    "/usr/bin/python3 /x/herdr/plugins/cycle.py watch",
    "ssh nuc exec /home/s/.local/bin/herdr remote-client-bridge",
  ];
  it("finds a client attached to a named session, not the server or bridges", () => {
    expect(herdrClientAttached(ps, "vo")).toBe(true);
    expect(herdrClientAttached(ps, "default")).toBe(false);
    expect(herdrClientAttached(ps, "fieldgoal")).toBe(false);
  });

  it("reads a bare herdr as the default session, and session attach", () => {
    expect(herdrClientAttached(["herdr"], "default")).toBe(true);
    expect(herdrClientAttached(["/opt/homebrew/bin/herdr --no-update"], "default")).toBe(true);
    expect(herdrClientAttached(["herdr session attach work"], "work")).toBe(true);
    expect(herdrClientAttached(["herdr session attach work"], "default")).toBe(false);
  });
});

describe("startFocusPresence", () => {
  it("reports the focused session under the terminal, on change, and clears it on stop", async () => {
    const sent: Presence[] = [];
    let focused: string | null = "ses_1";
    const f = startFocusPresence({
      terminalId: "herdr:vo@mac",
      send: (p) => {
        sent.push(p);
        return true;
      },
      focused: async () => focused,
      log: () => {},
    });
    await tick();
    expect(sent).toEqual([
      {
        foreground: true,
        interactedAt: null,
        viewing: { sessionId: "ses_1" },
        terminalId: "herdr:vo@mac",
      },
    ]);
    f.check();
    await tick();
    expect(sent).toHaveLength(1); // unchanged and not due
    focused = null;
    f.check();
    await tick();
    expect(sent.at(-1)).toMatchObject({ foreground: false, viewing: null });
    focused = "ses_2";
    f.check();
    await tick();
    f.stop();
    expect(sent.slice(-2).map((p) => p.viewing?.sessionId ?? null)).toEqual(["ses_2", null]);
  });

  it("retries a report the socket could not send", async () => {
    let up = false;
    const sent: Presence[] = [];
    const f = startFocusPresence({
      terminalId: "tmux:w@m",
      send: (p) => {
        if (up) sent.push(p);
        return up;
      },
      focused: async () => "ses_1",
      log: () => {},
    });
    await tick();
    up = true;
    f.check();
    await tick();
    expect(sent).toHaveLength(1);
    f.stop();
  });
});

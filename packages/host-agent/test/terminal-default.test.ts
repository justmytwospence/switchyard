import { describe, expect, it } from "vitest";
import { terminalSessionsWanted } from "../src/main.js";

describe("terminalSessionsWanted", () => {
  it("defaults on, and host.json, env and options turn it off", () => {
    expect(terminalSessionsWanted(undefined, {}, {})).toBe(true);
    expect(terminalSessionsWanted(undefined, { terminalSessions: false }, {})).toBe(false);
    expect(terminalSessionsWanted(undefined, {}, { SWITCHYARD_TERMINAL_SESSIONS: "0" })).toBe(
      false,
    );
    expect(terminalSessionsWanted(false, { terminalSessions: true }, {})).toBe(false);
    // host.json wins over the environment.
    expect(
      terminalSessionsWanted(
        undefined,
        { terminalSessions: true },
        { SWITCHYARD_TERMINAL_SESSIONS: "0" },
      ),
    ).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { ManagedSession } from "../src/session-runtime.js";
import { mockProfile } from "./helpers.js";

const args = (profile: object) =>
  new ManagedSession({
    sessionId: "ses_args",
    cwd: "/tmp",
    title: "t",
    profile: { ...mockProfile, ...profile },
  }).buildArgs();

describe("profile resources", () => {
  it("vanilla disables extensions, skills and prompt templates", () => {
    expect(args({ resources: "vanilla" })).toEqual(
      expect.arrayContaining(["--no-extensions", "--no-skills", "--no-prompt-templates"]),
    );
  });
  it("default loads everything", () => {
    const a = args({});
    expect(a).not.toContain("--no-extensions");
    expect(a).not.toContain("--no-skills");
    expect(a).not.toContain("--no-prompt-templates");
  });
});

describe("allocOrder", () => {
  it("reserves orders monotonically, never below the floor", () => {
    const ms = new ManagedSession({
      sessionId: "s",
      cwd: "/tmp",
      title: "t",
      profile: mockProfile,
      nextOrder: 5,
    });
    expect(ms.allocOrder()).toBe(5);
    expect(ms.nextOrder).toBe(6);
    expect(ms.allocOrder(10)).toBe(10);
    expect(ms.nextOrder).toBe(11);
    expect(ms.allocOrder(3)).toBe(11);
  });
});

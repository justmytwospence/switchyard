import { describe, expect, it } from "vitest";
import { matchesProject, repoLabel } from "../src/lib/repo";

describe("repo labels", () => {
  it("shows Local only for local identities and strips the scheme", () => {
    expect(repoLabel("local:3f2a9c")).toBe("Local only");
    expect(repoLabel("https://github.com/me/app")).toBe("github.com/me/app");
  });
  it("matches name or remote, case-insensitively", () => {
    const p = { name: "Switchyard", repoIdentity: "https://github.com/me/aac-touchid" };
    expect(matchesProject(p, "SWITCH")).toBe(true);
    expect(matchesProject(p, "touchid")).toBe(true);
    expect(matchesProject(p, "nope")).toBe(false);
    expect(matchesProject(p, "  ")).toBe(true);
  });
});

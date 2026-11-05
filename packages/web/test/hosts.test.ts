import { describe, expect, it } from "vitest";
import { disconnectedHostsTitle, hostSetupScript } from "../src/features/settings/HostsSection";
import { parseProjectFolders, scanSummary } from "../src/features/settings/projectFolders";

describe("hostSetupScript", () => {
  it("installs, enrolls, then installs the service", () => {
    expect(
      hostSetupScript("switchyard host enroll --coordinator https://x --token t").split("\n"),
    ).toEqual([
      "npm install -g @spencerboucher/switchyard",
      "switchyard host enroll --coordinator https://x --token t",
      "switchyard host install-service",
    ]);
  });
});

describe("disconnectedHostsTitle", () => {
  it("names the disconnected hosts", () => {
    expect(disconnectedHostsTitle(["nuc", "mac"])).toBe("2 hosts are not connected: nuc, mac");
  });
});

describe("project folders", () => {
  const scan = {
    state: "done" as const,
    startedAt: "2026-11-02T10:00:00.000Z",
    finishedAt: "2026-11-02T10:00:00.000Z",
    repositories: 5,
    projectsCreated: 2,
    checkoutsAdded: 3,
    errors: ["/x: missing"],
  };
  const now = Date.parse("2026-11-02T10:00:10.000Z");

  it("parses one folder per line and reports the first problem", () => {
    expect(parseProjectFolders(" ~/Projects \n\n/srv/x\n")).toEqual({
      folders: ["~/Projects", "/srv/x"],
      problem: null,
    });
    expect(parseProjectFolders("~/a\nrel/b").problem).toBe(
      '"rel/b" is not an absolute path or a ~/ path.',
    );
    const many = Array.from({ length: 21 }, (_, i) => `/f${i}`).join("\n");
    expect(parseProjectFolders(many).problem).toBe("Use at most 20 folders.");
  });

  it("summarizes each scan state", () => {
    expect(scanSummary(undefined)).toBe("Not scanned yet.");
    expect(scanSummary({ ...scan, state: "running" }, now)).toBe("Scanning…");
    expect(scanSummary(scan, now)).toBe(
      "Last scanned just now: 5 repositories, 3 new checkouts, 2 new projects.",
    );
    expect(scanSummary({ ...scan, state: "failed" }, now)).toBe(
      "Last scan failed just now: /x: missing",
    );
  });
});

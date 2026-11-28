import { describe, expect, it } from "vitest";
import { checkoutRootProblem } from "../src/features/settings/CheckoutLocationCard";
import { checkoutFolderProblem } from "../src/features/settings/CheckoutPrepare";
import { disconnectedHostsTitle, hostSetupScript } from "../src/features/settings/HostsSection";

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

describe("checkout location", () => {
  it("allows exactly one absolute or home path, or a blank value to disable clones", () => {
    for (const root of [" ~/Projects ", "/srv/repos", ""]) {
      expect(checkoutRootProblem(root)).toBeNull();
    }
    for (const root of ["relative/path", "~/a\n/srv/b", "~other/Projects"]) {
      expect(checkoutRootProblem(root)).not.toBeNull();
    }
  });

  it("requires a safe single folder name after a collision", () => {
    expect(checkoutFolderProblem("repo-copy")).toBeNull();
    for (const folder of ["", ".", "..", ".git", ".GIT", "../escape", "nested/repo", "a\\b"]) {
      expect(checkoutFolderProblem(folder)).not.toBeNull();
    }
  });
});

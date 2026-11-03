import { describe, expect, it } from "vitest";
import { hostSetupScript } from "../src/features/settings/HostsSection";

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

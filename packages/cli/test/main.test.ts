import { describe, expect, it } from "vitest";
import { CliError } from "../src/config.js";
import { main, reportError } from "../src/main.js";
import { stubFetch, testCtx } from "./helpers.js";

describe("reportError", () => {
  it("returns the exit code without printing for a silent CliError", () => {
    const ctx = testCtx(stubFetch({}).fetch);
    expect(reportError(ctx, new CliError("doctor found failures", 1, true))).toBe(1);
    expect(ctx.errors).toEqual([]);
  });

  it("prints other errors with the exit code", () => {
    const ctx = testCtx(stubFetch({}).fetch);
    expect(reportError(ctx, new CliError("boom", 2))).toBe(2);
    expect(ctx.errors).toEqual(["switchyard: boom"]);
  });
});

describe("main", () => {
  it("reports subcommand errors and returns the exit code", async () => {
    const ctx = testCtx(stubFetch({}).fetch);
    const code = await main(
      [
        "node",
        "switchyard",
        "tasks",
        "list",
        "--state",
        "doing",
        "--coordinator",
        "http://c",
        "--credential",
        "t",
      ],
      ctx,
    );
    expect(code).toBe(1);
    expect(ctx.errors[0]).toMatch(/Unknown state "doing"/);
  });
});

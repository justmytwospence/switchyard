import { describe, expect, it } from "vitest";
import { SessionStats } from "../src/entities.js";

describe("completed usage watermark", () => {
  it("is optional for old hosts and survives stats parsing", () => {
    expect(SessionStats.parse({ tokens: null, costUsd: null })).toEqual({
      tokens: null,
      costUsd: null,
    });
    const stats = { tokens: 10, costUsd: 0.1, watermark: { runtimeId: "runtime", settleSeq: 1 } };
    expect(SessionStats.parse(stats)).toEqual(stats);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY])(
    "rejects unsafe settle sequence %s",
    (settleSeq) => {
      expect(
        SessionStats.safeParse({
          tokens: 1,
          costUsd: 1,
          watermark: { runtimeId: "runtime", settleSeq },
        }).success,
      ).toBe(false);
    },
  );

  it("requires a nonempty runtime identity", () => {
    expect(
      SessionStats.safeParse({ tokens: 1, costUsd: 1, watermark: { runtimeId: "", settleSeq: 1 } })
        .success,
    ).toBe(false);
  });
});

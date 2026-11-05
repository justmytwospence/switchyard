import { describe, expect, it } from "vitest";
import {
  defaultDeviceName,
  ERROR_TEXT,
  enrollErrorText,
  HANDOFF_POLL_MS,
  HANDOFF_TIMEOUT_MS,
  handoffReduce,
  shouldPoll,
  startHandoff,
} from "../src/features/enroll/logic";
import { worktreeDirProblem } from "../src/features/settings/worktreeDir";

const T = 1_000_000;

describe("handoff poll state machine", () => {
  it("starts waiting and polls every 2 seconds", () => {
    expect(HANDOFF_POLL_MS).toBe(2000);
    const s = startHandoff(T);
    expect(s).toEqual({ phase: "waiting", startedAt: T, message: null });
    expect(shouldPoll(s, true)).toBe(true);
    expect(shouldPoll(s, false)).toBe(false);
  });

  it("stays waiting while the claim is pending", () => {
    const s = handoffReduce(startHandoff(T), {
      type: "claim",
      result: { status: "pending" },
      now: T + 2000,
    });
    expect(s.phase).toBe("waiting");
  });

  it("is done when the claim completes, and then stops polling", () => {
    const s = handoffReduce(startHandoff(T), {
      type: "claim",
      result: { status: "done", deviceId: "dev_1" },
      now: T + 4000,
    });
    expect(s.phase).toBe("done");
    expect(shouldPoll(s, true)).toBe(false);
  });

  it("times out after 10 minutes", () => {
    expect(HANDOFF_TIMEOUT_MS).toBe(600_000);
    const s = startHandoff(T);
    expect(handoffReduce(s, { type: "tick", now: T + HANDOFF_TIMEOUT_MS - 1 }).phase).toBe(
      "waiting",
    );
    expect(handoffReduce(s, { type: "tick", now: T + HANDOFF_TIMEOUT_MS }).phase).toBe("timeout");
    expect(
      handoffReduce(s, {
        type: "claim",
        result: { status: "pending" },
        now: T + HANDOFF_TIMEOUT_MS,
      }).phase,
    ).toBe("timeout");
  });

  it("keeps waiting through transient errors but fails on an expired flow", () => {
    const s = startHandoff(T);
    expect(
      handoffReduce(s, { type: "claim_error", code: "network", message: "x", now: T }).phase,
    ).toBe("waiting");
    const failed = handoffReduce(s, {
      type: "claim_error",
      code: "unauthorized",
      message: "expired",
      now: T,
    });
    expect(failed).toMatchObject({ phase: "failed", message: "expired" });
  });

  it("cancels, and terminal phases never change", () => {
    const cancelled = handoffReduce(startHandoff(T), { type: "cancel" });
    expect(cancelled.phase).toBe("canceled");
    const after = handoffReduce(cancelled, {
      type: "claim",
      result: { status: "done", deviceId: "d" },
      now: T,
    });
    expect(after).toBe(cancelled);
  });
});

describe("enroll error text", () => {
  it("keeps the existing enrollment messages", () => {
    expect(enrollErrorText("enrollment_expired")).toBe(ERROR_TEXT.enrollment_expired);
    expect(enrollErrorText("enrollment_used")).toMatch(/already used/);
    expect(enrollErrorText("network")).toMatch(/Could not reach/);
  });

  it("explains rate limiting and unsupported capabilities", () => {
    expect(enrollErrorText("rate_limited")).toMatch(/Too many attempts/);
    expect(enrollErrorText("unsupported_capability")).toMatch(/not available/);
    expect(enrollErrorText("unsupported_capability", "Passkeys need HTTPS")).toBe(
      "Passkeys need HTTPS",
    );
  });

  it("shows the coordinator's detail for forbidden", () => {
    const detail = "Signed in as sam (subject s1), which is not this server's owner.";
    expect(enrollErrorText("forbidden", detail)).toBe(detail);
    expect(enrollErrorText("forbidden")).toMatch(/not allowed/);
  });

  it("prefixes oidc_failed with the detail", () => {
    expect(enrollErrorText("oidc_failed", "invalid_grant")).toBe(
      "Single sign-on failed: invalid_grant",
    );
    expect(enrollErrorText("oidc_failed")).toMatch(/^Single sign-on failed:/);
  });

  it("falls back to the detail or the code for unknown errors", () => {
    expect(enrollErrorText("weird", "something happened")).toBe("something happened");
    expect(enrollErrorText("weird")).toContain("weird");
  });
});

describe("defaultDeviceName", () => {
  it("names the browser and device", () => {
    expect(
      defaultDeviceName(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Safari/604.1",
      ),
    ).toBe("Safari on iPhone");
  });
});

describe("worktree folder validation", () => {
  it("accepts repo-relative folders", () => {
    expect(worktreeDirProblem(".worktrees")).toBeNull();
    expect(worktreeDirProblem(".git/worktrees-switchyard")).toBeNull();
    expect(worktreeDirProblem(" wt ")).toBeNull();
  });

  it("rejects empty, absolute, escaping and odd paths", () => {
    expect(worktreeDirProblem("")).toMatch(/Enter/);
    expect(worktreeDirProblem("/abs")).toMatch(/relative/);
    expect(worktreeDirProblem("C:\\x")).toMatch(/relative/);
    expect(worktreeDirProblem("../x")).toMatch(/inside/);
    expect(worktreeDirProblem("a/../b")).toMatch(/inside/);
    expect(worktreeDirProblem("a//b")).toMatch(/plain/);
    expect(worktreeDirProblem("./a")).toMatch(/plain/);
  });
});

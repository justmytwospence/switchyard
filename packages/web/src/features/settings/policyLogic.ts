import {
  CreatePolicyRuleRequest,
  POLICY_CAPABILITY_EXPLANATION,
  PolicyTestRequest,
  type Session,
  UpdatePolicySettingsRequest,
} from "@switchyard/protocol";

export const CONTINUATION_BUDGET_HELP = `${POLICY_CAPABILITY_EXPLANATION} At 80% of a continuation budget, approval is required, including for cheap models. At 100%, the next continuation is stopped for expensive or unclassified models; explicitly cheap models have no hard budget stop. Missing or stale usage blocks continuation when a limit is configured. There is no mid-turn spending guarantee.`;

export function protectionLabel(session: Pick<Session, "bridge">): string {
  const bridge = session.bridge;
  if (bridge?.policyState === "active") {
    const phases = bridge.policyPhases.map((p) =>
      p === "tool_call" ? "Tool call" : "API request",
    );
    return phases.length ? `Active: ${phases.join(", ")}` : "Not enforced: no active policy phases";
  }
  if (bridge?.policyState === "initializing") return "Not enforced: protection initializing";
  if (bridge?.policyState === "lost") return "Not enforced: protection connection lost";
  return "Not enforced: reload or restart this session to enable protection";
}

export function validateRule(input: unknown) {
  return CreatePolicyRuleRequest.safeParse(input);
}
export function validateSettings(input: unknown) {
  return UpdatePolicySettingsRequest.safeParse(input);
}
export function validateTest(input: unknown) {
  return PolicyTestRequest.safeParse(input);
}
export function verdictLabel(verdict: "ALLOW" | "ASK" | "DENY" | null): string {
  return verdict === "ALLOW"
    ? "Allow"
    : verdict === "ASK"
      ? "Ask"
      : verdict === "DENY"
        ? "Deny"
        : "No match";
}

import { z } from "zod";

declare const TextEncoder: { new (): { encode(input: string): Uint8Array } };
declare const URL: {
  new (
    input: string,
  ): {
    protocol: string;
    username: string;
    password: string;
    hostname: string;
    port: string;
    pathname: string;
    search: string;
    hash: string;
  };
};

const Id = z.string().min(1).max(200);
const Revision = z.number().int().safe().min(1);
const Instant = z.string().refine((s) => {
  try {
    return new Date(s).toISOString() === s;
  } catch {
    return false;
  }
});
const Text = z.string().max(4000);
const Reason = Text.min(1);
const Fingerprint = z.string().regex(/^[0-9a-f]{64}$/);
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const bytes = (s: string) => new TextEncoder().encode(s).length;
function validJson(value: unknown, depth = 0, seen = new Set<object>()): boolean {
  if (depth > 20) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number")
    return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
  if (typeof value !== "object" || seen.has(value)) return false;
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    return false;
  seen.add(value);
  const ok = Object.entries(value).every(
    ([k, v]) => !forbidden.has(k) && validJson(v, depth + 1, seen),
  );
  seen.delete(value);
  return ok;
}
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const JsonObject = z.custom<Record<string, Json>>(
  (v) => !!v && typeof v === "object" && !Array.isArray(v) && validJson(v),
);
const scopeShape = { scope: z.enum(["session", "profile", "server"]), scopeId: Id.nullable() };
const scopeValid = (v: { scope: string; scopeId: string | null }) =>
  (v.scope === "server") === (v.scopeId === null);
export const POLICY_CAPABILITY_EXPLANATION =
  "Pre-provider policies are unavailable with this Pi integration. Budgets are checked before automated continuations, not during a running turn.";
export const PolicyPhase = z.enum(["tool_call", "request"]);
export const PolicyVerdict = z.enum(["ALLOW", "ASK", "DENY"]);
export const PolicyRequestAction = z.enum([
  "task.create",
  "message.send",
  "inbox.read",
  "run.continue",
]);
export const PolicyScope = scopeShape.scope;
export const PolicyCounterMap = z
  .record(
    z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)
      .refine((k) => !forbidden.has(k)),
    z.number().int().safe(),
  )
  .refine((v) => Object.keys(v).length <= 64);
const phases = z
  .array(PolicyPhase)
  .min(1)
  .max(2)
  .refine((v) => new Set(v).size === v.length);
const ruleFields = {
  priority: z.number().int().safe().min(-1000000).max(1000000),
  enabled: z.boolean(),
  phases,
  name: z.string().min(1).max(120),
  expression: z.string().min(1).max(8192),
};
export const PolicyRule = z
  .object({
    id: Id,
    ...scopeShape,
    ...ruleFields,
    revision: Revision,
    builtIn: z.boolean(),
    createdAt: Instant,
    updatedAt: Instant,
  })
  .strict()
  .refine(scopeValid);
export const PolicyToolSafety = z
  .object({
    destructiveDelete: z.boolean(),
    forcePush: z.boolean(),
    defaultBranchPush: z.boolean(),
    uncertain: z.boolean(),
    reasons: z.array(z.string().min(1).max(1000)).max(16),
  })
  .strict();
export const PolicyToolContext = z
  .object({ name: Id, args: JsonObject, safety: PolicyToolSafety })
  .strict();
export const PolicyRequestContext = z
  .object({ method: PolicyRequestAction, args: JsonObject })
  .strict();
const absolutePath = z
  .string()
  .min(1)
  .max(8192)
  .refine((v) => v.startsWith("/") || /^[A-Za-z]:[\\/]/.test(v));
const controlMode = z.enum(["human", "automation"]);
export const PolicySessionContext = z
  .object({
    id: Id,
    hostId: Id,
    nativeSessionId: Id.nullable(),
    runtimeId: Id.nullable(),
    profileId: Id,
    projectId: Id.nullable(),
    taskId: Id.nullable(),
    runId: Id.nullable(),
    controlMode,
    controlRevision: Revision,
    cwd: absolutePath,
    workspaceRoot: absolutePath,
    repository: z.string().min(1).max(2048).nullable(),
    defaultBranch: z.string().min(1).max(255).nullable(),
    readOnly: z.boolean(),
  })
  .strict();
export const PolicyTaskContext = z
  .object({
    id: Id,
    projectId: Id,
    rootTaskId: Id,
    parentTaskId: Id.nullable(),
    title: z.string().min(1).max(300),
    state: z.enum(["backlog", "ready", "in_progress", "review", "done", "canceled"]),
  })
  .strict();
export const PolicyTargetContext = z
  .object({
    id: Id,
    hostId: Id,
    projectId: Id.nullable(),
    taskId: Id.nullable(),
    controlMode,
    controlRevision: Revision,
    runtime: z.enum([
      "starting",
      "idle",
      "running",
      "waiting_input",
      "interrupted",
      "failed",
      "stopped",
    ]),
    readOnly: z.boolean(),
  })
  .strict();
export const PolicyCostContext = z
  .object({
    tokens: z.number().int().safe().nonnegative().nullable(),
    costUsd: z.number().finite().nonnegative().nullable(),
    maxTokens: z.number().int().safe().positive().nullable(),
    maxCostUsd: z.number().finite().positive().nullable(),
    accounting: z.enum(["available", "unavailable"]),
    fresh: z.boolean(),
    watermark: z.object({ runtimeId: Id, settleSeq: Revision }).strict().nullable(),
    provider: Id.nullable(),
    modelId: z.string().min(1).max(512).nullable(),
    classification: z.enum(["cheap", "expensive", "unclassified"]),
    expensive: z.boolean(),
  })
  .strict()
  .refine(
    (v) =>
      v.expensive === (v.classification !== "cheap") &&
      ((v.provider !== null && v.modelId !== null) || v.classification === "unclassified") &&
      (v.accounting === "available") === (v.tokens !== null || v.costUsd !== null),
  );
export const PolicyContext = z
  .object({
    phase: PolicyPhase,
    action: z.union([z.literal("tool.call"), PolicyRequestAction]),
    tool: PolicyToolContext.nullable(),
    request: PolicyRequestContext.nullable(),
    session: PolicySessionContext,
    task: PolicyTaskContext.nullable(),
    target: PolicyTargetContext.nullable(),
    cost: PolicyCostContext,
    counters: PolicyCounterMap,
  })
  .strict()
  .refine(
    (v) =>
      (v.phase === "tool_call"
        ? v.action === "tool.call" && v.tool !== null && v.request === null
        : v.tool === null && v.request !== null && v.action === v.request.method) &&
      (v.action === "message.send" ? v.target !== null : v.target === null),
  )
  .refine((v) => bytes(JSON.stringify(v)) <= 65536, "Policy input is too large to evaluate.");
export const PolicyRuleResult = z.union([
  z.null(),
  z
    .object({ verdict: PolicyVerdict, reason: Text, state_updates: PolicyCounterMap.optional() })
    .strict()
    .refine((v) => v.verdict === "ALLOW" || v.reason.length > 0),
]);
const webUrl = z
  .string()
  .max(4096)
  .refine((s) => {
    try {
      const u = new URL(s);
      return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password;
    } catch {
      return false;
    }
  });
export const PolicyEvaluation = z.discriminatedUnion("verdict", [
  z.object({ verdict: z.literal("ALLOW") }).strict(),
  z.object({ verdict: z.literal("DENY"), reason: Reason }).strict(),
  z
    .object({
      verdict: z.literal("ASK"),
      decisionId: Id,
      interactionId: Id,
      interactionUrl: webUrl,
    })
    .strict(),
]);
export const PolicyPermission = z
  .object({
    kind: z.literal("policy"),
    decisionId: Id,
    rootTaskId: Id.nullable(),
    ruleId: Id,
    ruleRevision: Revision,
    fingerprint: Fingerprint,
  })
  .strict();
export const PolicyGrant = z
  .object({
    id: Id,
    scope: z.object({ kind: z.enum(["task", "session"]), id: Id }).strict(),
    ruleId: Id,
    ruleRevision: Revision,
    fingerprint: Fingerprint,
    approvedByDeviceId: Id,
    approvedAt: Instant,
  })
  .strict();
const trimmed = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => s.trim() === s);
export const PolicyModelClassification = z
  .object({
    provider: trimmed(200),
    modelId: trimmed(512),
    classification: z.enum(["cheap", "expensive"]),
  })
  .strict();
const classifications = z
  .array(PolicyModelClassification)
  .max(1000)
  .refine((v) => new Set(v.map((x) => JSON.stringify([x.provider, x.modelId]))).size === v.length);
export const PolicySettings = z
  .object({ revision: Revision, modelClassifications: classifications, updatedAt: Instant })
  .strict();
const toolInput = z.object({ name: Id, args: JsonObject }).strict();
export const PolicyEvaluateRequest = z
  .object({ evaluationId: Id, toolCallId: Id, tool: toolInput })
  .strict();
export const PolicyStatusRequest = z.object({ decisionId: Id, waitMs: z.literal(25000) }).strict();
export const PolicyStatusResult = z.discriminatedUnion("state", [
  z.object({ state: z.literal("pending") }).strict(),
  z.object({ state: z.literal("allowed") }).strict(),
  z.object({ state: z.literal("denied"), reason: Reason }).strict(),
  z.object({ state: z.literal("canceled"), reason: Reason }).strict(),
]);
export const PolicyCancelRequest = z.object({ decisionId: Id }).strict();
export const PolicyCancelResult = z
  .object({ state: z.enum(["canceled", "already_resolved"]) })
  .strict();
export const PolicyTrace = z
  .object({
    ruleId: Id,
    ruleRevision: Revision,
    ...scopeShape,
    verdict: PolicyVerdict.nullable(),
    reason: Text.nullable(),
    granted: z.boolean(),
    overridden: z.boolean(),
    proposedStateUpdates: PolicyCounterMap,
  })
  .strict()
  .refine(scopeValid);
export const PolicyTestResult = z
  .object({
    verdict: PolicyVerdict,
    reason: Text.nullable(),
    trace: z.array(PolicyTrace).max(128),
    proposedStateUpdates: z.record(Id, PolicyCounterMap),
    enforcement: z
      .object({
        phases: z.array(PolicyPhase),
        modelRequest: z.literal(false),
        explanation: z.string(),
      })
      .strict(),
  })
  .strict();
export const CreatePolicyRuleRequest = z
  .object({ ...scopeShape, ...ruleFields })
  .strict()
  .refine(scopeValid);
export const UpdatePolicyRuleRequest = z
  .object({
    expectedRevision: Revision,
    name: ruleFields.name.optional(),
    priority: ruleFields.priority.optional(),
    enabled: z.boolean().optional(),
    phases: phases.optional(),
    expression: ruleFields.expression.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 1);
export const DeletePolicyRuleQuery = z.object({ expectedRevision: Revision }).strict();
export const UpdatePolicySettingsRequest = z
  .object({ expectedRevision: Revision, modelClassifications: classifications })
  .strict();
export const PolicyTestRequest = z
  .object({
    sessionId: Id,
    phase: PolicyPhase,
    tool: toolInput.nullable(),
    request: PolicyRequestContext.nullable(),
  })
  .strict()
  .refine((v) =>
    v.phase === "tool_call"
      ? v.tool !== null && v.request === null
      : v.tool === null && v.request !== null,
  );

export type PolicyPhase = z.infer<typeof PolicyPhase>;
export type PolicyVerdict = z.infer<typeof PolicyVerdict>;
export type PolicyRequestAction = z.infer<typeof PolicyRequestAction>;
export type PolicyScope = z.infer<typeof PolicyScope>;
export type PolicyCounterMap = z.infer<typeof PolicyCounterMap>;
export type PolicyRule = z.infer<typeof PolicyRule>;
export type PolicyToolSafety = z.infer<typeof PolicyToolSafety>;
export type PolicyToolContext = z.infer<typeof PolicyToolContext>;
export type PolicyRequestContext = z.infer<typeof PolicyRequestContext>;
export type PolicySessionContext = z.infer<typeof PolicySessionContext>;
export type PolicyTaskContext = z.infer<typeof PolicyTaskContext>;
export type PolicyTargetContext = z.infer<typeof PolicyTargetContext>;
export type PolicyCostContext = z.infer<typeof PolicyCostContext>;
export type PolicyContext = z.infer<typeof PolicyContext>;
export type PolicyRuleResult = z.infer<typeof PolicyRuleResult>;
export type PolicyEvaluation = z.infer<typeof PolicyEvaluation>;
export type PolicyPermission = z.infer<typeof PolicyPermission>;
export type PolicyGrant = z.infer<typeof PolicyGrant>;
export type PolicyModelClassification = z.infer<typeof PolicyModelClassification>;
export type PolicySettings = z.infer<typeof PolicySettings>;
export type PolicyEvaluateRequest = z.infer<typeof PolicyEvaluateRequest>;
export type PolicyStatusRequest = z.infer<typeof PolicyStatusRequest>;
export type PolicyStatusResult = z.infer<typeof PolicyStatusResult>;
export type PolicyCancelRequest = z.infer<typeof PolicyCancelRequest>;
export type PolicyCancelResult = z.infer<typeof PolicyCancelResult>;
export type PolicyTrace = z.infer<typeof PolicyTrace>;
export type PolicyTestResult = z.infer<typeof PolicyTestResult>;
export type CreatePolicyRuleRequest = z.infer<typeof CreatePolicyRuleRequest>;
export type UpdatePolicyRuleRequest = z.infer<typeof UpdatePolicyRuleRequest>;
export type DeletePolicyRuleQuery = z.infer<typeof DeletePolicyRuleQuery>;
export type UpdatePolicySettingsRequest = z.infer<typeof UpdatePolicySettingsRequest>;
export type PolicyTestRequest = z.infer<typeof PolicyTestRequest>;

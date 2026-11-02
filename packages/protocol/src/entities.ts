import { z } from "zod";
import { UINodeSchema } from "./ui.js";

const Iso = z.string();
const Id = z.string();

export const Connectivity = z.enum(["connected", "reconnecting", "unreachable"]);
export type Connectivity = z.infer<typeof Connectivity>;

export const CAPABILITY_KEYS = [
  "prompt",
  "steer",
  "followUp",
  "abort",
  "resume",
  "rename",
  "importInactive",
  "extensionDialogs",
  "customUi",
  "widgetsText",
  "widgetsComponent",
  "tokenAccounting",
  "costAccounting",
] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

export const RuntimeCapabilities = z.object({
  prompt: z.boolean(),
  steer: z.boolean(),
  followUp: z.boolean(),
  abort: z.boolean(),
  resume: z.boolean(),
  rename: z.boolean(),
  importInactive: z.boolean(),
  extensionDialogs: z.boolean(),
  customUi: z.boolean(),
  widgetsText: z.boolean(),
  widgetsComponent: z.boolean(),
  tokenAccounting: z.boolean(),
  costAccounting: z.boolean(),
  unsupported: z.array(z.object({ capability: z.string(), reason: z.string() })),
});
export type RuntimeCapabilities = z.infer<typeof RuntimeCapabilities>;

export const Host = z.object({
  id: Id,
  name: z.string(),
  platform: z.enum(["darwin", "linux"]),
  agentVersion: z.string(),
  piVersion: z.string().nullable(),
  piCompatible: z.boolean(),
  capabilities: RuntimeCapabilities.nullable(),
  connectivity: Connectivity,
  lastSeenAt: Iso.nullable(),
  revokedAt: Iso.nullable(),
  createdAt: Iso,
});
export type Host = z.infer<typeof Host>;

export const Project = z.object({
  id: Id,
  name: z.string().min(1),
  repoIdentity: z.string(),
  defaultProfileId: Id.nullable(),
  defaultHostId: Id.nullable(),
  maxConcurrentRuns: z.number().int().min(1).max(32),
  automationEnabled: z.boolean(),
  setupCommand: z.string().nullable(),
  checks: z.array(z.string()),
  workspaceSharing: z.enum(["single_writer", "shared"]),
  createdAt: Iso,
  updatedAt: Iso,
});
export type Project = z.infer<typeof Project>;

export const Checkout = z.object({
  id: Id,
  projectId: Id,
  hostId: Id,
  path: z.string(),
  commonDir: z.string(),
  defaultBranch: z.string(),
  createdAt: Iso,
});
export type Checkout = z.infer<typeof Checkout>;

export const GitState = z.object({
  dirty: z.boolean(),
  changedFiles: z.number().int(),
  ahead: z.number().int(),
  behind: z.number().int(),
  unmerged: z.boolean(),
});
export type GitState = z.infer<typeof GitState>;

export const Workspace = z.object({
  id: Id,
  checkoutId: Id,
  projectId: Id,
  hostId: Id,
  path: z.string(),
  branch: z.string().nullable(),
  baseBranch: z.string().nullable(),
  provenance: z.enum(["managed", "discovered", "main"]),
  git: GitState,
  setup: z.object({
    state: z.enum(["none", "running", "succeeded", "failed"]),
    log: z.string(),
  }),
  archivedAt: Iso.nullable(),
  updatedAt: Iso,
});
export type Workspace = z.infer<typeof Workspace>;

export const ThinkingLevel = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export type ThinkingLevel = z.infer<typeof ThinkingLevel>;

const FORBIDDEN_EXTRA_ARGS = ["--mode", "--fork", "--no-session", "-e", "--extension"];
export const ExtraArg = z
  .string()
  .refine((a) => a.startsWith("--") || !a.startsWith("-"), "extra args must be long flags")
  .refine(
    (a) => !FORBIDDEN_EXTRA_ARGS.includes(a.split("=")[0]!) && !a.startsWith("--session"),
    "this flag is managed by Switchyard",
  );

export const Profile = z.object({
  id: Id,
  name: z.string().min(1),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  thinking: ThinkingLevel.nullable(),
  projectTrust: z.enum(["ask", "approve", "ignore"]),
  extraArgs: z.array(ExtraArg),
});
export type Profile = z.infer<typeof Profile>;

export const RuntimeState = z.enum([
  "starting",
  "idle",
  "running",
  "waiting_input",
  "interrupted",
  "failed",
  "stopped",
]);
export type RuntimeState = z.infer<typeof RuntimeState>;

export const NativeHandle = z.object({ sessionId: z.string(), sessionFile: z.string() });
export type NativeHandle = z.infer<typeof NativeHandle>;

export const SessionStats = z.object({
  tokens: z.number().nullable(),
  costUsd: z.number().nullable(),
});
export type SessionStats = z.infer<typeof SessionStats>;

export const Session = z.object({
  id: Id,
  title: z.string(),
  subtitle: z.string().nullable(),
  hostId: Id,
  workspaceId: Id.nullable(),
  projectId: Id.nullable(),
  cwd: z.string(),
  nativeHandle: NativeHandle.nullable(),
  profileSnapshot: Profile,
  runtime: RuntimeState,
  runtimeDetail: z.string().nullable(),
  connectivity: Connectivity,
  runId: Id.nullable(),
  taskId: Id.nullable(),
  provenance: z.enum(["created", "imported", "subagent"]),
  readOnly: z.boolean(),
  lastActivityAt: Iso,
  archivedAt: Iso.nullable(),
  queue: z.object({ steering: z.array(z.string()), followUp: z.array(z.string()) }),
  stats: SessionStats.nullable(),
  lastAssistantText: z.string().nullable(),
  createdAt: Iso,
});
export type Session = z.infer<typeof Session>;

export const ContinuationPolicy = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(false) }),
  z.object({
    enabled: z.literal(true),
    objective: z.string().min(1),
    maxContinuations: z.number().int().min(1).max(50),
    maxElapsedMinutes: z.number().int().min(1).max(1440),
    maxTokens: z.number().int().positive().nullable(),
    maxCostUsd: z.number().positive().nullable(),
  }),
]);
export type ContinuationPolicy = z.infer<typeof ContinuationPolicy>;

export const CompletionPolicy = z.object({
  checks: z.array(z.string()).nullable(),
  requireHumanReview: z.boolean(),
});
export type CompletionPolicy = z.infer<typeof CompletionPolicy>;

export const WorkspacePolicy = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("new_worktree"),
    branch: z.string().nullable(),
    base: z.string().nullable(),
  }),
  z.object({ mode: z.literal("existing"), workspaceId: Id }),
]);
export type WorkspacePolicy = z.infer<typeof WorkspacePolicy>;

export const TaskPolicy = z.object({
  hostId: Id.nullable(),
  profileId: Id.nullable(),
  workspace: WorkspacePolicy,
  continuation: ContinuationPolicy,
  completion: CompletionPolicy,
});
export type TaskPolicy = z.infer<typeof TaskPolicy>;

export const DEFAULT_TASK_POLICY: TaskPolicy = {
  hostId: null,
  profileId: null,
  workspace: { mode: "new_worktree", branch: null, base: null },
  continuation: { enabled: false },
  completion: { checks: null, requireHumanReview: true },
};

export const TaskState = z.enum(["backlog", "ready", "in_progress", "review", "done", "canceled"]);
export type TaskState = z.infer<typeof TaskState>;

export const Priority = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
export type Priority = z.infer<typeof Priority>;
export const PRIORITY_LABELS = ["Urgent", "High", "Normal", "Low"] as const;

export const TaskOrigin = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual") }),
  z.object({
    kind: z.literal("automation"),
    automationId: Id,
    occurrenceId: Id,
    routine: z.boolean(),
  }),
]);
export type TaskOrigin = z.infer<typeof TaskOrigin>;

export const Task = z.object({
  id: Id,
  projectId: Id,
  title: z.string().min(1),
  objective: z.string(),
  acceptanceCriteria: z.array(z.string()),
  dependencies: z.array(Id),
  priority: Priority,
  position: z.number(),
  state: TaskState,
  blocked: z.object({ reason: z.string() }).nullable(),
  notBefore: Iso.nullable(),
  policy: TaskPolicy,
  origin: TaskOrigin,
  groupingKey: z.string().nullable(),
  currentRunId: Id.nullable(),
  sessionId: Id.nullable(),
  review: z.object({ feedback: z.array(z.string()), changesRequested: z.boolean() }),
  hiddenFromBoard: z.boolean(),
  lastActivityAt: Iso,
  createdAt: Iso,
  updatedAt: Iso,
});
export type Task = z.infer<typeof Task>;

export const RunState = z.enum([
  "queued",
  "dispatching",
  "uncertain",
  "running",
  "waiting_input",
  "checking",
  "succeeded",
  "failed",
  "interrupted",
  "canceled",
]);
export type RunState = z.infer<typeof RunState>;

export const CheckResult = z.object({
  command: z.string(),
  exitCode: z.number().int().nullable(),
  outputTail: z.string(),
});
export type CheckResult = z.infer<typeof CheckResult>;

export const Run = z.object({
  id: Id,
  taskId: Id,
  sessionId: Id.nullable(),
  hostId: Id.nullable(),
  dispatchKey: z.string(),
  attempt: z.number().int().min(1),
  state: RunState,
  controlMode: z.enum(["automation", "human"]),
  controlRevision: z.number().int().min(1),
  continuationsUsed: z.number().int().min(0),
  infraRetries: z.number().int().min(0),
  nextAttemptAt: Iso.nullable(),
  startedAt: Iso.nullable(),
  endedAt: Iso.nullable(),
  outcome: z
    .object({
      kind: z.enum(["review", "failed", "blocked", "no_change", "canceled"]),
      summary: z.string(),
    })
    .nullable(),
  limits: ContinuationPolicy,
  usage: z.object({
    tokens: z.number().nullable(),
    costUsd: z.number().nullable(),
    accounting: z.enum(["available", "unavailable"]),
    note: z.string().nullable(),
  }),
  checks: z.array(CheckResult),
  createdAt: Iso,
  updatedAt: Iso,
});
export type Run = z.infer<typeof Run>;

export const Trigger = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual") }),
  z.object({ kind: z.literal("once"), at: Iso }),
  z.object({ kind: z.literal("cron"), expr: z.string().min(1), timezone: z.string().min(1) }),
  z.object({ kind: z.literal("webhook") }),
  z.object({ kind: z.literal("dependency"), taskId: Id }),
]);
export type Trigger = z.infer<typeof Trigger>;

export const TaskTemplate = z.object({
  title: z.string().min(1),
  objective: z.string(),
  acceptanceCriteria: z.array(z.string()),
  priority: Priority,
});
export type TaskTemplate = z.infer<typeof TaskTemplate>;

export const Automation = z.object({
  id: Id,
  name: z.string().min(1),
  enabled: z.boolean(),
  projectId: Id,
  trigger: Trigger,
  filters: z.array(z.object({ path: z.string(), equals: z.string() })),
  template: TaskTemplate,
  hostId: Id.nullable(),
  profileId: Id.nullable(),
  mode: z.enum(["fresh", "continue", "watch"]),
  groupingKey: z.string().nullable(),
  overlap: z.enum(["skip", "queue_one", "append"]),
  missed: z.enum(["skip", "run_once"]),
  continuation: ContinuationPolicy,
  completion: CompletionPolicy,
  nextAt: Iso.nullable(),
  lastEvaluatedAt: Iso.nullable(),
  lastOutcome: z.string().nullable(),
  failureCount: z.number().int().min(0),
  webhookTokenSet: z.boolean(),
  createdAt: Iso,
  updatedAt: Iso,
});
export type Automation = z.infer<typeof Automation>;

export const OccurrenceState = z.enum([
  "fired",
  "skipped_overlap",
  "skipped_missed",
  "queued",
  "appended",
  "failed",
  "filtered",
]);
export type OccurrenceState = z.infer<typeof OccurrenceState>;

export const Occurrence = z.object({
  id: Id,
  automationId: Id,
  key: z.string(),
  scheduledFor: Iso.nullable(),
  state: OccurrenceState,
  taskId: Id.nullable(),
  reason: z.string().nullable(),
  outcome: z.string().nullable(),
  createdAt: Iso,
});
export type Occurrence = z.infer<typeof Occurrence>;

export const InteractionState = z.enum([
  "pending",
  "resolved",
  "expired",
  "cancelled",
  "unsupported",
]);
export type InteractionState = z.infer<typeof InteractionState>;

export const Interaction = z.object({
  id: Id,
  sessionId: Id,
  revision: z.number().int().min(1),
  source: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("extension_ui"),
      method: z.enum(["select", "confirm", "input", "editor"]),
      piRequestIds: z.array(z.string()),
    }),
    z.object({ kind: z.literal("unsupported_custom"), title: z.string().nullable() }),
  ]),
  adapterId: z.string().nullable(),
  title: z.string(),
  presentation: UINodeSchema,
  state: InteractionState,
  resolution: z.object({ by: z.string(), summary: z.string(), at: Iso }).nullable(),
  createdAt: Iso,
});
export type Interaction = z.infer<typeof Interaction>;

export const AttentionReason = z.enum([
  "needs_input",
  "failed",
  "ready_for_review",
  "unsupported_interaction",
  "host_unreachable",
]);
export type AttentionReason = z.infer<typeof AttentionReason>;

export const AttentionItem = z.object({
  id: Id,
  sessionId: Id.nullable(),
  taskId: Id.nullable(),
  projectId: Id.nullable(),
  reason: AttentionReason,
  severity: z.enum(["info", "warning", "critical"]),
  summary: z.string(),
  interactionId: Id.nullable(),
  deepLink: z.string(),
  acknowledgedAt: Iso.nullable(),
  resolvedAt: Iso.nullable(),
  createdAt: Iso,
});
export type AttentionItem = z.infer<typeof AttentionItem>;

export const Device = z.object({
  id: Id,
  name: z.string(),
  kind: z.enum(["browser", "pwa", "terminal", "cli"]),
  createdAt: Iso,
  lastSeenAt: Iso.nullable(),
  revokedAt: Iso.nullable(),
  push: z.object({
    subscribed: z.boolean(),
    permission: z.enum(["granted", "denied", "default", "unknown"]),
  }),
  preferredMobile: z.boolean(),
});
export type Device = z.infer<typeof Device>;

export const ToolItemData = z.object({
  toolCallId: z.string(),
  name: z.string(),
  status: z.enum(["running", "ok", "error"]),
  args: z.unknown(),
  summary: z.string(),
  output: z.string(),
  startedAt: Iso,
  durationMs: z.number().nullable(),
  card: UINodeSchema.nullable(),
  adapterId: z.string().nullable(),
});
export type ToolItemData = z.infer<typeof ToolItemData>;

export const TranscriptItem = z.discriminatedUnion("kind", [
  z.object({
    id: Id,
    sessionId: Id,
    order: z.number().int(),
    at: Iso,
    kind: z.literal("user"),
    data: z.object({ text: z.string(), images: z.number().int().optional() }),
  }),
  z.object({
    id: Id,
    sessionId: Id,
    order: z.number().int(),
    at: Iso,
    kind: z.literal("assistant"),
    data: z.object({ text: z.string(), streaming: z.boolean().optional() }),
  }),
  z.object({
    id: Id,
    sessionId: Id,
    order: z.number().int(),
    at: Iso,
    kind: z.literal("thinking"),
    data: z.object({ text: z.string() }),
  }),
  z.object({
    id: Id,
    sessionId: Id,
    order: z.number().int(),
    at: Iso,
    kind: z.literal("tool"),
    data: ToolItemData,
  }),
  z.object({
    id: Id,
    sessionId: Id,
    order: z.number().int(),
    at: Iso,
    kind: z.literal("notice"),
    data: z.object({ level: z.enum(["info", "warning", "error"]), text: z.string() }),
  }),
  z.object({
    id: Id,
    sessionId: Id,
    order: z.number().int(),
    at: Iso,
    kind: z.literal("interaction"),
    data: z.object({ interactionId: Id }),
  }),
  z.object({
    id: Id,
    sessionId: Id,
    order: z.number().int(),
    at: Iso,
    kind: z.literal("subagent"),
    data: z.object({
      runId: z.string(),
      label: z.string(),
      status: z.string(),
      sessionFile: z.string().nullable(),
      linkedSessionId: Id.nullable(),
    }),
  }),
  z.object({
    id: Id,
    sessionId: Id,
    order: z.number().int(),
    at: Iso,
    kind: z.literal("system"),
    data: z.object({ text: z.string(), suggestion: z.boolean().optional() }),
  }),
]);
export type TranscriptItem = z.infer<typeof TranscriptItem>;

export const Panel = z.object({
  sessionId: Id,
  adapterId: z.string(),
  slot: z.string(),
  title: z.string(),
  node: UINodeSchema.nullable(),
  webRenderer: z.boolean(),
  mobileFallback: z.string().nullable(),
  updatedAt: Iso,
});
export type Panel = z.infer<typeof Panel>;

export const Diagnostic = z.object({
  sessionId: Id.nullable(),
  adapterId: z.string().nullable(),
  level: z.enum(["info", "warning", "error"]),
  message: z.string(),
  at: Iso,
});
export type Diagnostic = z.infer<typeof Diagnostic>;

export const AdapterInfo = z.object({
  id: z.string(),
  version: z.string(),
  tier: z.enum(["project", "owner", "plugin", "bundled"]),
  target: z.object({
    extension: z.string(),
    versionRange: z.string(),
    testedVersions: z.array(z.string()),
  }),
  capabilities: z.array(z.string()),
  webRenderer: z.boolean(),
  status: z.enum(["active", "disabled", "error"]),
  detail: z.string().nullable(),
});
export type AdapterInfo = z.infer<typeof AdapterInfo>;

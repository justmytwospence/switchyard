import { z } from "zod";
import {
  Automation,
  CompletionPolicy,
  ContinuationPolicy,
  Device,
  DeviceKind,
  ExtraArg,
  Passkey,
  Platform,
  Priority,
  ProjectScan,
  Session,
  SessionModel,
  SlashCommand,
  Task,
  TaskState,
  TaskTemplate,
  ThinkingLevel,
  TranscriptItem,
  Trigger,
  View,
  ViewClient,
  WorktreeDir,
} from "./entities.js";
import { ProjectSuggestion } from "./host-wire.js";
import { InteractionResponseSchema, UINodeSchema } from "./ui.js";

/** REST request bodies. Responses return entities from `entities.ts` unless noted. */

export const EnrollRequest = z.object({
  token: z.string().min(1),
  name: z.string().min(1).max(80),
  kind: DeviceKind,
});
export const EnrollResponse = z.object({ deviceId: z.string(), credential: z.string() });

export const CreateEnrollmentRequest = z.object({ kind: z.enum(["device", "host"]) });
export const CreateEnrollmentResponse = z.object({
  token: z.string(),
  url: z.string(),
  expiresAt: z.string(),
  qrSvg: z.string(),
  command: z.string().nullable(),
});
export type CreateEnrollmentResponse = z.infer<typeof CreateEnrollmentResponse>;

export const HostEnrollRequest = z.union([
  z.object({
    token: z.string().min(1),
    name: z.string().min(1).max(80),
    platform: Platform,
  }),
  z.object({
    secret: z.string().min(1),
    name: z.string().min(1).max(80),
    platform: Platform,
  }),
]);
export const HostEnrollResponse = z.object({ hostId: z.string(), credential: z.string() });

export const CreateProjectRequest = z.object({
  name: z.string().min(1),
  hostId: z.string(),
  path: z.string().min(1),
  defaultProfileId: z.string().nullable().optional(),
  setupCommand: z.string().nullable().optional(),
  checks: z.array(z.string()).optional(),
  maxConcurrentRuns: z.number().int().min(1).max(32).optional(),
  worktreeDir: WorktreeDir.optional(),
});
export const UpdateProjectRequest = z.object({
  name: z.string().min(1).optional(),
  defaultProfileId: z.string().nullable().optional(),
  defaultHostId: z.string().nullable().optional(),
  maxConcurrentRuns: z.number().int().min(1).max(32).optional(),
  automationEnabled: z.boolean().optional(),
  setupCommand: z.string().nullable().optional(),
  checks: z.array(z.string()).optional(),
  workspaceSharing: z.enum(["single_writer", "shared"]).optional(),
  worktreeDir: WorktreeDir.optional(),
});
export const AddCheckoutRequest = z.object({ hostId: z.string(), path: z.string().min(1) });

/** A host project folder: absolute, or relative to the host user's home with `~`. */
export function isProjectFolderPath(s: string): boolean {
  if (s.includes("\0")) return false;
  return s === "~" || s.startsWith("~/") || s.startsWith("/");
}
export const ProjectFolder = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .refine(isProjectFolderPath, "must be an absolute path or start with ~/");
export const UpdateHostRequest = z.object({
  projectFolders: z.array(ProjectFolder).max(20).optional(),
});
export const ProjectScanResult = ProjectScan.extend({
  added: z.array(
    z.object({
      projectId: z.string(),
      name: z.string(),
      path: z.string(),
      newProject: z.boolean(),
    }),
  ),
});
export type ProjectScanResult = z.infer<typeof ProjectScanResult>;

export const ProfileInput = z.object({
  name: z.string().min(1),
  provider: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
  thinking: ThinkingLevel.nullable().default(null),
  projectTrust: z.enum(["ask", "approve", "ignore"]).default("ask"),
  extraArgs: z.array(ExtraArg).default([]),
  resources: z.enum(["all", "vanilla"]).default("all"),
});

export const CreateWorkspaceRequest = z.object({
  checkoutId: z.string(),
  branch: z.string().min(1),
  base: z.string().nullable().optional(),
});
export const RemoveWorkspaceRequest = z.object({
  force: z
    .object({ dirty: z.boolean(), unmerged: z.boolean() })
    .default({ dirty: false, unmerged: false }),
});

export const CreateSessionRequest = z.object({
  projectId: z.string(),
  workspace: z.union([
    z.object({ existingId: z.string() }),
    z.object({
      checkoutId: z.string(),
      newBranch: z.string().min(1),
      base: z.string().nullable().optional(),
    }),
  ]),
  profileId: z.string().nullable().optional(),
  prompt: z.string().default(""),
  title: z.string().optional(),
  viewId: z.string().optional(),
});

export const PromptRequest = z.object({
  text: z.string().min(1),
  mode: z.enum(["prompt", "steer", "followUp"]).default("prompt"),
  images: z.array(z.object({ mimeType: z.string(), data: z.string() })).default([]),
  clientMessageId: z.string().optional(),
});
export const CacheAlertRequest = z.object({
  enabled: z.boolean(),
  ttlSec: z.number().int().min(60).max(86400).nullable().default(null),
});
export const RenameRequest = z.object({ title: z.string().min(1).max(200) });
export const SetModelRequest = z.object({
  provider: z.string().min(1),
  modelId: z.string().min(1),
});
export const SetThinkingRequest = z.object({ level: ThinkingLevel });
export const CompactRequest = z.object({ instructions: z.string().max(4000).optional() });
export const SessionModelsResult = z.object({ models: z.array(SessionModel) });
export const SessionCommandsResult = z.object({ commands: z.array(SlashCommand) });
export const CompleteRequest = z.object({ text: z.string().min(1).max(500) });
export const CompletionItem = z.object({
  value: z.string(),
  label: z.string(),
  description: z.string().nullable(),
});
export type CompletionItem = z.infer<typeof CompletionItem>;
export const SessionCompleteResult = z.object({
  items: z.array(CompletionItem).max(50),
  prefix: z.string(),
});
export type SessionCompleteResult = z.infer<typeof SessionCompleteResult>;
export const TreeRow = z.object({
  entryId: z.string(),
  parentId: z.string().nullable(),
  depth: z.number().int(),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  activeBranch: z.boolean(),
  leaf: z.boolean(),
  label: z.string().nullable(),
  at: z.string().nullable(),
});
export type TreeRow = z.infer<typeof TreeRow>;
export const SessionTreeResult = z.object({ rows: z.array(TreeRow) });
export const BranchRequest = z.object({
  entryId: z.string().nullable(),
  fork: z.boolean().default(false),
});
export const HostBranchResult = z.object({
  sessionFile: z.string().nullable(),
  prefill: z.string().nullable(),
});
export const TranscriptPage = z.object({
  items: z.array(TranscriptItem),
  hasMore: z.boolean(),
  epoch: z.number().int().optional(),
  rev: z.number().int().optional(),
  delta: z.boolean().optional(),
  reset: z.boolean().optional(),
});
export type TranscriptPage = z.infer<typeof TranscriptPage>;
export const NavigateRequest = z.object({
  entryId: z.string().min(1),
  summarize: z.boolean().default(false),
  instructions: z.string().max(2000).nullable().default(null),
});
export const HostNavigateResult = z.object({
  items: z.array(TranscriptItem),
  prefill: z.string().nullable(),
});
export const NavigateResult = z.object({
  prefill: z.string().nullable(),
  epoch: z.number().int(),
});
export type NavigateResult = z.infer<typeof NavigateResult>;
export const BranchResult = z.object({
  session: Session.nullable(),
  prefill: z.string().nullable(),
});
export const SessionExportResult = z.object({ fileName: z.string(), content: z.string() });
export const CommandViewAction = z.object({
  label: z.string().min(1).max(80),
  command: z.string().startsWith("/").max(500),
  tone: z.enum(["default", "primary", "danger"]).optional(),
});
export const CommandView = z.object({
  title: z.string().min(1).max(200),
  body: UINodeSchema,
  actions: z.array(CommandViewAction).max(30).default([]),
});
export type CommandView = z.infer<typeof CommandView>;
export const ModelStateResult = z.object({
  model: SessionModel.nullable(),
  thinking: ThinkingLevel.nullable(),
});
export type ModelStateResult = z.infer<typeof ModelStateResult>;
export const ImportSessionRequest = z.object({
  hostId: z.string(),
  sessionFile: z.string(),
  projectId: z.string().nullable().optional(),
});

export const AnswerRequest = z.object({
  revision: z.number().int(),
  response: InteractionResponseSchema,
});

export const AdapterActionRequest = z.object({
  adapterId: z.string(),
  actionId: z.string(),
  payload: z.unknown().optional(),
});

/** A task policy update: every nested field is optional, so a patch can change one field. */
export const TaskPolicyPatch = z.object({
  hostId: z.string().nullable().optional(),
  profileId: z.string().nullable().optional(),
  workspace: z
    .object({
      mode: z.enum(["new_worktree", "existing"]).optional(),
      branch: z.string().nullable().optional(),
      base: z.string().nullable().optional(),
      workspaceId: z.string().optional(),
    })
    .optional(),
  continuation: z
    .object({
      enabled: z.boolean().optional(),
      objective: z.string().min(1).optional(),
      maxContinuations: z.number().int().min(1).max(50).optional(),
      maxElapsedMinutes: z.number().int().min(1).max(1440).optional(),
      maxTokens: z.number().int().positive().nullable().optional(),
      maxCostUsd: z.number().positive().nullable().optional(),
    })
    .optional(),
  completion: CompletionPolicy.partial().optional(),
});
export type TaskPolicyPatch = z.infer<typeof TaskPolicyPatch>;

/**
 * JSON merge patch (RFC 7396) except that null is a value: plain objects merge key by key,
 * any other value (null, arrays, scalars) replaces, absent/undefined keeps the base.
 */
export function mergePatch(base: unknown, patch: unknown): unknown {
  const obj = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  if (patch === undefined) return base;
  if (!obj(base) || !obj(patch)) return patch;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) out[k] = mergePatch(base[k], v);
  return out;
}

export const CreateTaskRequest = z.object({
  projectId: z.string(),
  title: z.string().min(1).max(300),
  objective: z.string().default(""),
  acceptanceCriteria: z.array(z.string()).default([]),
  dependencies: z.array(z.string()).default([]),
  priority: Priority.default(2),
  state: z.enum(["backlog", "ready"]).default("backlog"),
  notBefore: z.string().nullable().optional(),
  policy: TaskPolicyPatch.optional(),
});
export const UpdateTaskRequest = z.object({
  title: z.string().min(1).max(300).optional(),
  objective: z.string().optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
  dependencies: z.array(z.string()).optional(),
  priority: Priority.optional(),
  position: z.number().optional(),
  notBefore: z.string().nullable().optional(),
  policy: TaskPolicyPatch.optional(),
});
export const MoveTaskRequest = z.object({
  to: TaskState,
  confirm: z.boolean().optional(),
  onRunning: z.enum(["pause", "stop"]).optional(),
  position: z.number().optional(),
});
/** POST /api/tasks/:id/move (and accept, reopen, cancel) returns the updated task. */
export const MoveTaskResult = Task;
export type MoveTaskResult = Task;
export const RequestChangesRequest = z.object({ feedback: z.array(z.string().min(1)).min(1) });

export const Eligibility = z.union([
  z.object({ eligible: z.literal(true), hostId: z.string(), hostName: z.string() }),
  z.object({
    eligible: z.literal(false),
    wait: z.enum([
      "dependency",
      "host_offline",
      "project_limit",
      "workspace_occupied",
      "scheduled_time",
      "invalid_configuration",
      "dispatch_paused",
      "project_automation_disabled",
      "not_ready",
      "already_dispatched",
      "retry_backoff",
    ]),
    message: z.string(),
  }),
]);
export type Eligibility = z.infer<typeof Eligibility>;

export const NowResponse = z.object({
  running: z.array(
    z.object({ taskId: z.string(), runId: z.string(), sessionId: z.string().nullable() }),
  ),
  queued: z.array(z.object({ taskId: z.string(), eligibility: Eligibility })),
  dispatchPaused: z.boolean(),
});
export type NowResponse = z.infer<typeof NowResponse>;

export const AutomationInput = z.object({
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  projectId: z.string(),
  trigger: Trigger,
  filters: z.array(z.object({ path: z.string(), equals: z.string() })).default([]),
  template: TaskTemplate,
  hostId: z.string().nullable().default(null),
  profileId: z.string().nullable().default(null),
  mode: z.enum(["fresh", "continue", "watch"]).default("fresh"),
  groupingKey: z.string().nullable().default(null),
  overlap: z.enum(["skip", "queue_one", "append"]).default("skip"),
  missed: z.enum(["skip", "run_once"]).default("skip"),
  continuation: ContinuationPolicy.default({ enabled: false }),
  completion: CompletionPolicy.default({ checks: null, requireHumanReview: true }),
});
export type AutomationInput = z.infer<typeof AutomationInput>;

/** GET /api/automations items and the automation routes' responses: the automation plus its trigger summary. */
export const AutomationView = Automation.extend({ summary: z.string() });
export type AutomationView = z.infer<typeof AutomationView>;

export const AutomationPreview = z.object({
  summary: z.string(),
  task: TaskTemplate,
  next: z.array(z.string()),
});
export type AutomationPreview = z.infer<typeof AutomationPreview>;

export const WebhookTokenResponse = z.object({ token: z.string(), url: z.string() });

export const PushSubscriptionRequest = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
  permission: z.enum(["granted", "denied", "default", "unknown"]).default("granted"),
});

export const NotificationSettings = z.object({
  quietHours: z
    .object({
      start: z.string().regex(/^\d{2}:\d{2}$/),
      end: z.string().regex(/^\d{2}:\d{2}$/),
      timezone: z.string(),
    })
    .nullable(),
  privatePreviews: z.boolean(),
  preferredDeviceId: z.string().nullable(),
});
export type NotificationSettings = z.infer<typeof NotificationSettings>;

export const PushPayload = z.union([
  z.object({
    type: z.literal("show"),
    title: z.string(),
    body: z.string(),
    tag: z.string(),
    url: z.string(),
    renotify: z.boolean(),
  }),
  z.object({ type: z.literal("clear"), tag: z.string() }),
]);
export type PushPayload = z.infer<typeof PushPayload>;

/** Owner sign-in (see docs/auth.md). */
export const SetupState = z.object({
  passkey: z.object({
    available: z.boolean(),
    registered: z.boolean(),
    reason: z.string().nullable(),
  }),
  oidc: z.object({ label: z.string() }).nullable(),
});
export type SetupState = z.infer<typeof SetupState>;

export const PasskeyRegisterOptionsResponse = z.object({
  challengeId: z.string(),
  options: z.unknown(),
});
export const PasskeyRegisterVerifyRequest = z.object({
  challengeId: z.string(),
  name: z.string().min(1).max(80),
  response: z.unknown(),
});
export const PasskeySignInOptionsResponse = z.object({
  challengeId: z.string(),
  options: z.unknown(),
});
export const PasskeySignInVerifyRequest = z.object({
  challengeId: z.string(),
  response: z.unknown(),
  deviceName: z.string().min(1).max(80),
  kind: DeviceKind.extract(["browser", "pwa"]),
});

export const OidcBeginRequest = z.object({
  deviceName: z.string().min(1).max(80),
  kind: DeviceKind.extract(["browser", "pwa"]),
  next: z.string().default("/"),
  handoff: z.boolean().default(false),
});
export const OidcBeginResponse = z.object({
  authorizeUrl: z.string(),
  flowId: z.string().nullable(),
  pollToken: z.string().nullable(),
});
export type OidcBeginResponse = z.infer<typeof OidcBeginResponse>;
export const OidcClaimRequest = z.object({ flowId: z.string(), pollToken: z.string() });
export const OidcClaimResponse = z.union([
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("done"), deviceId: z.string() }),
]);
export type OidcClaimResponse = z.infer<typeof OidcClaimResponse>;

export const TerminalLoginStartRequest = z.object({ name: z.string().min(1).max(80) });
export const TerminalLoginStartResponse = z.object({
  userCode: z.string(),
  pollToken: z.string(),
  verifyUrl: z.string(),
  expiresAt: z.string(),
  intervalMs: z.number().int(),
});
export type TerminalLoginStartResponse = z.infer<typeof TerminalLoginStartResponse>;
export const TerminalLoginClaimRequest = z.object({
  userCode: z.string().min(1),
  pollToken: z.string().min(1),
});
export const TerminalLoginClaimResponse = z.union([
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("denied") }),
  z.object({ status: z.literal("done"), deviceId: z.string(), credential: z.string() }),
]);
export type TerminalLoginClaimResponse = z.infer<typeof TerminalLoginClaimResponse>;
export const TerminalLoginRequest = z.object({
  userCode: z.string(),
  name: z.string(),
  requestedFrom: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  status: z.enum(["pending", "approved", "denied"]),
});
export type TerminalLoginRequest = z.infer<typeof TerminalLoginRequest>;

export const AuthMethods = z.object({
  passkeys: z.array(Passkey),
  passkeyAvailability: z.object({ available: z.boolean(), reason: z.string().nullable() }),
  oidc: z
    .object({
      issuer: z.string(),
      label: z.string(),
      ownerMatch: z.string(),
      status: z.enum(["ready", "error"]),
      error: z.string().nullable(),
    })
    .nullable(),
});
export type AuthMethods = z.infer<typeof AuthMethods>;

export const MeResponse = z.object({
  device: Device,
  admin: z.boolean(),
  publicUrl: z.string(),
});
export type MeResponse = z.infer<typeof MeResponse>;

export const ViewInput = View.pick({
  name: true,
  mode: true,
  projectIds: true,
  hostIds: true,
}).partial({
  mode: true,
  projectIds: true,
  hostIds: true,
});
export const ViewPatch = ViewInput.partial();
export const ViewClientReport = ViewClient.omit({ lastSeenAt: true });

export const ProjectSuggestionsResponse = z.object({
  suggestions: z.array(ProjectSuggestion.extend({ name: z.string(), preselected: z.boolean() })),
});
export type ProjectSuggestionsResponse = z.infer<typeof ProjectSuggestionsResponse>;

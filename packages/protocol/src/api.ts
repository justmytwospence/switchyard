import { z } from "zod";
import {
  CompletionPolicy,
  ContinuationPolicy,
  Device,
  ExtraArg,
  Interaction,
  Passkey,
  Priority,
  ProjectScan,
  SessionModel,
  SlashCommand,
  TaskPolicy,
  TaskState,
  TaskTemplate,
  ThinkingLevel,
  Trigger,
  WorktreeDir,
} from "./entities.js";
import { InteractionResponseSchema } from "./ui.js";

/** REST request bodies. Responses return entities from `entities.ts` unless noted. */

export const EnrollRequest = z.object({
  token: z.string().min(1),
  name: z.string().min(1).max(80),
  kind: z.enum(["browser", "pwa", "terminal", "cli"]),
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

export const HostEnrollRequest = z.union([
  z.object({
    token: z.string().min(1),
    name: z.string().min(1).max(80),
    platform: z.enum(["darwin", "linux"]),
  }),
  z.object({
    secret: z.string().min(1),
    name: z.string().min(1).max(80),
    platform: z.enum(["darwin", "linux"]),
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
});

export const PromptRequest = z.object({
  text: z.string().min(1),
  mode: z.enum(["prompt", "steer", "followUp"]).default("prompt"),
  images: z.array(z.object({ mimeType: z.string(), data: z.string() })).default([]),
  clientMessageId: z.string().optional(),
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
export const AnswerResponse = z.object({
  status: z.enum(["answered", "already_answered"]),
  interaction: Interaction,
});

export const AdapterActionRequest = z.object({
  adapterId: z.string(),
  actionId: z.string(),
  payload: z.unknown().optional(),
});

export const CreateTaskRequest = z.object({
  projectId: z.string(),
  title: z.string().min(1).max(300),
  objective: z.string().default(""),
  acceptanceCriteria: z.array(z.string()).default([]),
  dependencies: z.array(z.string()).default([]),
  priority: Priority.default(2),
  state: z.enum(["backlog", "ready"]).default("backlog"),
  notBefore: z.string().nullable().optional(),
  policy: TaskPolicy.partial().optional(),
});
export const UpdateTaskRequest = z.object({
  title: z.string().min(1).max(300).optional(),
  objective: z.string().optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
  dependencies: z.array(z.string()).optional(),
  priority: Priority.optional(),
  position: z.number().optional(),
  notBefore: z.string().nullable().optional(),
  policy: TaskPolicy.partial().optional(),
});
export const MoveTaskRequest = z.object({
  to: TaskState,
  confirm: z.boolean().optional(),
  onRunning: z.enum(["pause", "stop"]).optional(),
  position: z.number().optional(),
});
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

export const AutomationPreview = z.object({
  summary: z.string(),
  task: z.object({
    title: z.string(),
    objective: z.string(),
    acceptanceCriteria: z.array(z.string()),
    priority: Priority,
  }),
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
  initialized: z.boolean(),
  passkey: z.object({
    available: z.boolean(),
    registered: z.boolean(),
    reason: z.string().nullable(),
  }),
  oidc: z.object({ label: z.string() }).nullable(),
});
export type SetupState = z.infer<typeof SetupState>;

export const InitResponse = z.object({
  alreadyInitialized: z.boolean(),
  enrollment: CreateEnrollmentResponse,
});
export type InitResponse = z.infer<typeof InitResponse>;

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
  kind: z.enum(["browser", "pwa"]),
});

export const OidcBeginRequest = z.object({
  deviceName: z.string().min(1).max(80),
  kind: z.enum(["browser", "pwa"]),
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

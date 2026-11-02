import { z } from "zod";

export const ERROR_CODES = [
  "unauthorized",
  "forbidden",
  "not_found",
  "invalid_request",
  "conflict",
  "already_answered",
  "stale_control",
  "host_unreachable",
  "pi_incompatible",
  "native_session_missing",
  "invalid_transition",
  "dependency_cycle",
  "workspace_dirty",
  "workspace_unmerged",
  "workspace_active_sessions",
  "branch_invalid",
  "path_collision",
  "not_a_git_repo",
  "repo_mismatch",
  "enrollment_expired",
  "enrollment_used",
  "device_revoked",
  "unsupported_capability",
  "too_large",
  "ui_tree_too_large",
  "timeout",
  "rate_limited",
  "internal",
] as const;

export const ErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorBody = z.object({
  code: ErrorCode,
  message: z.string(),
  details: z.unknown().optional(),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

export const ApiError = z.object({ error: ErrorBody });
export type ApiError = z.infer<typeof ApiError>;

/** Error carrying a protocol error code, thrown across package boundaries. */
export class SwitchyardError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "SwitchyardError";
    this.code = code;
    this.details = details;
  }
  toBody(): ErrorBody {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}

/** HTTP status for an error code. */
export function httpStatusFor(code: ErrorCode): number {
  switch (code) {
    case "unauthorized":
    case "device_revoked":
      return 401;
    case "forbidden":
      return 403;
    case "not_found":
      return 404;
    case "invalid_request":
    case "branch_invalid":
    case "ui_tree_too_large":
    case "dependency_cycle":
      return 400;
    case "enrollment_expired":
    case "enrollment_used":
      return 410;
    case "rate_limited":
      return 429;
    case "too_large":
      return 413;
    case "host_unreachable":
    case "timeout":
      return 503;
    case "internal":
      return 500;
    default:
      return 409;
  }
}

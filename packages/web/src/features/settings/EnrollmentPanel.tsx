import type { CreateEnrollmentResponse } from "@switchyard/protocol";
import { Clock, RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { InlineError, LoadingState } from "../../components/ui/states";
import { apiPost } from "../../sync/api";
import { formatCountdown, useCountdown } from "./shared";

/** Response of POST /api/enrollments (protocol CreateEnrollmentResponse). */
export type Enrollment = CreateEnrollmentResponse;

export function createEnrollment(kind: "device" | "host"): Promise<Enrollment> {
  return apiPost<Enrollment>("/api/enrollments", { kind });
}

export function isEnrollment(v: unknown): v is Enrollment {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return typeof e.url === "string" && typeof e.expiresAt === "string";
}

/** "Expires in m:ss" or "Expired: create a new link" with a button. */
export function ExpiryCountdown({
  expiresAt,
  onRenew,
  busy,
}: {
  expiresAt: string;
  onRenew: () => void;
  busy?: boolean;
}) {
  const remaining = useCountdown(expiresAt);
  const expired = remaining !== null && remaining <= 0;
  if (expired) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm" role="status">
        <TriangleAlert aria-hidden className="size-4 shrink-0 text-warning" />
        <span className="font-medium">Expired: create a new link</span>
        <Button size="sm" busy={busy} icon={<RefreshCw className="size-4" />} onClick={onRenew}>
          Create new link
        </Button>
      </div>
    );
  }
  return (
    <p className="flex items-center gap-2 text-sm text-muted">
      <Clock aria-hidden className="size-4 shrink-0" />
      <span>
        Expires in{" "}
        <span className="font-mono tabular-nums">
          {remaining === null ? "unknown" : formatCountdown(remaining)}
        </span>
        . Single use.
      </span>
    </p>
  );
}

/** Loading / error wrapper for an enrollment request inside a dialog. */
export function EnrollmentStatus({
  busy,
  error,
  onRetry,
}: {
  busy: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  if (busy) return <LoadingState label="Creating a single-use link…" />;
  if (error)
    return (
      <div className="flex flex-col gap-2">
        <InlineError error={error} />
        <Button icon={<RefreshCw className="size-4" />} onClick={onRetry}>
          Retry
        </Button>
      </div>
    );
  return null;
}

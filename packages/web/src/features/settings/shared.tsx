import type { Host } from "@switchyard/protocol";
import { PI_SUPPORTED_RANGE } from "@switchyard/protocol";
import {
  Bell,
  Check,
  ChevronLeft,
  CircleCheck,
  Copy,
  DatabaseBackup,
  FolderGit2,
  History,
  Keyboard,
  KeyRound,
  type LucideIcon,
  MonitorSmartphone,
  Puzzle,
  Server,
  SlidersHorizontal,
  Stethoscope,
  TriangleAlert,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router";
import { backLinkClick, useBackTo } from "../../app/useBackTo";
import { useBreakpoint } from "../../app/useBreakpoint";
import { TONE_CLASSES, type Tone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Overlay";
import { Spinner } from "../../components/ui/Spinner";
import { toast } from "../../components/ui/Toast";
import { cn } from "../../lib/cn";
import { formatTime } from "../../lib/time";
import { errorMessage } from "../../sync/api";
import { useConnectionState, useStaleSince, useSyncStore } from "../../sync/store";

/* ------------------------------------------------------------------ */
/* Sections                                                            */
/* ------------------------------------------------------------------ */

export interface SectionDef {
  path: string;
  label: string;
  description: string;
  icon: LucideIcon;
}

export const SECTIONS: SectionDef[] = [
  {
    path: "hosts",
    label: "Hosts",
    description: "Execution hosts, capabilities and versions",
    icon: Server,
  },
  {
    path: "devices",
    label: "Devices",
    description: "Signed-in browsers, apps and terminals",
    icon: MonitorSmartphone,
  },
  {
    path: "sign-in",
    label: "Sign-in",
    description: "Passkeys, single sign-on and signing out",
    icon: KeyRound,
  },
  {
    path: "projects",
    label: "Projects",
    description: "Repositories, checkouts and workspaces",
    icon: FolderGit2,
  },
  {
    path: "profiles",
    label: "Pi profiles",
    description: "Provider, model and thinking presets",
    icon: SlidersHorizontal,
  },
  {
    path: "adapters",
    label: "Adapters",
    description: "Extension adapters on each host",
    icon: Puzzle,
  },
  {
    path: "notifications",
    label: "Notifications",
    description: "Push, quiet hours and previews",
    icon: Bell,
  },
  {
    path: "backups",
    label: "Backups",
    description: "Back up and restore the coordinator",
    icon: DatabaseBackup,
  },
  {
    path: "diagnostics",
    label: "Diagnostics",
    description: "Versions, migrations, events and recent problems",
    icon: Stethoscope,
  },
  {
    path: "device",
    label: "This device",
    description: "Preferences stored on this device",
    icon: Keyboard,
  },
];

export const settingsPath = (sub?: string) => (sub ? `/settings/${sub}` : "/settings");

/* ------------------------------------------------------------------ */
/* Page scaffolding                                                    */
/* ------------------------------------------------------------------ */

/**
 * A settings page: heading, optional actions and a Back link. Top-level
 * sections show "Back to Settings" on mobile only (desktop has the section
 * nav); detail pages pass an explicit `back` shown everywhere.
 */
export function SectionPage({
  title,
  description,
  actions,
  back,
  testId,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  back?: { to: string; label: string };
  testId?: string;
  children?: ReactNode;
}) {
  const bp = useBreakpoint();
  const backLink = back ?? (bp === "mobile" ? { to: "/settings", label: "Settings" } : null);
  const goBack = useBackTo(backLink?.to ?? settingsPath());
  return (
    <section data-testid={testId} className="flex w-full min-w-0 flex-col gap-4 px-4 py-4 md:px-6">
      {backLink && (
        <Link
          to={backLink.to}
          onClick={backLinkClick(goBack)}
          className="tap -ml-2 inline-flex w-fit items-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-accent hover:bg-surface-2"
        >
          <ChevronLeft aria-hidden className="size-4" />
          Back to {backLink.label}
        </Link>
      )}
      <header className="flex min-w-0 flex-wrap items-start gap-3">
        <div className="min-w-0 flex-[1_1_15rem]">
          <h1 className="break-words text-lg font-semibold">{title}</h1>
          {description && <p className="text-sm text-muted">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

/** A titled block inside a settings page. */
export function Card({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("min-w-0 rounded-lg border border-border bg-surface p-4", className)}>
      {(title || actions) && (
        <div className="mb-3 flex min-w-0 flex-wrap items-start gap-2">
          <div className="min-w-0 flex-[1_1_12rem]">
            {title && <h2 className="text-base font-semibold">{title}</h2>}
            {description && <p className="text-sm text-muted">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** Key/value list that stacks on narrow screens. */
export function KeyValues({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="grid min-w-0 gap-x-4 gap-y-1 text-sm sm:grid-cols-[minmax(8rem,12rem)_minmax(0,1fr)]">
      {items.map(([k, v], i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static, order-stable list
        <div key={i} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="mb-1 min-w-0 break-words sm:mb-0">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** "Showing last known data" when the live connection is down (spec 18). */
export function LastKnownNote() {
  const connState = useConnectionState();
  const staleSince = useStaleSince();
  if (connState === "live" || connState === "connecting") return null;
  return (
    <p role="status" className="flex items-center gap-1.5 text-sm text-muted">
      <History aria-hidden className="size-4 shrink-0" />
      <span>
        Showing last known data
        {staleSince ? ` from ${formatTime(staleSince)}` : ""}. Changes made elsewhere appear after
        reconnecting.
      </span>
    </p>
  );
}

/** Whether store-backed data is available yet. */
export function useHydrated(): boolean {
  return useSyncStore((s) => s.hydrated);
}

/** Icon plus text status, the tone only reinforces. */
export function InlineStatus({
  icon: Icon,
  label,
  tone = "neutral",
  spin,
  className,
}: {
  icon: LucideIcon;
  label: ReactNode;
  tone?: Tone;
  spin?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-full border px-2 text-xs leading-6 font-medium",
        TONE_CLASSES[tone],
        className,
      )}
    >
      {spin ? <Spinner className="size-3.5" /> : <Icon aria-hidden className="size-3.5 shrink-0" />}
      <span className="min-w-0 truncate">{label}</span>
    </span>
  );
}

export const PLATFORM_LABEL: Record<Host["platform"], string> = {
  darwin: "macOS",
  linux: "Linux",
};

/** Pi version plus compatible/incompatible text. */
export function PiCompat({ host }: { host: Pick<Host, "piVersion" | "piCompatible"> }) {
  if (!host.piVersion) {
    return (
      <InlineStatus icon={TriangleAlert} tone="warning" label="Pi not detected (incompatible)" />
    );
  }
  return host.piCompatible ? (
    <InlineStatus icon={CircleCheck} tone="success" label={`Pi ${host.piVersion} (compatible)`} />
  ) : (
    <InlineStatus
      icon={TriangleAlert}
      tone="danger"
      label={`Pi ${host.piVersion} (incompatible, needs ${PI_SUPPORTED_RANGE})`}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Form controls                                                       */
/* ------------------------------------------------------------------ */

/** Label, control, hint and error. The control must use `id` and `describedBy`. */
export function Field({
  id,
  label,
  hint,
  error,
  children,
  className,
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex w-full min-w-0 max-w-2xl flex-col gap-1", className)}>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="flex items-start gap-1 text-xs text-danger">
          <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 whitespace-pre-line break-words">{error}</span>
        </p>
      )}
    </div>
  );
}

/** aria-describedby / aria-invalid props for a Field control. */
export function describedBy(id: string, opts: { hint?: boolean; error?: string | null }) {
  const ids = [opts.hint && `${id}-hint`, opts.error && `${id}-error`].filter(Boolean);
  return {
    "aria-describedby": ids.length ? ids.join(" ") : undefined,
    "aria-invalid": opts.error ? true : undefined,
  } as const;
}

/** Native select styled like TextInput. */
export function SelectInput({
  className,
  children,
  ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "tap block h-9 w-full min-w-0 rounded-md border border-border bg-surface px-2 text-base text-text md:text-sm",
        "focus:border-accent focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-0",
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
}

/** On/off switch built on a checkbox, with the state written out. */
export function Toggle({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex min-w-0 items-start gap-3">
      <input
        id={id}
        type="checkbox"
        role="switch"
        aria-checked={checked}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        aria-describedby={description ? `${id}-desc` : undefined}
        className="peer sr-only"
      />
      <label
        htmlFor={id}
        className={cn(
          "tap flex min-w-0 flex-1 cursor-pointer items-start gap-3 rounded-md",
          "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--sy-focus)]",
          disabled && "cursor-not-allowed opacity-60",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "relative mt-0.5 inline-flex h-6 w-10 shrink-0 items-center rounded-full border transition-colors",
            checked ? "border-accent bg-accent" : "border-border-strong bg-surface-3",
          )}
        >
          <span
            className={cn(
              "absolute size-4 rounded-full bg-surface shadow transition-transform",
              checked ? "translate-x-5" : "translate-x-1",
            )}
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">
            {label} <span className="font-normal text-muted">({checked ? "On" : "Off"})</span>
          </span>
          {description && (
            <span id={`${id}-desc`} className="block text-sm text-muted">
              {description}
            </span>
          )}
        </span>
      </label>
    </div>
  );
}

/** A labelled checkbox (used for explicit confirmations). */
export function Checkbox({
  label,
  description,
  checked,
  onChange,
}: {
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex min-w-0 items-start gap-2">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        aria-describedby={description ? `${id}-desc` : undefined}
        className="tap mt-0.5 size-5 shrink-0 accent-[var(--sy-accent)]"
      />
      <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer text-sm">
        <span className="block font-medium">{label}</span>
        {description && (
          <span id={`${id}-desc`} className="block text-muted">
            {description}
          </span>
        )}
      </label>
    </div>
  );
}

/** Validate an absolute host path; returns an error message or null. */
export function validateAbsolutePath(path: string): string | null {
  const p = path.trim();
  if (!p) return "Enter the path of the checkout on the host.";
  if (!p.startsWith("/")) return "Use an absolute path that starts with /, e.g. /Users/me/src/app.";
  return null;
}

/** Shape check for GET /api/auth/methods. */
export function isAuthMethods(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const m = v as { passkeys?: unknown; passkeyAvailability?: unknown };
  return Array.isArray(m.passkeys) && typeof m.passkeyAvailability === "object";
}

/** Split a textarea into trimmed non-empty lines. */
export function splitLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Inline error message for a failed mutation. */
export function InlineError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-md border border-border bg-danger-soft px-3 py-2 text-sm"
    >
      <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
      <span className="min-w-0 break-words">{errorMessage(error)}</span>
    </p>
  );
}

/* ------------------------------------------------------------------ */
/* Copy                                                                */
/* ------------------------------------------------------------------ */

export async function copyText(text: string, what = "Copied to clipboard"): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(what);
    return true;
  } catch {
    toast.error("Could not copy. Select the text and copy it manually.");
    return false;
  }
}

export function CopyButton({
  text,
  label = "Copy",
  toastMessage,
  size = "sm",
}: {
  text: string;
  label?: string;
  toastMessage?: string;
  size?: "sm" | "md";
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return (
    <Button
      size={size}
      icon={copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      onClick={async () => {
        if (await copyText(text, toastMessage)) {
          setCopied(true);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 2000);
        }
      }}
    >
      {copied ? "Copied" : label}
    </Button>
  );
}

/** A monospace command or URL with a copy button; wraps instead of overflowing. */
export function CopyBlock({
  text,
  label,
  copyLabel = "Copy",
}: {
  text: string;
  /** Accessible name of the code block. */
  label: string;
  copyLabel?: string;
}) {
  return (
    <figure className="m-0 flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start">
      <figcaption className="sr-only">{label}</figcaption>
      <pre className="min-w-0 flex-1 whitespace-pre-wrap break-all rounded-md border border-border bg-surface-2 px-3 py-2 font-mono text-sm">
        {text}
      </pre>
      <CopyButton text={text} label={copyLabel} />
    </figure>
  );
}

/* ------------------------------------------------------------------ */
/* Expiry countdown                                                    */
/* ------------------------------------------------------------------ */

/** Milliseconds until `iso`, ticking every second; null without a time. */
export function useCountdown(iso: string | null | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!iso) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [iso]);
  if (!iso) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

export function formatCountdown(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ */
/* Confirmation                                                        */
/* ------------------------------------------------------------------ */

/**
 * Confirmation dialog for destructive actions. Never closes on its own:
 * the caller closes it after the server acknowledges (no optimistic success).
 */
export function ConfirmDialog({
  open,
  onClose,
  title,
  description,
  confirmLabel,
  onConfirm,
  busy,
  error,
  danger = true,
  confirmDisabled,
  disabledReason,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  busy?: boolean;
  error?: unknown;
  danger?: boolean;
  confirmDisabled?: boolean;
  /** Shown next to the actions when the confirm button is disabled. */
  disabledReason?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onClose={busy ? () => undefined : onClose}
      dismissOnBackdrop={!busy}
      title={title}
      description={description}
      footer={
        <>
          {confirmDisabled && disabledReason && (
            <p className="mr-auto min-w-0 flex-1 basis-full text-xs text-muted sm:basis-auto">
              {disabledReason}
            </p>
          )}
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={danger ? "danger" : "primary"}
            busy={busy}
            disabled={confirmDisabled}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {children}
        <InlineError error={error} />
      </div>
    </Dialog>
  );
}

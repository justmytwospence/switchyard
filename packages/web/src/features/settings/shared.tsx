import type { Host } from "@switchyard/protocol";
import { PI_SUPPORTED_RANGE } from "@switchyard/protocol";
import {
  Bell,
  ChevronLeft,
  CircleCheck,
  DatabaseBackup,
  FolderGit2,
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
import { type ReactNode, useEffect, useState } from "react";
import { Link } from "react-router";
import { backLinkClick, useBackTo } from "../../app/useBackTo";
import { useBreakpoint } from "../../app/useBreakpoint";
import { InlineStatus } from "../../components/ui/StatusChip";
import { useSyncStore } from "../../sync/store";

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

/** Whether store-backed data is available yet. */
export function useHydrated(): boolean {
  return useSyncStore((s) => s.hydrated);
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

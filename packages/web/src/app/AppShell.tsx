import {
  Bell,
  Code,
  Ellipsis,
  type LucideIcon,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  SquareKanban,
  Timer,
  Workflow,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { Link, Outlet, useLocation } from "react-router";
import { CountBadge } from "../components/ui/Badge";
import { Spinner } from "../components/ui/Spinner";
import { statusInfo } from "../components/ui/StatusChip";
import { ReconnectingBanner } from "../components/ui/states";
import { Toaster } from "../components/ui/Toast";
import { cn } from "../lib/cn";
import { usePrefs } from "../prefs";
import { syncClient } from "../sync/client";
import { useAttentionCount, useConnection } from "../sync/store";
import { useChrome } from "./chrome";
import { useBreakpoint } from "./useBreakpoint";
import { useComposingWithKeyboard } from "./useComposing";

interface Destination {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Path prefixes that make this destination active. */
  match: string[];
  badge?: "attention";
}

const CODE: Destination = { to: "/code", label: "Code", icon: Code, match: ["/code"] };
const BOARD: Destination = {
  to: "/board",
  label: "Board",
  icon: SquareKanban,
  match: ["/board", "/tasks"],
};
const ATTENTION: Destination = {
  to: "/attention",
  label: "Attention",
  icon: Bell,
  match: ["/attention"],
  badge: "attention",
};
const NOW: Destination = { to: "/now", label: "Now", icon: Timer, match: ["/now"] };
const AUTOMATIONS: Destination = {
  to: "/automations",
  label: "Automations",
  icon: Workflow,
  match: ["/automations"],
};
const SETTINGS: Destination = {
  to: "/settings",
  label: "Settings",
  icon: Settings,
  match: ["/settings"],
};
const MORE: Destination = {
  to: "/more",
  label: "More",
  icon: Ellipsis,
  match: ["/more", "/now", "/automations", "/settings"],
};

/** Desktop and compact rail destinations (spec 10). */
export const RAIL_DESTINATIONS = [CODE, BOARD, ATTENTION, NOW, AUTOMATIONS, SETTINGS];
/** Mobile bottom navigation; More holds Now, Automations and Settings. */
export const BOTTOM_DESTINATIONS = [CODE, BOARD, ATTENTION, MORE];

function isActive(d: Destination, pathname: string): boolean {
  return d.match.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * App frame: a 64 px global rail (labels on expansion to 200 px, as an
 * overlay so pane widths stay stable) at >= 768 px; a bottom nav below 768 px
 * that hides while composing with the on-screen keyboard.
 */
export function AppShell() {
  const bp = useBreakpoint();
  const connection = useConnection();
  const mobile = bp === "mobile";
  return (
    <div
      className={cn(
        "flex h-dvh min-h-0 w-full min-w-0 overflow-hidden",
        mobile ? "flex-col" : "flex-row",
      )}
    >
      <a
        href="#main"
        className="sr-only z-[70] rounded bg-surface px-3 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      {!mobile && <Rail />}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ReconnectingBanner
          state={connection.state}
          lastSyncedAt={connection.lastSyncedAt}
          onRetry={() => syncClient.reconnectNow()}
          className={mobile ? "safe-pt" : undefined}
        />
        <main
          id="main"
          tabIndex={-1}
          className="relative min-h-0 min-w-0 flex-1 overflow-y-auto outline-none"
        >
          <Outlet />
        </main>
        {mobile && <BottomNav />}
      </div>
      <Toaster />
    </div>
  );
}

function Rail() {
  const expanded = usePrefs((s) => s.railExpanded);
  const setPref = usePrefs((s) => s.set);
  const { pathname } = useLocation();
  const count = useAttentionCount();
  const connection = useConnection();
  const navRef = useRef<HTMLElement>(null);
  const conn = statusInfo({ kind: "connection", value: connection.state });
  const ConnIcon = conn.icon;

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPref("railExpanded", false);
    };
    const onDown = (e: PointerEvent) => {
      if (!navRef.current?.contains(e.target as Node)) setPref("railExpanded", false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [expanded, setPref]);

  return (
    <div className="relative z-30 w-16 shrink-0" style={{ width: "var(--rail-width)" }}>
      <nav
        ref={navRef}
        aria-label="Primary"
        className={cn(
          "absolute inset-y-0 left-0 flex flex-col border-r border-border bg-surface safe-pt safe-pb",
          expanded ? "shadow-pop" : "",
        )}
        style={{ width: expanded ? "var(--rail-expanded-width)" : "var(--rail-width)" }}
      >
        <div className="flex h-14 items-center gap-2 px-3.5" aria-hidden={!expanded}>
          <img src="/icon.svg" alt="" className="size-9 shrink-0 rounded-lg" />
          {expanded && <span className="truncate font-semibold">Switchyard</span>}
        </div>
        <ul className="flex flex-1 flex-col gap-1 px-2 py-2">
          {RAIL_DESTINATIONS.map((d) => {
            const active = isActive(d, pathname);
            const Icon = d.icon;
            return (
              <li key={d.to}>
                <Link
                  to={d.to}
                  title={expanded ? undefined : d.label}
                  aria-current={active ? "page" : undefined}
                  onClick={() => expanded && setPref("railExpanded", false)}
                  className={cn(
                    "tap relative flex h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium",
                    active
                      ? "bg-accent-soft text-text"
                      : "text-muted hover:bg-surface-2 hover:text-text",
                  )}
                >
                  <Icon aria-hidden className="size-5 shrink-0" />
                  <span className={expanded ? "min-w-0 flex-1 truncate" : "sr-only"}>
                    {d.label}
                  </span>
                  {d.badge === "attention" && (
                    <CountBadge
                      count={count}
                      label="need attention"
                      className={expanded ? "" : "absolute -top-0.5 right-0"}
                    />
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
        <div className="flex flex-col gap-1 border-t border-border px-2 py-2">
          <div
            className="flex h-9 items-center gap-3 px-3 text-xs text-muted"
            title={`Connection: ${conn.label}`}
          >
            {conn.spin ? (
              <Spinner
                className={cn(
                  "size-4",
                  conn.tone === "warning" && "text-warning",
                  conn.tone === "info" && "text-info",
                )}
              />
            ) : (
              <ConnIcon
                aria-hidden
                className={cn(
                  "size-4 shrink-0",
                  conn.tone === "success" && "text-success",
                  conn.tone === "warning" && "text-warning",
                  conn.tone === "danger" && "text-danger",
                )}
              />
            )}
            <span className={expanded ? "truncate" : "sr-only"}>{conn.label}</span>
          </div>
          <button
            type="button"
            className="tap flex h-11 items-center gap-3 rounded-lg px-3 text-sm text-muted hover:bg-surface-2 hover:text-text"
            aria-expanded={expanded}
            aria-label={expanded ? "Collapse navigation labels" : "Expand navigation labels"}
            title={expanded ? "Collapse" : "Expand"}
            onClick={() => setPref("railExpanded", !expanded)}
          >
            {expanded ? (
              <PanelLeftClose aria-hidden className="size-5 shrink-0" />
            ) : (
              <PanelLeftOpen aria-hidden className="size-5 shrink-0" />
            )}
            {expanded && <span>Collapse</span>}
          </button>
        </div>
      </nav>
    </div>
  );
}

function BottomNav() {
  const { pathname } = useLocation();
  const count = useAttentionCount();
  const composing = useComposingWithKeyboard();
  const hiddenByView = useChrome((s) => s.hideBottomNav > 0);
  const hidden = composing || hiddenByView;
  useEffect(() => {
    document.documentElement.style.setProperty(
      "--toast-offset",
      hidden ? "16px" : "calc(var(--bottom-nav-height) + 12px)",
    );
  }, [hidden]);
  if (hidden) return null;
  return (
    <nav
      aria-label="Primary"
      className="shrink-0 border-t border-border bg-surface safe-pb safe-px"
    >
      <ul className="grid grid-cols-4">
        {BOTTOM_DESTINATIONS.map((d) => {
          const active = isActive(d, pathname);
          const Icon = d.icon;
          return (
            <li key={d.to} className="min-w-0">
              <Link
                to={d.to}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-14 min-w-0 flex-col items-center justify-center gap-0.5 text-xs font-medium",
                  active ? "text-accent" : "text-muted",
                )}
              >
                <span className="relative">
                  <Icon aria-hidden className="size-5" />
                  {d.badge === "attention" && (
                    <CountBadge
                      count={count}
                      label="need attention"
                      className="absolute -top-1.5 left-3"
                    />
                  )}
                </span>
                <span className="max-w-full truncate px-1">{d.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

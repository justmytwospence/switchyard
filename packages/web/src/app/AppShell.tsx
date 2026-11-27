import { Ellipsis, Keyboard, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { Link, Outlet, useLocation } from "react-router";
import { CountBadge } from "../components/ui/Badge";
import { Spinner } from "../components/ui/Spinner";
import { statusInfo } from "../components/ui/StatusChip";
import { ReconnectingBanner } from "../components/ui/states";
import { Toaster } from "../components/ui/Toast";
import { CommandPalette } from "../features/palette/CommandPalette";
import { KeyboardHelp } from "../features/palette/KeyboardHelp";
import { usePalette } from "../features/palette/registry";
import { useGlobalShortcuts } from "../features/palette/useGlobalShortcuts";
import { cn } from "../lib/cn";
import { usePrefs } from "../prefs";
import { isIos, isStandalone } from "../push";
import { syncClient } from "../sync/client";
import { useAttentionCount, useConnectionState, useStaleSince } from "../sync/store";
import { useChrome } from "./chrome";
import { isActive, useNavLayout } from "./navigation";
import { useBreakpoint } from "./useBreakpoint";
import { useComposingWithKeyboard } from "./useComposing";
import { useEdgeSwipeBack } from "./useEdgeSwipeBack";

const MORE = { to: "/more", label: "More", icon: Ellipsis };

/** Re-tapping the current tab scrolls its list to the top. */
function scrollToTop(): void {
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const behavior = reduced ? "auto" : "smooth";
  document.getElementById("main")?.scrollTo({ top: 0, behavior });
  for (const el of document.querySelectorAll<HTMLElement>("[data-scroll-root]")) {
    el.scrollTo({ top: 0, behavior });
  }
}

/**
 * App frame: a 64 px global rail that pushes the content aside when expanded to 200 px at
 * >= 768 px; a bottom nav below 768 px that hides while composing with the on-screen keyboard.
 */
export function AppShell() {
  const bp = useBreakpoint();
  const connState = useConnectionState();
  const staleSince = useStaleSince();
  const mobile = bp === "mobile";
  useGlobalShortcuts();
  useEdgeSwipeBack(mobile && isIos() && isStandalone());
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
          state={connState}
          lastSyncedAt={staleSince}
          onRetry={() => syncClient.reconnectNow()}
        />
        <main
          id="main"
          tabIndex={-1}
          className="relative min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain outline-none"
        >
          <ScrollReset />
          <Outlet />
        </main>
        {mobile && <BottomNav />}
      </div>
      <CommandPalette />
      <KeyboardHelp />
      <Toaster />
    </div>
  );
}

const BOARD_FAMILY = /^\/(board|tasks)(\/|$)/;

/**
 * Resets the shared scroller on a new page (not on ?query changes). Rendered before <Outlet/>
 * so it runs before views that restore their own position; the board manages its own.
 */
function ScrollReset() {
  const { pathname } = useLocation();
  const prev = useRef(pathname);
  useLayoutEffect(() => {
    const from = prev.current;
    prev.current = pathname;
    if (from === pathname) return;
    if (BOARD_FAMILY.test(from) && BOARD_FAMILY.test(pathname)) return;
    const el = document.getElementById("main");
    if (el) el.scrollTop = 0;
  }, [pathname]);
  return null;
}

function Rail() {
  const expanded = usePrefs((s) => s.railExpanded);
  const setPref = usePrefs((s) => s.set);
  const { pathname } = useLocation();
  const count = useAttentionCount();
  const nav = useNavLayout();
  const connState = useConnectionState();
  const conn = statusInfo({ kind: "connection", value: connState });
  const ConnIcon = conn.icon;

  return (
    <div
      className="sy-motion relative z-30 shrink-0 transition-[width] duration-200 ease-out"
      style={{ width: expanded ? "var(--rail-expanded-width)" : "var(--rail-width)" }}
    >
      <nav
        aria-label="Primary"
        data-keyboard-scope
        tabIndex={-1}
        className="flex h-full w-full flex-col overflow-hidden border-r border-border bg-surface safe-pt safe-pb"
      >
        <div className="flex h-14 items-center gap-2 px-3.5" aria-hidden={!expanded}>
          <img src="/icon.svg" alt="" className="size-9 shrink-0 rounded-lg" />
          <span
            className={cn(
              "sy-motion min-w-0 truncate font-semibold transition-opacity duration-200",
              expanded ? "opacity-100" : "opacity-0",
            )}
          >
            Switchyard
          </span>
        </div>
        <ul className="flex flex-1 flex-col gap-1 px-2 py-2">
          {nav.all.map((d) => {
            const active = isActive(d, pathname);
            const Icon = d.icon;
            return (
              <li key={d.to}>
                <Link
                  to={d.to}
                  data-keyboard-item
                  title={expanded ? undefined : d.label}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "tap relative flex h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium",
                    active
                      ? "bg-accent-soft text-text"
                      : "text-muted hover:bg-surface-2 hover:text-text",
                  )}
                >
                  <Icon aria-hidden className="size-5 shrink-0" />
                  <span
                    className={cn(
                      "sy-motion min-w-0 flex-1 truncate transition-opacity duration-200",
                      expanded ? "opacity-100" : "opacity-0",
                    )}
                  >
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
          <button
            type="button"
            aria-label="Keyboard shortcuts"
            title="Keyboard shortcuts (?)"
            onClick={() => usePalette.getState().setHelpOpen(true)}
            className="tap flex h-11 items-center gap-3 rounded-lg px-3 text-sm text-muted hover:bg-surface-2 hover:text-text"
          >
            <Keyboard aria-hidden className="size-5 shrink-0" />
            <span className={cn("min-w-0 flex-1 truncate", !expanded && "sr-only")}>
              Keyboard shortcuts (?)
            </span>
          </button>
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
            <span
              className={cn(
                "sy-motion min-w-0 truncate transition-opacity duration-200",
                expanded ? "opacity-100" : "opacity-0",
              )}
            >
              {conn.label}
            </span>
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
            <span
              className={cn(
                "sy-motion min-w-0 truncate transition-opacity duration-200",
                expanded ? "opacity-100" : "opacity-0",
              )}
            >
              Collapse
            </span>
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
  const nav = useNavLayout();
  const hidden = composing || hiddenByView;
  if (hidden) return null;
  return (
    <nav
      aria-label="Primary"
      className="shrink-0 border-t border-border bg-surface safe-pb safe-px"
    >
      <ul
        className="grid"
        style={{ gridTemplateColumns: `repeat(${nav.bar.length + 1}, minmax(0, 1fr))` }}
      >
        {[
          ...nav.bar,
          {
            ...MORE,
            id: "more",
            // Attention moved under More still shows its count here.
            badge: nav.more.some((m) => m.badge === "attention")
              ? ("attention" as const)
              : undefined,
            match: ["/more", ...nav.more.flatMap((m) => m.match)],
          },
        ].map((d) => {
          const active = isActive(d, pathname);
          const Icon = d.icon;
          return (
            <li key={d.to} className="min-w-0">
              <Link
                to={d.to}
                aria-current={active ? "page" : undefined}
                onClick={(e) => {
                  if (pathname === d.to) {
                    e.preventDefault();
                    scrollToTop();
                  }
                }}
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

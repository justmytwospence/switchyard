import { useEffect } from "react";
import { Navigate, useLocation, useParams, useSearchParams } from "react-router";
import { useBreakpoint } from "../../app/useBreakpoint";
import { usePrefs } from "../../prefs";
import { useViewingSession } from "../../presence";
import { useSession, useSyncStore } from "../../sync/store";
import { CodeDesktop, CodeMobile } from "./CodeLayouts";
import type { InspectorTab } from "./context";
import { useSessionLookup } from "./hooks";

const INSPECTOR_TABS: readonly string[] = ["changes", "files", "task", "extensions", "pr"];

/**
 * Code view: `/code` and `/code/:sessionId` (`?interaction=<id>` scrolls to and
 * highlights that question). Desktop >= 1200 has three panes; compact
 * 768-1199 has navigator + conversation with the inspector in a drawer; mobile
 * shows one surface at a time.
 */
export default function CodeView() {
  const { sessionId: rawId } = useParams();
  const sessionId = rawId ?? null;
  const [params] = useSearchParams();
  const focusInteractionId = params.get("interaction");
  const tabParam = params.get("tab");
  const requestedTab =
    tabParam && INSPECTOR_TABS.includes(tabParam) ? (tabParam as InspectorTab) : null;
  // Each navigation (e.g. "Review changes" again) re-applies the requested tab.
  const { key: requestKey } = useLocation();
  const bp = useBreakpoint();
  const hydrated = useSyncStore((s) => s.hydrated);
  const session = useSession(sessionId);
  const lookup = useSessionLookup(sessionId, session, hydrated);
  const lastSessionId = usePrefs((s) => s.lastSessionId);
  const lastSession = useSession(lastSessionId);
  const setPref = usePrefs((s) => s.set);

  useViewingSession(session ? session.id : null);

  useEffect(() => {
    if (!session) return;
    if (session.id !== usePrefs.getState().lastSessionId) setPref("lastSessionId", session.id);
  }, [session, setPref]);

  // Desktop and compact reopen the last session; mobile keeps the list at /code.
  if (!sessionId && bp !== "mobile" && hydrated && lastSession && lastSession.archivedAt === null) {
    return <Navigate to={`/code/${encodeURIComponent(lastSession.id)}`} replace />;
  }

  const props = {
    session,
    sessionId,
    hydrated: hydrated && lookup.state !== "loading",
    loadError: lookup.state === "error" ? lookup.error : null,
    focusInteractionId,
    tabRequest: requestedTab ? { tab: requestedTab, key: requestKey } : null,
  };
  return bp === "mobile" ? (
    <CodeMobile {...props} />
  ) : (
    <CodeDesktop {...props} compact={bp === "compact"} />
  );
}

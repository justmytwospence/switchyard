import { useEffect } from "react";
import { Navigate, useParams, useSearchParams } from "react-router";
import { useBreakpoint } from "../../app/useBreakpoint";
import { usePrefs } from "../../prefs";
import { useViewingSession } from "../../presence";
import { useSession, useSyncStore } from "../../sync/store";
import { CodeDesktop, CodeMobile } from "./CodeLayouts";

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
  const bp = useBreakpoint();
  const hydrated = useSyncStore((s) => s.hydrated);
  const session = useSession(sessionId);
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

  const props = { session, sessionId, hydrated, focusInteractionId };
  return bp === "mobile" ? (
    <CodeMobile {...props} />
  ) : (
    <CodeDesktop {...props} compact={bp === "compact"} />
  );
}

import type { Session } from "@switchyard/protocol";
import { useMemo } from "react";
import { useSyncStore } from "../../sync/store";
import { type SessionPlace, sessionPlace } from "./model";
import { useSelectedView } from "./views";

/** A session's issue and its place in the selected view. */
export function useSessionPlace(session: Session): SessionPlace {
  const sessions = useSyncStore((s) => s.sessions);
  const workspaces = useSyncStore((s) => s.workspaces);
  const issues = useSyncStore((s) => s.issues);
  const views = useSyncStore((s) => s.views);
  const [selected] = useSelectedView();
  const view = (selected ? views[selected] : null) ?? null;
  return useMemo(
    () => sessionPlace({ session, sessions, workspaces, issues: Object.values(issues), view }),
    [session, sessions, workspaces, issues, view],
  );
}

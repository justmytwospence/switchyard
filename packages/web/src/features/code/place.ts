import type { Session } from "@switchyard/protocol";
import { useMemo } from "react";
import { useSyncStore } from "../../sync/store";
import { type SessionPlace, sessionPlace } from "./model";
import { useSelectedScope } from "./scopes";

/** A session's issue and its place in the selected scope. */
export function useSessionPlace(session: Session): SessionPlace {
  const sessions = useSyncStore((s) => s.sessions);
  const workspaces = useSyncStore((s) => s.workspaces);
  const issues = useSyncStore((s) => s.issues);
  const scopes = useSyncStore((s) => s.scopes);
  const [selected] = useSelectedScope();
  const scope = (selected ? scopes[selected] : null) ?? null;
  return useMemo(
    () => sessionPlace({ session, sessions, workspaces, issues: Object.values(issues), scope }),
    [session, sessions, workspaces, issues, scope],
  );
}

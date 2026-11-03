import { Navigate, Outlet, useLocation } from "react-router";
import { ErrorState, LoadingState } from "../components/ui/states";
import { useSyncStore } from "../sync/store";
import { checkAuth, saveReturnTo, useAuth } from "./auth";

/**
 * Requires a signed-in device. Unauthenticated visits go to /sign-in with the
 * intended URL saved, so deep links survive authentication.
 */
export function AuthGate() {
  const status = useAuth((s) => s.status);
  const error = useAuth((s) => s.error);
  const hydrated = useSyncStore((s) => s.hydrated);
  const location = useLocation();

  if (status === "unauthenticated") {
    const target = location.pathname + location.search + location.hash;
    saveReturnTo(target);
    return <Navigate to={`/sign-in?next=${encodeURIComponent(target)}`} replace />;
  }
  if (status === "error") {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <ErrorState
          title="Cannot reach Switchyard"
          error={error}
          onRetry={() => void checkAuth()}
        />
      </div>
    );
  }
  if (status === "checking" && !hydrated) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <LoadingState label="Connecting to Switchyard…" />
      </div>
    );
  }
  return <Outlet />;
}

import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { ErrorBoundary } from "../components/ui/ErrorBoundary";
import { EmptyState, LoadingState } from "../components/ui/states";
import { AppShell } from "./AppShell";
import { AuthGate } from "./AuthGate";

const CodeView = lazy(() => import("../features/code"));
const BoardView = lazy(() => import("../features/board"));
const AttentionView = lazy(() => import("../features/attention"));
const NowView = lazy(() => import("../features/now"));
const AutomationsView = lazy(() => import("../features/automations"));
const AutomationView = lazy(() => import("../features/automations/AutomationView"));
const SettingsView = lazy(() => import("../features/settings"));
const MoreView = lazy(() => import("../features/more"));
const EnrollView = lazy(() => import("../features/enroll"));
const TerminalLoginView = lazy(() => import("../features/terminal-login"));

/** Route paths (spec 10 canonical routes plus /sign-in, /settings/*, /more). */
export const ROUTES = {
  code: "/code",
  session: (id: string) => `/code/${encodeURIComponent(id)}`,
  interaction: (sessionId: string, interactionId: string) =>
    `/code/${encodeURIComponent(sessionId)}?interaction=${encodeURIComponent(interactionId)}`,
  board: "/board",
  task: (id: string) => `/tasks/${encodeURIComponent(id)}`,
  attention: "/attention",
  now: "/now",
  automations: "/automations",
  automation: (id: string) => `/automations/${encodeURIComponent(id)}`,
  settings: (section?: string) => (section ? `/settings/${section}` : "/settings"),
  more: "/more",
  signIn: "/sign-in",
  terminalLogin: "/terminal-login",
} as const;

/** Top-level path segments that share one view (and one error boundary) with another. */
const SECTION_ALIASES: Record<string, string> = { tasks: "board" };

function Page({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();
  const segment = pathname.split("/")[1] ?? "";
  return (
    <ErrorBoundary key={SECTION_ALIASES[segment] ?? segment}>
      <Suspense fallback={<LoadingState />}>{children}</Suspense>
    </ErrorBoundary>
  );
}

/** Old pairing links pointed at /enroll. */
function LegacyEnrollRedirect() {
  const l = useLocation();
  return <Navigate to={{ pathname: "/sign-in", search: l.search, hash: l.hash }} replace />;
}

function NotFound() {
  return (
    <EmptyState
      title="Page not found"
      description="This link does not match any Switchyard view."
      action={{ label: "Go to Code", to: "/code" }}
    />
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route
        path="/sign-in"
        element={
          <Suspense fallback={<LoadingState />}>
            <EnrollView />
          </Suspense>
        }
      />
      <Route path="/enroll" element={<LegacyEnrollRedirect />} />
      <Route element={<AuthGate />}>
        <Route
          path="terminal-login"
          element={
            <Suspense fallback={<LoadingState />}>
              <TerminalLoginView />
            </Suspense>
          }
        />
        <Route element={<AppShell />}>
          <Route index element={<Navigate to="/code" replace />} />
          <Route
            path="code"
            element={
              <Page>
                <CodeView />
              </Page>
            }
          />
          <Route
            path="code/:sessionId"
            element={
              <Page>
                <CodeView />
              </Page>
            }
          />
          {/* One layout for /board and /tasks/:taskId so the board stays mounted under the drawer. */}
          <Route
            element={
              <Page>
                <BoardView />
              </Page>
            }
          >
            <Route path="board" element={null} />
            <Route path="tasks/:taskId" element={null} />
          </Route>
          <Route
            path="attention"
            element={
              <Page>
                <AttentionView />
              </Page>
            }
          />
          <Route
            path="now"
            element={
              <Page>
                <NowView />
              </Page>
            }
          />
          <Route
            path="automations"
            element={
              <Page>
                <AutomationsView />
              </Page>
            }
          />
          <Route
            path="automations/:automationId"
            element={
              <Page>
                <AutomationView />
              </Page>
            }
          />
          <Route
            path="settings/*"
            element={
              <Page>
                <SettingsView />
              </Page>
            }
          />
          <Route
            path="more"
            element={
              <Page>
                <MoreView />
              </Page>
            }
          />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Route>
    </Routes>
  );
}

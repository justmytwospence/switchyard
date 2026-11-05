import type { Session } from "@switchyard/protocol";
import { MousePointerClick, SearchX } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { BACK_STATE } from "../../app/useBackTo";
import { Drawer } from "../../components/ui/Overlay";
import { Splitter } from "../../components/ui/Splitter";
import { EmptyState, LoadingState } from "../../components/ui/states";
import { PANE_LIMITS, usePrefs } from "../../prefs";
import { CodeContext, type CodeViewContext, type InspectorTab } from "./context";
import { type SessionContext, useElementWidth, useSessionContext } from "./hooks";
import { Inspector } from "./Inspector";
import { COMPACT_NAVIGATOR_MAX, CONVERSATION_MIN, fitPanes } from "./model";
import { Navigator } from "./Navigator";
import { NewSessionFlow } from "./NewSession";
import { useSessionActions } from "./SessionActions";
import { Conversation, MobileSession } from "./SessionView";

function NoSession({ missing }: { missing: boolean }) {
  return missing ? (
    <EmptyState
      icon={<SearchX className="size-8" />}
      title="Session not found"
      description="It may have been archived, or this link points to another coordinator."
      action={{ label: "Back to sessions", to: "/code" }}
    />
  ) : (
    <EmptyState
      icon={<MousePointerClick className="size-8" />}
      title="Select a session"
      description="Pick a session in the navigator, or start a new one."
    />
  );
}

/** `?tab=` in the URL: the inspector tab to open, keyed by navigation. */
export interface TabRequest {
  tab: InspectorTab;
  key: string;
}

interface LayoutProps {
  session: Session | undefined;
  sessionId: string | null;
  hydrated: boolean;
  focusInteractionId: string | null;
  tabRequest: TabRequest | null;
}

/** Desktop (three panes) and compact (navigator + conversation, inspector drawer). */
export function CodeDesktop({ compact, ...props }: LayoutProps & { compact: boolean }) {
  const navigate = useNavigate();
  const paneSizes = usePrefs((s) => s.paneSizes);
  const setPaneSize = usePrefs((s) => s.setPaneSize);
  const collapsed = usePrefs((s) => s.inspectorCollapsed);
  const setPref = usePrefs((s) => s.set);
  const [newOpen, setNewOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const ctx = useSessionContext(props.session);

  const showInspector = !compact && !collapsed && !!ctx;
  const navMax = compact ? COMPACT_NAVIGATOR_MAX : PANE_LIMITS.navigator.max;
  const fit = fitPanes(
    width,
    Math.min(paneSizes.navigator, navMax),
    showInspector ? paneSizes.inspector : null,
  );

  const onCreated = useCallback(
    (id: string) => {
      setNewOpen(false);
      navigate(`/code/${encodeURIComponent(id)}`);
    },
    [navigate],
  );

  return (
    <div ref={ref} className="absolute inset-0 flex min-w-0 overflow-hidden">
      <Navigator
        variant="pane"
        selectedId={props.sessionId}
        onNewSession={() => setNewOpen(true)}
        className="shrink-0 border-r border-border"
        style={{ width: fit.nav }}
      />
      <Splitter
        label="Resize navigator"
        value={fit.nav}
        min={PANE_LIMITS.navigator.min}
        max={navMax}
        onChange={(px) => setPaneSize("navigator", px)}
        onReset={() => setPaneSize("navigator", PANE_LIMITS.navigator.default)}
        className="-ml-1.5"
      />
      <div className="relative min-h-0 min-w-0 flex-1" style={{ minWidth: CONVERSATION_MIN }}>
        {!props.hydrated && props.sessionId ? (
          <LoadingState label="Loading session…" />
        ) : ctx ? (
          <SessionPanes
            key={ctx.session.id}
            ctx={ctx}
            compact={compact}
            showInspector={showInspector}
            inspectorWidth={fit.insp}
            setInspectorWidth={(px) => setPaneSize("inspector", px)}
            collapsed={collapsed}
            setCollapsed={(c) => setPref("inspectorCollapsed", c)}
            drawerOpen={drawerOpen}
            setDrawerOpen={setDrawerOpen}
            focusInteractionId={props.focusInteractionId}
            tabRequest={props.tabRequest}
          />
        ) : (
          <NoSession missing={!!props.sessionId} />
        )}
      </div>
      <NewSessionFlow
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCreated={onCreated}
        mobile={false}
      />
    </div>
  );
}

function SessionPanes({
  ctx,
  compact,
  showInspector,
  inspectorWidth,
  setInspectorWidth,
  collapsed,
  setCollapsed,
  drawerOpen,
  setDrawerOpen,
  focusInteractionId,
  tabRequest,
}: {
  ctx: SessionContext;
  compact: boolean;
  showInspector: boolean;
  inspectorWidth: number | null;
  setInspectorWidth: (px: number) => void;
  collapsed: boolean;
  setCollapsed: (c: boolean) => void;
  drawerOpen: boolean;
  setDrawerOpen: (o: boolean) => void;
  focusInteractionId: string | null;
  tabRequest: TabRequest | null;
}) {
  const actions = useSessionActions(ctx);
  const [tab, setTab] = useState<InspectorTab>(tabRequest?.tab ?? "changes");
  const [openPath, setOpenPath] = useState<{ path: string; nonce: number } | null>(null);

  const openInspector = useCallback(
    (t: InspectorTab) => {
      setTab(t);
      if (compact) setDrawerOpen(true);
      else setCollapsed(false);
    },
    [compact, setDrawerOpen, setCollapsed],
  );
  const codeCtx = useMemo<CodeViewContext>(
    () => ({
      mobile: false,
      openInspector,
      openFile: (path) => {
        setOpenPath({ path, nonce: Date.now() });
        openInspector("files");
      },
    }),
    [openInspector],
  );

  // `?tab=changes` (Board "Review changes", attention links) opens that inspector tab.
  const tabKey = tabRequest ? `${tabRequest.tab}:${tabRequest.key}` : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: apply once per navigation
  useEffect(() => {
    if (tabRequest) openInspector(tabRequest.tab);
  }, [tabKey]);

  // Leaving compact closes the drawer.
  useEffect(() => {
    if (!compact) setDrawerOpen(false);
  }, [compact, setDrawerOpen]);

  const inspectorOpen = compact ? drawerOpen : !collapsed;
  const inspector = {
    open: inspectorOpen,
    label: inspectorOpen ? "Hide inspector" : "Show inspector",
    toggle: () => (compact ? setDrawerOpen(!drawerOpen) : setCollapsed(!collapsed)),
  };

  return (
    <CodeContext.Provider value={codeCtx}>
      <div className="absolute inset-0 flex min-w-0">
        <div className="min-h-0 min-w-0 flex-1">
          <Conversation
            ctx={ctx}
            actions={actions}
            focusInteractionId={focusInteractionId}
            inspector={inspector}
          />
        </div>
        {showInspector && inspectorWidth !== null && (
          <>
            <Splitter
              label="Resize inspector"
              pane="after"
              value={inspectorWidth}
              min={PANE_LIMITS.inspector.min}
              max={PANE_LIMITS.inspector.max}
              onChange={setInspectorWidth}
              onReset={() => setInspectorWidth(PANE_LIMITS.inspector.default)}
              className="-mr-1.5"
            />
            <div
              className="min-h-0 shrink-0 border-l border-border"
              style={{ width: inspectorWidth }}
            >
              <Inspector
                ctx={ctx}
                actions={actions}
                tab={tab}
                onTab={setTab}
                openPath={openPath}
                className="h-full"
              />
            </div>
          </>
        )}
      </div>
      {compact && (
        <Drawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          title="Inspector"
          width={440}
          flush
        >
          <Inspector
            ctx={ctx}
            actions={actions}
            tab={tab}
            onTab={setTab}
            openPath={openPath}
            hideTitle
          />
        </Drawer>
      )}
    </CodeContext.Provider>
  );
}

/** Mobile: the session list at /code, one session screen at /code/:id. */
export function CodeMobile(props: LayoutProps) {
  const navigate = useNavigate();
  const [newOpen, setNewOpen] = useState(false);
  const ctx = useSessionContext(props.session);
  const onCreated = useCallback(
    (id: string) => {
      setNewOpen(false);
      navigate(`/code/${encodeURIComponent(id)}`, { state: BACK_STATE });
    },
    [navigate],
  );
  if (props.sessionId) {
    if (!props.hydrated) return <LoadingState label="Loading session…" />;
    if (!ctx) return <NoSession missing />;
    return (
      <MobileSessionScreen
        key={ctx.session.id}
        ctx={ctx}
        focus={props.focusInteractionId}
        tabRequest={props.tabRequest}
      />
    );
  }
  return (
    <div className="absolute inset-0 flex min-w-0 flex-col">
      <Navigator
        variant="screen"
        selectedId={null}
        onNewSession={() => setNewOpen(true)}
        className="min-h-0 flex-1 safe-pt"
      />
      <NewSessionFlow
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCreated={onCreated}
        mobile
      />
    </div>
  );
}

function MobileSessionScreen({
  ctx,
  focus,
  tabRequest,
}: {
  ctx: SessionContext;
  focus: string | null;
  tabRequest: TabRequest | null;
}) {
  const actions = useSessionActions(ctx);
  return (
    <MobileSession ctx={ctx} actions={actions} focusInteractionId={focus} tabRequest={tabRequest} />
  );
}

import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  EllipsisVertical,
  Play,
  SquareKanban,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Button, buttonClasses } from "../../components/ui/Button";
import { IconButton } from "../../components/ui/IconButton";
import { Menu, type MenuItem } from "../../components/ui/Menu";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { StatusChip } from "../../components/ui/StatusChip";
import { HostUnavailable } from "../../components/ui/states";
import { useDraft } from "../../drafts";
import { usePendingInteractions } from "../../sync/store";
import { MobileChanges } from "./Changes";
import { Composer } from "./Composer";
import { ControlChip, ConversationHeader, sessionMenuItems } from "./ConversationHeader";
import { CodeContext, type CodeViewContext, type InspectorTab } from "./context";
import { MobileDetails } from "./Details";
import type { SessionContext } from "./hooks";
import { AUTOMATION_LABEL, workspaceLabel } from "./model";
import type { SessionActions } from "./SessionActions";
import { Transcript } from "./Transcript";

function interactionReadOnly(ctx: SessionContext): string | null {
  if (ctx.session.readOnly) return "Read-only subagent view: answer in the parent session.";
  if (ctx.link !== "connected") {
    return `Host ${ctx.hostName} is offline; answers can be sent when it reconnects.`;
  }
  return null;
}

/** Host unavailable, failed and interrupted states shown above the transcript. */
function SessionBanners({ ctx, actions }: { ctx: SessionContext; actions: SessionActions }) {
  const { session } = ctx;
  return (
    <>
      {ctx.link !== "connected" && (
        <div className="shrink-0 px-3 pt-2">
          <HostUnavailable
            compact
            hostName={ctx.hostName}
            connectivity={ctx.link === "reconnecting" ? "reconnecting" : "unreachable"}
            lastSeenAt={ctx.host?.lastSeenAt}
            detail="Showing the last known transcript. Sending and answers resume when the host reconnects."
          />
        </div>
      )}
      {session.runtime === "failed" && (
        <div className="shrink-0 px-3 pt-2">
          <div
            role="alert"
            className="flex flex-wrap items-start gap-2 rounded-md border border-border bg-danger-soft px-3 py-2 text-sm"
          >
            <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">This session failed</div>
              <div className="break-words text-muted">
                {session.runtimeDetail ?? "Pi exited with an error."}
              </div>
              <Link to="/settings/diagnostics" className="text-accent underline">
                Open diagnostics
              </Link>
            </div>
            {actions.canResume && (
              <Button
                size="sm"
                icon={<Play className="size-3.5" />}
                busy={actions.busy.resume}
                onClick={actions.resume}
              >
                Resume
              </Button>
            )}
          </div>
        </div>
      )}
      {session.runtime === "interrupted" && session.runtimeDetail && (
        <p role="status" className="shrink-0 px-4 pt-2 text-sm text-muted">
          Interrupted: {session.runtimeDetail}
        </p>
      )}
      {session.archivedAt && (
        <p role="status" className="shrink-0 px-4 pt-2 text-sm text-muted">
          This session is archived.
        </p>
      )}
    </>
  );
}

function useComposerDraft(sessionId: string) {
  const [draft, setDraft, clearDraft] = useDraft(sessionId);
  const onUseSuggestion = (text: string) => {
    // Never overwrite a non-empty draft.
    if (draft.trim() === "") setDraft(text);
  };
  return { draft, setDraft, clearDraft, onUseSuggestion };
}

/** Desktop/compact conversation pane: header, banners, transcript and composer. */
export function Conversation({
  ctx,
  actions,
  focusInteractionId,
  inspector,
}: {
  ctx: SessionContext;
  actions: SessionActions;
  focusInteractionId: string | null;
  inspector: { open: boolean; toggle: () => void; label: string };
}) {
  const d = useComposerDraft(ctx.session.id);
  return (
    <section
      data-testid="conversation"
      aria-label="Conversation"
      className="flex h-full min-h-0 min-w-0 flex-col bg-bg"
    >
      <ConversationHeader ctx={ctx} actions={actions} inspector={inspector} />
      <SessionBanners ctx={ctx} actions={actions} />
      <Transcript
        sessionId={ctx.session.id}
        draftEmpty={d.draft.trim() === ""}
        onUseSuggestion={d.onUseSuggestion}
        interactionReadOnly={interactionReadOnly(ctx)}
        focusInteractionId={focusInteractionId}
      />
      <Composer
        ctx={ctx}
        draft={d.draft}
        setDraft={d.setDraft}
        clearDraft={d.clearDraft}
        mobile={false}
        onTakeover={actions.takeover}
        takeoverBusy={actions.busy.takeover}
        onResume={actions.resume}
        resumeBusy={actions.busy.resume}
      />
      {actions.dialogs}
    </section>
  );
}

type MobileTab = "chat" | "changes" | "details";

/** Mobile segment for a requested inspector tab (`?tab=`): Changes, else Details. */
function mobileTabFor(tab: InspectorTab | null | undefined): MobileTab {
  if (!tab) return "chat";
  return tab === "changes" ? "changes" : "details";
}

/** Mobile session screen: one surface at a time (Chat, Changes, Details). */
export function MobileSession({
  ctx,
  actions,
  focusInteractionId,
  tabRequest,
}: {
  ctx: SessionContext;
  actions: SessionActions;
  focusInteractionId: string | null;
  /** `?tab=` from the URL (e.g. Board "Review changes" opens Changes). */
  tabRequest?: { tab: InspectorTab; key: string } | null;
}) {
  const { session, project, workspace, task } = ctx;
  const navigate = useNavigate();
  const [tab, setTab] = useState<MobileTab>(() => mobileTabFor(tabRequest?.tab));
  const [metaOpen, setMetaOpen] = useState(false);
  const pending = usePendingInteractions(session.id);
  const d = useComposerDraft(session.id);

  // Deep links and session switches show Chat, unless the link asks for a tab (`?tab=changes`).
  const tabKey = tabRequest ? `${tabRequest.tab}:${tabRequest.key}` : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: apply once per navigation
  useEffect(() => setTab(mobileTabFor(tabRequest?.tab)), [session.id, focusInteractionId, tabKey]);

  const codeCtx = useMemo<CodeViewContext>(
    () => ({ mobile: true, openInspector: (t) => setTab(t === "changes" ? "changes" : "details") }),
    [],
  );

  const menuItems: MenuItem[] = [
    ...(task
      ? [
          {
            id: "task",
            label: "Open linked task",
            icon: <SquareKanban className="size-4" />,
            onSelect: () => navigate(`/tasks/${encodeURIComponent(task.id)}`),
          },
        ]
      : []),
    ...(actions.canResume
      ? [
          {
            id: "resume",
            label: "Resume",
            icon: <Play className="size-4" />,
            onSelect: actions.resume,
          },
        ]
      : []),
    ...sessionMenuItems(ctx, actions),
  ];

  return (
    <CodeContext.Provider value={codeCtx}>
      <div className="absolute inset-0 flex min-w-0 flex-col bg-bg">
        <header className="flex min-w-0 shrink-0 items-center gap-1 border-b border-border bg-surface px-1.5 py-1 safe-pt">
          <Link
            to="/code"
            aria-label="Back to sessions"
            title="Back to sessions"
            className={buttonClasses("ghost", "md", "size-11 px-0")}
          >
            <ArrowLeft aria-hidden className="size-5" />
          </Link>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base leading-6 font-semibold" title={session.title}>
              {session.title}
            </h1>
          </div>
          <StatusChip kind="runtime" value={session.runtime} size="sm" className="shrink-0" />
          <Menu
            label="Session actions"
            items={menuItems}
            trigger={(p) => (
              <IconButton
                {...p}
                label="More actions"
                icon={<EllipsisVertical className="size-5" />}
              />
            )}
          />
        </header>
        <div className="shrink-0 border-b border-border bg-surface px-3">
          <button
            type="button"
            aria-expanded={metaOpen}
            aria-controls="sy-session-meta"
            onClick={() => setMetaOpen((o) => !o)}
            className="tap flex w-full min-w-0 items-center gap-2 py-1.5 text-left text-xs text-muted"
          >
            <span className="min-w-0 flex-1 truncate">
              {project?.name ?? "No project"} · {workspaceLabel(workspace, session.cwd)} ·{" "}
              {ctx.hostName}
              {ctx.link !== "connected" ? " (offline)" : ""} · {AUTOMATION_LABEL[ctx.control]}
            </span>
            {metaOpen ? (
              <ChevronUp aria-hidden className="size-4 shrink-0" />
            ) : (
              <ChevronDown aria-hidden className="size-4 shrink-0" />
            )}
            <span className="sr-only">{metaOpen ? "Hide details" : "Show details"}</span>
          </button>
          {metaOpen && (
            <dl
              id="sy-session-meta"
              className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 pb-2 text-xs"
            >
              <dt className="text-muted">Project</dt>
              <dd className="min-w-0 break-words">{project?.name ?? "None"}</dd>
              <dt className="text-muted">Branch</dt>
              <dd className="min-w-0 font-mono break-all">
                {workspaceLabel(workspace, session.cwd)}
              </dd>
              <dt className="text-muted">Host</dt>
              <dd className="min-w-0 break-words">
                {ctx.hostName} ({ctx.link})
              </dd>
              <dt className="text-muted">Control</dt>
              <dd>
                <ControlChip ctx={ctx} />
                {ctx.control === "none" && "Manual session"}
              </dd>
              <dt className="text-muted">Path</dt>
              <dd className="min-w-0 font-mono break-all">{session.cwd}</dd>
              <dt className="text-muted">Profile</dt>
              <dd className="min-w-0 break-words">{session.profileSnapshot.name}</dd>
            </dl>
          )}
        </div>
        <div className="shrink-0 bg-surface px-3 py-2" data-testid="mobile-tabs">
          <SegmentedControl<MobileTab>
            label="Session view"
            block
            value={tab}
            onChange={setTab}
            options={[
              {
                value: "chat",
                label: "Chat",
                badge:
                  pending.length > 0 ? (
                    <span className="rounded-full bg-warning-soft px-1.5 text-xs text-warning">
                      {pending.length}
                      <span className="sr-only"> pending questions</span>
                    </span>
                  ) : undefined,
              },
              { value: "changes", label: "Changes" },
              { value: "details", label: "Details" },
            ]}
          />
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {tab === "chat" && (
            <section
              data-testid="conversation"
              aria-label="Chat"
              className="flex min-h-0 min-w-0 flex-1 flex-col"
            >
              <SessionBanners ctx={ctx} actions={actions} />
              <Transcript
                sessionId={session.id}
                draftEmpty={d.draft.trim() === ""}
                onUseSuggestion={d.onUseSuggestion}
                interactionReadOnly={interactionReadOnly(ctx)}
                focusInteractionId={focusInteractionId}
              />
              <Composer
                ctx={ctx}
                draft={d.draft}
                setDraft={d.setDraft}
                clearDraft={d.clearDraft}
                mobile
                onTakeover={actions.takeover}
                takeoverBusy={actions.busy.takeover}
                onResume={actions.resume}
                resumeBusy={actions.busy.resume}
                className="safe-pb"
              />
            </section>
          )}
          {tab === "changes" && (
            <section
              aria-label="Changes"
              className="relative min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain"
            >
              <MobileChanges ctx={ctx} />
            </section>
          )}
          {tab === "details" && (
            <section
              aria-label="Details"
              className="relative min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain"
            >
              <MobileDetails ctx={ctx} actions={actions} />
            </section>
          )}
        </div>
        {actions.dialogs}
      </div>
    </CodeContext.Provider>
  );
}

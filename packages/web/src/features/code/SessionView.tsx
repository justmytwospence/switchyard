import type { Session } from "@switchyard/protocol";
import { ArrowLeft, EllipsisVertical, Square, SquareKanban } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useHideBottomNav } from "../../app/chrome";
import { backLinkClick, useBackTo } from "../../app/useBackTo";
import { CountBadge } from "../../components/ui/Badge";
import { buttonClasses } from "../../components/ui/Button";
import { IconButton } from "../../components/ui/IconButton";
import { Menu, type MenuItem } from "../../components/ui/Menu";
import { Sheet } from "../../components/ui/Overlay";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { StatusChip } from "../../components/ui/StatusChip";
import { appendQuote, useDraft, useReplyNotes } from "../../drafts";
import { usePendingInteractions, useSyncStore } from "../../sync/store";
import { useContributePalette } from "../palette/registry";
import { TOGGLE_TERMINAL_EVENT } from "../palette/useGlobalShortcuts";
import { MobileChanges } from "./Changes";
import { Composer } from "./Composer";
import { ConversationHeader, sessionMenuItems } from "./ConversationHeader";
import { CodeContext, type CodeViewContext, type InspectorTab } from "./context";
import { MobileDetails, SessionFacts } from "./Details";
import type { SessionContext } from "./hooks";
import { isSubagentView, SUBAGENT_READ_ONLY } from "./model";
import { PullRequest } from "./PullRequest";
import type { SessionActions } from "./SessionActions";
import { SessionStatusBar } from "./SessionStatusBar";
import { canUseTerminal, useSessionSurface } from "./surface";
import { TerminalView } from "./TerminalView";
import { Transcript } from "./Transcript";
import { usePullRequest } from "./usePullRequest";

function interactionReadOnly(ctx: SessionContext): string | null {
  if (ctx.session.readOnly) return `${SUBAGENT_READ_ONLY} Answer in the parent session.`;
  if (ctx.link !== "connected") {
    return `Host ${ctx.hostName} is offline; answers can be sent when it reconnects.`;
  }
  return null;
}

/** A subagent's transcript is re-read from its native file on every open to show progress. */
function useSubagentRefresh(session: Session) {
  const loadTranscript = useSyncStore((s) => s.loadTranscript);
  const subagent = isSubagentView(session);
  useEffect(() => {
    if (subagent) void loadTranscript(session.id, { force: true });
  }, [subagent, session.id, loadTranscript]);
}

function useComposerDraft(sessionId: string) {
  const [draft, setDraft, clearDraft] = useDraft(sessionId);
  const replyNotes = useReplyNotes(sessionId);
  const onUseSuggestion = (text: string) => {
    // Never overwrite a non-empty draft.
    if (draft.trim() === "") setDraft(text);
  };
  const onQuote = (q: string) => setDraft(appendQuote(draft, q));
  const onComment = (quote: string, comment: string) => replyNotes.add({ quote, comment });
  return { draft, setDraft, clearDraft, onUseSuggestion, replyNotes, onQuote, onComment };
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
  useSubagentRefresh(ctx.session);
  const [stored, setSurface] = useSessionSurface(ctx.session.id);
  const terminalOk = canUseTerminal(ctx.session, ctx.host);
  const surface = terminalOk ? stored : "chat";
  useEffect(() => {
    if (!terminalOk) return;
    const toggle = () => setSurface(surface === "terminal" ? "chat" : "terminal");
    window.addEventListener(TOGGLE_TERMINAL_EVENT, toggle);
    return () => window.removeEventListener(TOGGLE_TERMINAL_EVENT, toggle);
  }, [terminalOk, surface, setSurface]);
  useContributePalette("session", [
    ...(actions.canStop
      ? [
          {
            id: "session:stop",
            title: "Stop session",
            group: "Actions" as const,
            run: actions.requestStop,
          },
        ]
      : []),
    ...(terminalOk
      ? [
          {
            id: "session:surface",
            title: surface === "terminal" ? "Switch to chat" : "Switch to terminal",
            group: "Actions" as const,
            shortcut: "toggleTerminal" as const,
            run: () => setSurface(surface === "terminal" ? "chat" : "terminal"),
          },
        ]
      : []),
    {
      id: "session:rename",
      title: "Rename session",
      group: "Actions" as const,
      run: actions.openRename,
    },
  ]);
  return (
    <section
      data-testid="conversation"
      aria-label="Conversation"
      className="flex h-full min-h-0 min-w-0 flex-col bg-bg"
    >
      <ConversationHeader
        ctx={ctx}
        actions={actions}
        inspector={inspector}
        surface={terminalOk ? { value: surface, onChange: setSurface } : null}
      />
      {surface === "terminal" ? (
        <TerminalView session={ctx.session} />
      ) : (
        <>
          <Transcript
            sessionId={ctx.session.id}
            draftEmpty={d.draft.trim() === ""}
            onUseSuggestion={d.onUseSuggestion}
            onQuote={d.onQuote}
            onComment={d.onComment}
            interactionReadOnly={interactionReadOnly(ctx)}
            focusInteractionId={focusInteractionId}
            footer={({ openFirstPending }) => (
              <SessionStatusBar ctx={ctx} actions={actions} onAnswer={openFirstPending} />
            )}
          />
          <Composer
            ctx={ctx}
            draft={d.draft}
            setDraft={d.setDraft}
            clearDraft={d.clearDraft}
            replyNotes={d.replyNotes}
            mobile={false}
          />
        </>
      )}
      {actions.dialogs}
    </section>
  );
}

type MobileTab = "chat" | "changes" | "details" | "terminal" | "pr";

/** Mobile segment for a requested inspector tab (`?tab=`): PR, Changes, else Details. */
function mobileTabFor(tab: InspectorTab | null | undefined): MobileTab {
  if (!tab) return "chat";
  return tab === "pr" ? "pr" : tab === "changes" ? "changes" : "details";
}

/** Mobile session screen: one surface at a time (Chat, Changes, PR, Details, Terminal). */
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
  const back = useBackTo("/code");
  const { session, task } = ctx;
  const navigate = useNavigate();
  const [tab, setTab] = useState<MobileTab>(() => mobileTabFor(tabRequest?.tab));
  const github = usePullRequest(ctx, tab === "pr");
  const [visited, setVisited] = useState<Set<MobileTab>>(
    () => new Set([mobileTabFor(tabRequest?.tab)]),
  );
  const [infoOpen, setInfoOpen] = useState(false);
  const pending = usePendingInteractions(session.id);
  const d = useComposerDraft(session.id);
  useSubagentRefresh(session);
  useHideBottomNav(true); // Back replaces the bottom navigation here.

  // Deep links and session switches show Chat, unless the link asks for a tab (`?tab=changes`).
  const tabKey = tabRequest ? `${tabRequest.tab}:${tabRequest.key}` : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: apply once per navigation
  useEffect(() => setTab(mobileTabFor(tabRequest?.tab)), [session.id, focusInteractionId, tabKey]);
  // Changes and Details mount on first visit, then stay mounted.
  useEffect(() => setVisited((v) => (v.has(tab) ? v : new Set(v).add(tab))), [tab]);

  const codeCtx = useMemo<CodeViewContext>(
    () => ({ mobile: true, openInspector: (t) => setTab(mobileTabFor(t)) }),
    [],
  );

  const changed = ctx.workspace?.git.changedFiles ?? 0;
  const views = useSyncStore((st) => st.views);
  const menuItems: MenuItem[] = [
    ...(github.snapshot?.pullRequest
      ? [{ id: "pr", label: "Pull request", onSelect: () => setTab("pr") }]
      : []),
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
    ...(actions.canStop
      ? [
          {
            id: "stop",
            label: "Stop",
            icon: <Square className="size-4" />,
            danger: true,
            onSelect: actions.requestStop,
          },
        ]
      : []),
    ...sessionMenuItems(ctx, actions, Object.values(views)),
  ];

  return (
    <CodeContext.Provider value={codeCtx}>
      <div className="absolute inset-0 flex min-w-0 flex-col bg-bg">
        <div className="shrink-0 border-b border-border bg-surface safe-pt">
          <header className="flex min-w-0 items-center gap-1 px-1.5 py-1">
            <Link
              to="/code"
              onClick={backLinkClick(back)}
              aria-label="Back to sessions"
              title="Back to sessions"
              className={buttonClasses("ghost", "md", "size-11 px-0")}
            >
              <ArrowLeft aria-hidden className="size-5" />
            </Link>
            <h1 className="min-w-0 flex-1 text-base leading-6 font-semibold">
              <button
                type="button"
                aria-haspopup="dialog"
                onClick={() => setInfoOpen(true)}
                className="tap block w-full truncate text-left"
              >
                {session.title}
              </button>
            </h1>
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
          <div className="px-3 pb-1.5" data-testid="mobile-tabs">
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
                      <>
                        <span aria-hidden className="size-2 shrink-0 rounded-full bg-warning" />
                        <span className="sr-only">
                          {pending.length} pending {pending.length === 1 ? "question" : "questions"}
                        </span>
                      </>
                    ) : undefined,
                },
                {
                  value: "changes",
                  label: "Changes",
                  badge: <CountBadge count={changed} label="changed files" tone="neutral" />,
                },
                { value: "details", label: "Details" },
                ...(github.snapshot?.pullRequest ? [{ value: "pr" as const, label: "PR" }] : []),
                ...(canUseTerminal(session, ctx.host)
                  ? [{ value: "terminal" as const, label: "Terminal" }]
                  : []),
              ]}
            />
          </div>
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <section
            data-testid="conversation"
            aria-label="Chat"
            hidden={tab !== "chat"}
            className="flex min-h-0 min-w-0 flex-1 flex-col"
          >
            <Transcript
              sessionId={session.id}
              draftEmpty={d.draft.trim() === ""}
              onUseSuggestion={d.onUseSuggestion}
              onQuote={d.onQuote}
              onComment={d.onComment}
              interactionReadOnly={interactionReadOnly(ctx)}
              focusInteractionId={focusInteractionId}
              active={tab === "chat"}
              footer={({ openFirstPending }) => (
                <SessionStatusBar ctx={ctx} actions={actions} onAnswer={openFirstPending} />
              )}
            />
            <Composer
              ctx={ctx}
              draft={d.draft}
              setDraft={d.setDraft}
              clearDraft={d.clearDraft}
              replyNotes={d.replyNotes}
              mobile
            />
          </section>
          <section
            aria-label="Changes"
            hidden={tab !== "changes"}
            className="relative min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain"
          >
            {(tab === "changes" || visited.has("changes")) && <MobileChanges ctx={ctx} />}
          </section>
          <section
            aria-label="PR"
            hidden={tab !== "pr"}
            className="relative min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain p-3"
          >
            {(tab === "pr" || visited.has("pr")) && (
              <PullRequest ctx={ctx} state={github} active={tab === "pr"} />
            )}
          </section>
          <section
            aria-label="Terminal"
            hidden={tab !== "terminal"}
            className="relative min-h-0 min-w-0 flex-1"
          >
            {(tab === "terminal" || visited.has("terminal")) && tab === "terminal" && (
              <TerminalView session={session} />
            )}
          </section>
          <section
            aria-label="Details"
            hidden={tab !== "details"}
            className="relative min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain"
          >
            {(tab === "details" || visited.has("details")) && (
              <MobileDetails ctx={ctx} actions={actions} github={github} />
            )}
          </section>
        </div>
        <Sheet open={infoOpen} onClose={() => setInfoOpen(false)} title="Session details">
          <p className="mb-3 text-sm font-medium break-words">{session.title}</p>
          <SessionFacts ctx={ctx} />
        </Sheet>
        {actions.dialogs}
      </div>
    </CodeContext.Provider>
  );
}

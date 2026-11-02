import type { Interaction, Session } from "@switchyard/protocol";
import { Box, render, Text, useApp, useInput, useWindowSize } from "ink";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ApiRequestError, type FetchLike, SwitchyardClient } from "./client.js";
import {
  controlLines,
  type InteractionUi,
  initialInteractionUi,
  interactionKey,
  isTyping,
} from "./interaction.js";
import { composerKey, editText, globalAction, type Screen } from "./keys.js";
import type { ClientState } from "./store.js";
import {
  canSteer,
  composerDisabledReason,
  connectivityLabel,
  flatSessions,
  groupSessions,
  isBusy,
  type LineStyle,
  pendingInteractions,
  runtimeLabel,
  sessionRun,
  statusLine,
  transcriptTail,
  wrapText,
} from "./view.js";

const STYLE_COLORS: Record<LineStyle, { color?: string; dimColor?: boolean; bold?: boolean }> = {
  user: { color: "cyan", bold: true },
  assistant: {},
  muted: { dimColor: true },
  tool: { color: "blue" },
  warning: { color: "yellow" },
  error: { color: "red" },
  accent: { color: "magenta" },
};

const HELP: [string, string][] = [
  ["Up/Down, Enter", "Choose and open a session"],
  ["/", "Search sessions (Esc clears)"],
  ["Enter", "Send (while running: queue a follow-up)"],
  ["Alt+Enter", "New line in the composer"],
  ["Ctrl+S", "Steer the running agent (when the host supports it)"],
  ["Tab", "Move between the composer and a pending question"],
  ["Ctrl+T", "Take over / return to automation"],
  ["Ctrl+X", "Stop execution (asks to confirm)"],
  ["Esc", "Back"],
  ["?", "This help"],
  ["Ctrl+C", "Quit. Detaches only: sessions keep running on their hosts"],
];

function useClientState(client: SwitchyardClient): ClientState {
  return useSyncExternalStore(client.store.subscribe, client.store.getState);
}

function errorText(err: unknown): string {
  if (err instanceof ApiRequestError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

export interface AppProps {
  client: SwitchyardClient;
  initialSessionId?: string;
  onExit: (result: TerminalResult) => void;
}

export type TerminalResult = { reason: "quit" } | { reason: "logout"; message: string };

export function App({ client, initialSessionId, onExit }: AppProps) {
  const state = useClientState(client);
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [screen, setScreen] = useState<Screen>(initialSessionId ? "session" : "list");
  const [helpReturn, setHelpReturn] = useState<Screen>("list");
  const [sessionId, setSessionId] = useState<string | null>(initialSessionId ?? null);
  const [cursor, setCursor] = useState(0);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [focus, setFocus] = useState<"composer" | "interaction">("composer");
  const [uiState, setUi] = useState<InteractionUi | null>(null);
  const [flash, setFlash] = useState<{ text: string; tone: "info" | "error" } | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [working, setWorking] = useState(false);
  const flashTimer = useRef<NodeJS.Timeout | null>(null);

  const quit = useCallback(
    (result: TerminalResult) => {
      onExit(result);
      exit();
    },
    [exit, onExit],
  );

  useEffect(
    () => client.onLogout((reason) => quit({ reason: "logout", message: reason })),
    [client, quit],
  );

  const say = useCallback((text: string, tone: "info" | "error" = "info") => {
    setFlash({ text, tone });
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 10_000);
  }, []);

  const groups = useMemo(() => groupSessions(state, query), [state, query]);
  const flat = useMemo(() => flatSessions(groups), [groups]);
  const session: Session | undefined = sessionId ? state.sessions[sessionId] : undefined;
  const pending: Interaction[] = useMemo(
    () => (sessionId ? pendingInteractions(state, sessionId) : []),
    [state, sessionId],
  );
  const current = pending[0];
  const draft = sessionId ? (drafts[sessionId] ?? "") : "";

  // Viewing presence and transcript loading follow the open session.
  useEffect(() => {
    if (screen === "session" && sessionId) {
      client.setViewing(sessionId);
      client.loadSession(sessionId).catch((err) => say(errorText(err), "error"));
    } else if (screen === "list") {
      client.setViewing(null);
    }
  }, [client, screen, sessionId, say]);

  // Answer controls follow the first pending interaction (reset when it or its revision changes).
  const ui: InteractionUi | null = current
    ? uiState && uiState.interactionId === current.id && uiState.revision === current.revision
      ? uiState
      : initialInteractionUi(current)
    : null;
  useEffect(() => {
    if (!current) setFocus("composer");
  }, [current]);

  // Focus a newly pending question unless the user is typing a message.
  const lastPendingId = useRef<string | null>(null);
  useEffect(() => {
    const id = current?.id ?? null;
    if (id && id !== lastPendingId.current && !draft) setFocus("interaction");
    lastPendingId.current = id;
  }, [current, draft]);

  useEffect(() => {
    if (cursor >= flat.length && flat.length > 0) setCursor(flat.length - 1);
  }, [cursor, flat.length]);

  const setDraft = (text: string) => {
    if (!sessionId) return;
    setDrafts((d) => ({ ...d, [sessionId]: text }));
  };

  const doSend = async (s: Session, text: string, mode: "prompt" | "followUp" | "steer") => {
    setWorking(true);
    try {
      const res = await client.prompt(s.id, text, mode);
      setDrafts((d) => ({ ...d, [s.id]: "" }));
      if (res?.automationActive) {
        say("Automation is active; take over (Ctrl+T) to stop automatic continuations");
      } else {
        say(mode === "followUp" ? "Queued follow-up" : mode === "steer" ? "Steered" : "Sent");
      }
    } catch (err) {
      say(errorText(err), "error");
    } finally {
      setWorking(false);
    }
  };

  const doAnswer = async (i: Interaction, response: Parameters<SwitchyardClient["answer"]>[1]) => {
    setWorking(true);
    try {
      const out = await client.answer(i, response);
      if (out.status === "already_answered") say(`Already answered: ${out.summary}`);
      else if (
        i.state === "unsupported" &&
        response.kind === "action" &&
        response.actionId === "message"
      ) {
        // The alternative to a terminal-only dialog: type the message in the composer.
        setFocus("composer");
        say("Type your message to the agent below and press Enter");
      } else say(`Answered: ${out.interaction.resolution?.summary ?? i.title}`);
    } catch (err) {
      say(errorText(err), "error");
    } finally {
      setWorking(false);
    }
  };

  const doToggleControl = async (s: Session) => {
    const run = sessionRun(state, s);
    if (!run) {
      say("This session is not controlled by an automation run", "error");
      return;
    }
    setWorking(true);
    try {
      if (run.controlMode === "automation") {
        await client.takeover(s.id);
        say("You have control. Automatic continuations are paused (Ctrl+T returns control)");
      } else {
        await client.returnToAutomation(s.id);
        say("Returned to automation");
      }
    } catch (err) {
      say(errorText(err), "error");
    } finally {
      setWorking(false);
    }
  };

  const doStop = async (s: Session) => {
    setWorking(true);
    try {
      await client.stop(s.id);
      say("Stopped. The run stays with its task, marked Stopped by user");
    } catch (err) {
      say(errorText(err), "error");
    } finally {
      setWorking(false);
    }
  };

  useInput((input, key) => {
    client.noteKeypress();
    if (confirmStop) {
      setConfirmStop(false);
      if ((input === "y" || input === "Y") && session) void doStop(session);
      else if (!(key.ctrl && input === "c")) say("Stop cancelled");
      if (!(key.ctrl && input === "c")) return;
    }
    const typing =
      screen === "session" &&
      ((focus === "composer" && draft.length > 0) ||
        (focus === "interaction" && ui !== null && isTyping(ui)));
    const action = globalAction(input, key, { screen, typing, searching });
    switch (action) {
      case "quit":
        quit({ reason: "quit" });
        return;
      case "help":
        setHelpReturn(screen);
        setScreen("help");
        return;
      case "back":
        if (screen === "help") setScreen(helpReturn);
        else if (screen === "session") {
          if (focus === "interaction") setFocus("composer");
          else setScreen("list");
        }
        return;
      case "search":
        setSearching(true);
        return;
      case "takeover":
        if (session && !working) void doToggleControl(session);
        return;
      case "stop":
        if (session) setConfirmStop(true);
        return;
      default:
        break;
    }
    if (screen === "list") {
      if (searching) {
        if (key.escape) {
          setSearching(false);
          setQuery("");
        } else if (key.return) setSearching(false);
        else {
          const next = editText(query, input, key, { multiline: false });
          if (next !== null) {
            setQuery(next);
            setCursor(0);
          }
        }
        return;
      }
      if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
      else if (key.downArrow) setCursor((c) => Math.min(flat.length - 1, c + 1));
      else if (key.return && flat[cursor]) {
        setSessionId(flat[cursor].id);
        setFocus("composer");
        setScreen("session");
      }
      return;
    }
    if (screen !== "session" || !session || working) return;
    if (key.tab && focus === "composer") {
      if (current) setFocus("interaction");
      return;
    }
    if (focus === "interaction" && ui && current) {
      const step = interactionKey(ui, input, key);
      if (step.kind === "update") setUi(step.ui);
      else if (step.kind === "submit") {
        setUi(step.ui);
        void doAnswer(current, step.response);
      }
      return;
    }
    const result = composerKey(draft, input, key, {
      busy: isBusy(session),
      canSteer: canSteer(state, session),
      disabledReason: composerDisabledReason(state, session),
    });
    if (result.kind === "edit") setDraft(result.draft);
    else if (result.kind === "blocked") say(result.reason, "error");
    else if (result.kind === "send") void doSend(session, result.text, result.mode);
  });

  const width = Math.max(20, columns - 2);
  const flashLine = flash ? (
    <Text color={flash.tone === "error" ? "red" : "green"}>{flash.text}</Text>
  ) : null;

  if (screen === "help") {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold>Switchyard terminal: keys</Text>
        {HELP.map(([k, v]) => (
          <Text key={k}>
            <Text color="cyan">{k.padEnd(16)}</Text>
            {v}
          </Text>
        ))}
        <Text dimColor>Esc or ? to close</Text>
      </Box>
    );
  }

  const connection =
    state.connection.state === "live"
      ? null
      : state.connection.state === "logged_out"
        ? `Signed out: ${state.connection.reason ?? ""}`
        : state.synced
          ? "Reconnecting... showing last known data"
          : "Connecting to coordinator...";

  if (screen === "list") {
    const visibleRows = Math.max(5, rows - 6);
    const rowsOut: { key: string; node: ReactNode }[] = [];
    let idx = 0;
    for (const g of groups) {
      rowsOut.push({
        key: `g:${g.projectId ?? "none"}`,
        node: (
          <Text bold color="magenta">
            {g.projectName}
          </Text>
        ),
      });
      for (const s of g.sessions) {
        const selected = idx === cursor;
        const host = state.hosts[s.hostId];
        const needs = pendingInteractions(state, s.id).length > 0;
        rowsOut.push({
          key: s.id,
          node: (
            <Text inverse={selected} wrap="truncate-end">
              {selected ? "> " : "  "}
              {s.title}
              <Text dimColor>
                {"  "}
                {runtimeLabel(s.runtime)}
                {needs ? " | needs your answer" : ""} | {host?.name ?? s.hostId} (
                {connectivityLabel(host?.connectivity ?? s.connectivity)})
              </Text>
            </Text>
          ),
        });
        idx++;
      }
    }
    // Keep the selected row in view.
    const selectedRow = rowsOut.findIndex((r) => r.key === flat[cursor]?.id);
    const start = Math.max(
      0,
      Math.min(selectedRow - Math.floor(visibleRows / 2), rowsOut.length - visibleRows),
    );
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold>Switchyard sessions</Text>
        {connection && <Text color="yellow">{connection}</Text>}
        {searching || query ? (
          <Text>
            Search: <Text color="cyan">{query}</Text>
            {searching ? "_" : ""}
          </Text>
        ) : null}
        {flat.length === 0 ? (
          <Text dimColor>
            {state.synced
              ? query
                ? "No sessions match the search."
                : "No sessions yet. Start one from the web app or a task."
              : "Loading..."}
          </Text>
        ) : (
          rowsOut.slice(start, start + visibleRows).map((r) => <Box key={r.key}>{r.node}</Box>)
        )}
        {flashLine}
        <Text dimColor>Up/Down move | Enter open | / search | ? help | Ctrl+C quit</Text>
      </Box>
    );
  }

  // Session view
  if (!session) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text>{state.synced ? `Session ${sessionId} not found.` : "Loading session..."}</Text>
        {connection && <Text color="yellow">{connection}</Text>}
        <Text dimColor>Esc back | Ctrl+C quit</Text>
      </Box>
    );
  }

  const disabled = composerDisabledReason(state, session);
  const busy = isBusy(session);
  const steer = canSteer(state, session);
  const answerLines = ui ? controlLines(ui) : [];
  const bodyLines = ui ? ui.body.flatMap((l) => wrapText(l, width - 2)).slice(0, 8) : [];
  const draftLines = (draft || "").split("\n");
  const composerRows = Math.min(6, draftLines.length) + 2;
  const interactionRows = current ? bodyLines.length + answerLines.length + 3 : 0;
  const tailRows = Math.max(
    3,
    rows -
      4 -
      composerRows -
      interactionRows -
      (flash ? 1 : 0) -
      (connection ? 1 : 0) -
      (confirmStop ? 1 : 0),
  );
  const tail = transcriptTail(state, session.id, tailRows, width);
  const project = session.projectId ? state.projects[session.projectId] : undefined;
  const hint = busy
    ? `Enter queue follow-up${steer ? " | Ctrl+S steer" : ""} | Alt+Enter newline`
    : "Enter send | Alt+Enter newline";

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold wrap="truncate-end">
        {session.title}
        <Text dimColor>
          {"  "}
          {project?.name ?? "No project"}
          {session.subtitle ? ` | ${session.subtitle}` : ""}
        </Text>
      </Text>
      {connection && <Text color="yellow">{connection}</Text>}
      <Box flexDirection="column" height={tailRows}>
        {tail.map((l, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity
          <Text key={i} {...STYLE_COLORS[l.style]} wrap="truncate-end">
            {l.text || " "}
          </Text>
        ))}
      </Box>
      {current && ui && (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={focus === "interaction" ? "magenta" : "gray"}
          paddingX={1}
        >
          <Text bold color="magenta" wrap="truncate-end">
            Needs your answer: {current.title}
            {pending.length > 1 ? ` (+${pending.length - 1} more)` : ""}
          </Text>
          {bodyLines.map((l, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity
            <Text key={`b${i}`} wrap="truncate-end">
              {l || " "}
            </Text>
          ))}
          {answerLines.map((l, i) => (
            <Text
              // biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity
              key={`c${i}`}
              wrap="truncate-end"
              color={
                l.kind === "error"
                  ? "red"
                  : l.focused && focus === "interaction"
                    ? "cyan"
                    : undefined
              }
              dimColor={l.kind === "hint"}
            >
              {l.text}
            </Text>
          ))}
        </Box>
      )}
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={focus === "composer" ? "cyan" : "gray"}
        paddingX={1}
      >
        {disabled ? (
          <Text dimColor>{disabled}</Text>
        ) : (
          draftLines.slice(-6).map((l, i, arr) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity
            <Text key={i} wrap="truncate-start">
              {i === 0 && arr.length === draftLines.length ? "> " : "  "}
              {l}
              {i === arr.length - 1 && focus === "composer" ? "_" : ""}
            </Text>
          ))
        )}
      </Box>
      {confirmStop && (
        <Text color="red">
          Stop execution of "{session.title}"? This aborts the run and clears queued messages. (y/N)
        </Text>
      )}
      {flashLine}
      <Text dimColor wrap="truncate-end">
        {statusLine(state, session)}
      </Text>
      <Text dimColor wrap="truncate-end">
        {working ? "Working... | " : ""}
        {hint} | Ctrl+T{" "}
        {sessionRun(state, session)?.controlMode === "human" ? "return to automation" : "take over"}{" "}
        | Ctrl+X stop | Esc back | ? help
      </Text>
    </Box>
  );
}

export interface RunTerminalOptions {
  coordinatorUrl: string;
  credential: string;
  sessionId?: string;
  fetch?: FetchLike;
}

/**
 * Run the interactive terminal client until the user quits (Ctrl+C) or the device is signed
 * out. Quitting only detaches: sessions keep running on their hosts.
 */
export async function runTerminal(opts: RunTerminalOptions): Promise<TerminalResult> {
  const client = new SwitchyardClient({
    coordinatorUrl: opts.coordinatorUrl,
    credential: opts.credential,
    fetch: opts.fetch,
  });
  client.connect();
  let result: TerminalResult = { reason: "quit" };
  const instance = render(
    <App
      client={client}
      initialSessionId={opts.sessionId}
      onExit={(r) => {
        result = r;
      }}
    />,
    { exitOnCtrlC: false },
  );
  try {
    await instance.waitUntilExit();
  } finally {
    client.close();
  }
  const final = result as TerminalResult;
  if (final.reason === "quit") {
    process.stdout.write("Detached. Sessions keep running on their hosts.\n");
  } else {
    process.stderr.write(`Signed out: ${final.message}\n`);
  }
  return final;
}

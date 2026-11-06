import type { Session } from "@switchyard/protocol";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { cn } from "../../lib/cn";
import {
  applyModifiers,
  fitFontSize,
  fromBase64,
  KEY_BAR,
  terminalSocketUrl,
  toBase64,
} from "./terminalKeys";

interface Size {
  cols: number;
  rows: number;
  owner: boolean;
}

/** Pi's terminal in the browser: output, typing, a key bar for touch screens, size ownership. */
export function TerminalView({ session }: { session: Session }) {
  const box = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const sizeRef = useRef<Size>({ cols: 80, rows: 24, owner: false });
  const mods = useRef({ ctrl: false, alt: false });
  const [size, setSize] = useState<Size>({ cols: 80, rows: 24, owner: false });
  const [ctrl, setCtrl] = useState(false);
  const [alt, setAlt] = useState(false);
  const [closed, setClosed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

  const send = useCallback((msg: object) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);
  const sendInput = useCallback(
    (data: string) => {
      send({ t: "in", d: toBase64(applyModifiers(data, mods.current)) });
      mods.current = { ctrl: false, alt: false };
      setCtrl(false);
      setAlt(false);
    },
    [send],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: reconnect on attempt or session change
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    setClosed(null);
    const term = new Terminal({
      fontSize: 13,
      scrollback: 5000,
      cursorBlink: true,
      fontFamily:
        getComputedStyle(document.documentElement).getPropertyValue("--font-mono") || "monospace",
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    termRef.current = term;
    fitRef.current = fit;
    const dims = fit.proposeDimensions();
    const cols = Math.max(10, dims?.cols ?? 80);
    const rows = Math.max(5, dims?.rows ?? 24);
    const ws = new WebSocket(terminalSocketUrl(location, session.id, cols, rows));
    wsRef.current = ws;

    const cellWidth = () => {
      const w = (
        term as unknown as {
          _core?: { _renderService?: { dimensions?: { css?: { cell?: { width?: number } } } } };
        }
      )._core?._renderService?.dimensions?.css?.cell?.width;
      return typeof w === "number" && w > 0 ? w : 7.8;
    };
    const applySize = (s: Size) => {
      sizeRef.current = s;
      setSize(s);
      if (s.owner) {
        term.options.fontSize = 13;
        fit.fit();
      } else {
        term.options.fontSize = 13;
        term.resize(s.cols, s.rows);
        term.options.fontSize = fitFontSize(el.clientWidth, s.cols, cellWidth());
      }
    };
    ws.onmessage = (ev) => {
      let msg: {
        t?: string;
        d?: string;
        reason?: string;
        cols?: number;
        rows?: number;
        owner?: boolean;
      };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.t === "out" && msg.d) term.write(fromBase64(msg.d));
      else if (msg.t === "size" && msg.cols && msg.rows) {
        applySize({ cols: msg.cols, rows: msg.rows, owner: msg.owner === true });
      } else if (msg.t === "closed") setClosed(msg.reason ?? "closed");
    };
    ws.onclose = () => setClosed((c) => c ?? "connection lost");
    const data = term.onData((d) => sendInput(d));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      if (sizeRef.current.owner) {
        clearTimeout(timer);
        timer = setTimeout(() => {
          fit.fit();
          send({ t: "resize", cols: term.cols, rows: term.rows });
        }, 100);
      } else {
        term.options.fontSize = fitFontSize(el.clientWidth, sizeRef.current.cols, cellWidth());
      }
    });
    ro.observe(el);
    return () => {
      clearTimeout(timer);
      ro.disconnect();
      data.dispose();
      ws.onclose = null;
      ws.close();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      wsRef.current = null;
    };
  }, [session.id, attempt]);

  const claim = () => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    term.options.fontSize = 13;
    fit.fit();
    send({ t: "claim" });
    send({ t: "resize", cols: term.cols, rows: term.rows });
  };
  const keep = (e: React.PointerEvent) => e.preventDefault();

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-bg" data-testid="terminal-view">
      <div
        data-testid="terminal-toolbar"
        className="flex shrink-0 items-center gap-3 border-b border-border px-3 py-1.5 text-xs text-muted"
      >
        <span>
          {size.cols}×{size.rows}
        </span>
        {size.owner ? (
          <span>Sized for this screen</span>
        ) : (
          <Button size="sm" onClick={claim}>
            Fit to this screen
          </Button>
        )}
        {closed && (
          <>
            <span className="text-danger">Terminal closed: {closed}</span>
            <Button size="sm" onClick={() => setAttempt((n) => n + 1)}>
              Reconnect
            </Button>
          </>
        )}
      </div>
      <div ref={box} className="min-h-0 min-w-0 flex-1 overflow-hidden bg-black p-1" />
      {coarse && (
        <div
          data-testid="terminal-keybar"
          className="flex shrink-0 flex-wrap gap-1 border-t border-border bg-surface p-1"
        >
          {KEY_BAR.map((k) => (
            <Button key={k.label} size="sm" onPointerDown={keep} onClick={() => sendInput(k.data)}>
              {k.label}
            </Button>
          ))}
          {(["ctrl", "alt"] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={m === "ctrl" ? ctrl : alt}
              onPointerDown={keep}
              onClick={() => {
                mods.current = { ...mods.current, [m]: !mods.current[m] };
                if (m === "ctrl") setCtrl(mods.current.ctrl);
                else setAlt(mods.current.alt);
              }}
              className={cn(
                "tap rounded-md border border-border px-3 text-sm",
                (m === "ctrl" ? ctrl : alt) && "bg-accent text-accent-fg",
              )}
            >
              {m === "ctrl" ? "Ctrl" : "Alt"}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

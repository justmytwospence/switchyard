import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "../../components/ui/Toast";

/** The slice of the Web Speech API used here; lib.dom does not declare it. */
export interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechResultEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}

interface SpeechResultEvent {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
}

export function speechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Insert dictated text at the caret, adding a space on each side when it would touch a word. */
export function spliceAtCaret(
  text: string,
  start: number,
  end: number,
  insert: string,
): { text: string; caret: number } {
  const ins = insert.trim();
  if (!ins) return { text, caret: start };
  const before = text.slice(0, start);
  const after = text.slice(end);
  const lead = before !== "" && !/\s$/.test(before) ? " " : "";
  const trail = after !== "" && !/^\s/.test(after) ? " " : "";
  const added = lead + ins + trail;
  return {
    text: before + added + after,
    caret: before.length + lead.length + ins.length + trail.length,
  };
}

export function useDictation(opts: { onFinal: (text: string) => void }) {
  const ctor = speechRecognitionCtor();
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const rec = useRef<SpeechRecognitionLike | null>(null);
  const onFinal = useRef(opts.onFinal);
  onFinal.current = opts.onFinal;

  const stop = useCallback(() => {
    rec.current?.stop();
  }, []);

  const start = useCallback(() => {
    if (!ctor || rec.current) return;
    const r = new ctor();
    r.continuous = true;
    r.interimResults = true;
    r.lang = navigator.language;
    r.onresult = (e) => {
      let live = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const t = res?.[0]?.transcript ?? "";
        if (res?.isFinal) onFinal.current(t);
        else live += t;
      }
      setInterim(live);
    };
    r.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        toast.error("Microphone access is blocked for this site");
      } else if (e.error !== "no-speech" && e.error !== "aborted") {
        toast.error(`Dictation stopped: ${e.error}`);
      }
    };
    r.onend = () => {
      rec.current = null;
      setListening(false);
      setInterim("");
    };
    rec.current = r;
    setListening(true);
    try {
      r.start();
    } catch {
      rec.current = null;
      setListening(false);
    }
  }, [ctor]);

  useEffect(() => () => rec.current?.abort(), []);

  return { supported: ctor !== null, listening, interim, start, stop };
}

import type { CompletionItem } from "@switchyard/protocol";
import { useEffect, useState } from "react";
import { codeApi } from "./api";
import { completionEligible } from "./model";

interface State {
  for: string;
  items: CompletionItem[];
  prefix: string;
}
const EMPTY: State = { for: "", items: [], prefix: "" };

/** Pi's argument completions for `/command arg`, debounced; empty when unavailable. */
export function useArgumentCompletions(
  sessionId: string,
  draft: string,
  enabled: boolean,
): { items: CompletionItem[]; prefix: string } {
  const [state, setState] = useState<State>(EMPTY);
  useEffect(() => {
    if (!enabled || !completionEligible(draft)) {
      setState(EMPTY);
      return;
    }
    const ac = new AbortController();
    const timer = setTimeout(() => {
      codeApi
        .complete(sessionId, draft, ac.signal)
        .then((r) => {
          if (!ac.signal.aborted) setState({ for: draft, items: r.items, prefix: r.prefix });
        })
        .catch(() => {
          if (!ac.signal.aborted) setState(EMPTY);
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      ac.abort();
    };
  }, [sessionId, draft, enabled]);
  if (state.for !== draft) return { items: [], prefix: "" };
  return { items: state.items.filter((i) => i.value !== state.prefix), prefix: state.prefix };
}

import { type MouseEvent, useCallback } from "react";
import { useLocation, useNavigate } from "react-router";

/** Location state set by in-app links whose page is the natural Back target of the page they open. */
export const BACK_STATE = { syBack: true } as const;

export function hasBackState(state: unknown): boolean {
  return (
    typeof state === "object" && state !== null && (state as { syBack?: unknown }).syBack === true
  );
}

/** Pop history when opened from the in-app parent; otherwise replace with `fallback` (never push). */
export function useBackTo(fallback: string): () => void {
  const navigate = useNavigate();
  const { state } = useLocation();
  return useCallback(() => {
    if (hasBackState(state)) navigate(-1);
    else navigate(fallback, { replace: true });
  }, [navigate, state, fallback]);
}

/** onClick for a `<Link to={fallback}>` Back link; modified clicks stay native. */
export function backLinkClick(back: () => void) {
  return (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return;
    }
    e.preventDefault();
    back();
  };
}

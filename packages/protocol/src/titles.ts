/** Placeholder title of a session created without a prompt (coordinator). */
export const NEW_SESSION_TITLE = "New session";
/** Placeholder title of a session first seen from a host without a name. */
export const UNTITLED_SESSION_TITLE = "Untitled session";

/** Whether `t` is one of the placeholder titles, so the first prompt may name the session. */
export function isPlaceholderTitle(t: string): boolean {
  return t === NEW_SESSION_TITLE || t === UNTITLED_SESSION_TITLE;
}

/** First line of a prompt as a title (80 chars max: 77 + "..."); `fallback` when blank. */
export function titleFrom(prompt: string, fallback = NEW_SESSION_TITLE): string {
  const line = prompt.trim().split("\n")[0]?.trim() ?? "";
  if (!line) return fallback;
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

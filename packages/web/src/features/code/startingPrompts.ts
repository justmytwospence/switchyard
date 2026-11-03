const prompts = new Map<string, string>();

/** The first prompt of a session being created, shown while it starts. */
export function rememberInitialPrompt(sessionId: string, text: string): void {
  if (text.trim()) prompts.set(sessionId, text);
}

export function initialPromptFor(sessionId: string): string | null {
  return prompts.get(sessionId) ?? null;
}

/**
 * Model and thinking-level helpers shared by the Switchyard Pi extensions and `ManagedSession`.
 * Imports nothing, so it can be loaded by Pi next to the extensions.
 */

/** Pi 1.4's thinking levels (pi-ai EXTENDED_THINKING_LEVELS), in order. */
export const PI_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export interface PiModelInfo {
  provider: string;
  id: string;
  name: string | null;
  contextWindow: number | null;
  reasoning: boolean;
  thinkingLevels: string[];
}

/** Pi 1.4 `getSupportedThinkingLevels` (pi-ai dist/models.js:693); passes through an already-mapped `thinkingLevels`. */
export function supportedThinkingLevels(model: any): string[] {
  const known = PI_THINKING_LEVELS as readonly string[];
  if (Array.isArray(model?.thinkingLevels)) {
    return model.thinkingLevels.filter((l: unknown) => typeof l === "string" && known.includes(l));
  }
  if (!model?.reasoning) return ["off"];
  return PI_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

export function modelInfo(model: any): PiModelInfo | null {
  if (!model || typeof model.provider !== "string" || typeof model.id !== "string") return null;
  return {
    provider: model.provider,
    id: model.id,
    name: typeof model.name === "string" && model.name ? model.name : null,
    contextWindow: typeof model.contextWindow === "number" ? model.contextWindow : null,
    reasoning: model.reasoning === true,
    thinkingLevels: supportedThinkingLevels(model),
  };
}

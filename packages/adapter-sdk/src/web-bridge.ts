import type { UINode } from "@switchyard/protocol";
import { z } from "zod";

/**
 * Messages between the web client and a custom adapter renderer running in an isolated
 * `<iframe sandbox="allow-scripts">` (no allow-same-origin, no credentials). The parent posts
 * `render`; the frame posts `action` and `resize`. Parents must validate every frame message
 * with `parseFrameMessage` and forward actions only through the adapter action API.
 */

export interface RenderMessage {
  type: "render";
  node: UINode | null;
  state: unknown;
}
export type ParentToFrameMessage = RenderMessage;

export interface FrameActionMessage {
  type: "action";
  actionId: string;
  payload?: unknown;
}
export interface FrameResizeMessage {
  type: "resize";
  height: number;
}
export type FrameToParentMessage = FrameActionMessage | FrameResizeMessage;

export const FRAME_MAX_HEIGHT = 4000;

export const FrameToParentMessageSchema: z.ZodType<FrameToParentMessage> = z.discriminatedUnion(
  "type",
  [
    z.object({
      type: z.literal("action"),
      actionId: z.string().min(1).max(200),
      payload: z.unknown().optional(),
    }),
    z.object({
      type: z.literal("resize"),
      height: z.number().finite().min(0).max(FRAME_MAX_HEIGHT),
    }),
  ],
);

/** Validate a message received from a frame; undefined when it is not a bridge message. */
export function parseFrameMessage(data: unknown): FrameToParentMessage | undefined {
  const r = FrameToParentMessageSchema.safeParse(data);
  return r.success ? r.data : undefined;
}

export function renderMessage(node: UINode | null, state: unknown): RenderMessage {
  return { type: "render", node, state };
}

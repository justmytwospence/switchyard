import { z } from "zod";

/**
 * Terminal relay frames. A viewer (`switchyard tui`, the herdr integration) talks to the
 * coordinator on `/ws/terminal/:sessionId`; the coordinator wraps the same messages in `term`
 * frames with a stream id on the host link; the host pipes them to the session's terminal holder.
 * Bytes travel base64 encoded.
 */
const Cols = z.number().int().min(10).max(1000);
const Rows = z.number().int().min(5).max(500);

export const TermViewerToServer = z.discriminatedUnion("t", [
  z.object({ t: z.literal("in"), d: z.string() }),
  z.object({ t: z.literal("resize"), cols: Cols, rows: Rows }),
]);
export type TermViewerToServer = z.infer<typeof TermViewerToServer>;

export const TermServerToViewer = z.discriminatedUnion("t", [
  z.object({ t: z.literal("out"), d: z.string() }),
  z.object({ t: z.literal("closed"), reason: z.string() }),
]);
export type TermServerToViewer = z.infer<typeof TermServerToViewer>;

export const TermCoordinatorMsg = z.discriminatedUnion("t", [
  z.object({ t: z.literal("open"), sessionId: z.string(), cols: Cols, rows: Rows }),
  z.object({ t: z.literal("in"), d: z.string() }),
  z.object({ t: z.literal("resize"), cols: Cols, rows: Rows }),
  z.object({ t: z.literal("close") }),
]);
export type TermCoordinatorMsg = z.infer<typeof TermCoordinatorMsg>;

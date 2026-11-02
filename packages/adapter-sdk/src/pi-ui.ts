import { z } from "zod";

/**
 * Pi RPC extension UI dialog requests (`extension_ui_request` with a dialog method) and their
 * responses (`extension_ui_response`), as documented in Pi's `rpc-extension-ui.md`.
 * Fire-and-forget methods (notify, setStatus, setWidget, setTitle, set_editor_text) are not
 * dialogs and are delivered to adapters through dedicated hooks instead.
 */

export type PiUiMethod = "select" | "confirm" | "input" | "editor";
export const PI_UI_METHODS: readonly PiUiMethod[] = ["select", "confirm", "input", "editor"];

export type PiUiRequest =
  | { id: string; method: "select"; title: string; options: string[]; timeout?: number }
  | { id: string; method: "confirm"; title: string; message: string; timeout?: number }
  | { id: string; method: "input"; title: string; placeholder?: string; timeout?: number }
  | { id: string; method: "editor"; title: string; prefill?: string };

export type PiUiResponse = { value: string } | { confirmed: boolean } | { cancelled: true };

export const PiUiRequestSchema: z.ZodType<PiUiRequest> = z.discriminatedUnion("method", [
  z.object({
    id: z.string(),
    method: z.literal("select"),
    title: z.string(),
    options: z.array(z.string()),
    timeout: z.number().optional(),
  }),
  z.object({
    id: z.string(),
    method: z.literal("confirm"),
    title: z.string(),
    message: z.string(),
    timeout: z.number().optional(),
  }),
  z.object({
    id: z.string(),
    method: z.literal("input"),
    title: z.string(),
    placeholder: z.string().optional(),
    timeout: z.number().optional(),
  }),
  z.object({
    id: z.string(),
    method: z.literal("editor"),
    title: z.string(),
    prefill: z.string().optional(),
  }),
]);

export const PiUiResponseSchema: z.ZodType<PiUiResponse> = z.union([
  z.object({ value: z.string() }).strict(),
  z.object({ confirmed: z.boolean() }).strict(),
  z.object({ cancelled: z.literal(true) }).strict(),
]);

/** Parse a raw `extension_ui_request` frame; returns undefined for non-dialog methods. */
export function parsePiUiRequest(raw: unknown): PiUiRequest | undefined {
  const r = PiUiRequestSchema.safeParse(raw);
  return r.success ? r.data : undefined;
}

/**
 * Whether a response is acceptable for a request: `{value}` for select/input/editor (and for a
 * select, the value must be one of the offered options), `{confirmed}` for confirm, and
 * `{cancelled: true}` for any dialog.
 */
export function responseFitsRequest(req: PiUiRequest, resp: PiUiResponse): boolean {
  if (!PiUiResponseSchema.safeParse(resp).success) return false;
  if ("cancelled" in resp) return true;
  if (req.method === "confirm") return "confirmed" in resp;
  if (!("value" in resp)) return false;
  if (req.method === "select") return req.options.includes(resp.value);
  return true;
}

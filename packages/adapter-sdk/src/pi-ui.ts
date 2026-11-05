import { z } from "zod";

/**
 * Pi RPC extension UI dialog requests (`extension_ui_request` with a dialog method) and their
 * responses (`extension_ui_response`), as documented in Pi's `rpc-extension-ui.md`.
 * Fire-and-forget methods (notify, setStatus, setWidget, setTitle, set_editor_text) are not
 * dialogs and are delivered to adapters through dedicated hooks instead.
 */

export type PiUiMethod = "select" | "confirm" | "input" | "editor";

export type PiUiRequest =
  | { id: string; method: "select"; title: string; options: string[]; timeout?: number }
  | { id: string; method: "confirm"; title: string; message: string; timeout?: number }
  | { id: string; method: "input"; title: string; placeholder?: string; timeout?: number }
  | { id: string; method: "editor"; title: string; prefill?: string };

/** `cancelled` is Pi's RPC spelling. */
export type PiUiResponse = { value: string } | { confirmed: boolean } | { cancelled: true };

export const PiUiResponseSchema: z.ZodType<PiUiResponse> = z.union([
  z.object({ value: z.string() }).strict(),
  z.object({ confirmed: z.boolean() }).strict(),
  z.object({ cancelled: z.literal(true) }).strict(),
]);

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

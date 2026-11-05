import type { FormValue, InteractionResponse, UINode } from "@switchyard/protocol";
import { ui } from "@switchyard/protocol";
import type { PiUiRequest, PiUiResponse } from "./pi-ui.js";
import { type Claim, InteractionResponseError } from "./types.js";

export const GENERIC_FORM_ID = "generic";
export const GENERIC_FIELD = "value";
const TITLE_MAX = 200;

function splitTitle(title: string): { head: string; rest: string } {
  const trimmed = title.trim();
  const nl = trimmed.indexOf("\n");
  const head = (nl === -1 ? trimmed : trimmed.slice(0, nl)).trim();
  const rest = nl === -1 ? "" : trimmed.slice(nl + 1).trim();
  return {
    head: head.length > TITLE_MAX ? `${head.slice(0, TITLE_MAX - 3)}...` : head || "Question",
    rest,
  };
}

function formValue(resp: InteractionResponse): FormValue | undefined {
  if (resp.kind !== "form") {
    throw new InteractionResponseError(`expected a form answer, got ${resp.kind}`);
  }
  return resp.values[GENERIC_FIELD];
}

function textValue(v: FormValue | undefined): string {
  if (typeof v === "string") return v;
  if (v && !Array.isArray(v) && typeof v.other === "string") return v.other;
  if (v === undefined) return "";
  throw new InteractionResponseError("expected a single text value");
}

/** The generic renderer for any dialog no adapter claimed. */
export function genericClaim(req: PiUiRequest): Claim {
  const { head, rest } = splitTitle(req.title);
  const wrap = (node: UINode): UINode =>
    rest ? { t: "section", children: [ui.text(req.title.trim()), node] } : node;

  switch (req.method) {
    case "select":
      return {
        title: head,
        presentation: wrap({
          t: "form",
          formId: GENERIC_FORM_ID,
          fields: [
            {
              kind: "select",
              name: GENERIC_FIELD,
              label: head,
              options: req.options.map((o) => ({ value: o, label: o })),
            },
          ],
          submitLabel: "Submit",
          cancelLabel: "Cancel",
        }),
        toPiResponse(resp): PiUiResponse {
          if (resp.kind === "cancel") return { cancelled: true };
          const v = formValue(resp);
          if (typeof v !== "string" || !req.options.includes(v)) {
            throw new InteractionResponseError("choose one of the offered options");
          }
          return { value: v };
        },
      };
    case "confirm":
      return {
        title: head,
        presentation: wrap({
          t: "confirm",
          message: req.message,
          confirmLabel: "Yes",
          cancelLabel: "No",
        }),
        toPiResponse(resp): PiUiResponse {
          if (resp.kind === "cancel") return { cancelled: true };
          if (resp.kind !== "confirm") {
            throw new InteractionResponseError(`expected a confirm answer, got ${resp.kind}`);
          }
          return { confirmed: resp.confirmed };
        },
      };
    case "input":
    case "editor": {
      const multiline = req.method === "editor";
      return {
        title: head,
        presentation: wrap({
          t: "form",
          formId: GENERIC_FORM_ID,
          fields: [
            {
              kind: "text",
              name: GENERIC_FIELD,
              label: head,
              ...(req.method === "input" && req.placeholder
                ? { placeholder: req.placeholder }
                : {}),
              ...(multiline ? { multiline: true } : {}),
              ...(req.method === "editor" && req.prefill !== undefined
                ? { prefill: req.prefill }
                : {}),
            },
          ],
          submitLabel: "Submit",
          cancelLabel: "Cancel",
        }),
        toPiResponse(resp): PiUiResponse {
          if (resp.kind === "cancel") return { cancelled: true };
          return { value: textValue(formValue(resp)) };
        },
      };
    }
  }
}

/** Generic status panel: a key/text table of `setStatus` entries, or null when empty. */
export function genericStatusPanel(statuses: Map<string, string>): UINode | null {
  if (statuses.size === 0) return null;
  return ui.table(
    ["Key", "Status"],
    [...statuses.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, v]),
  );
}

/** Generic widget panel: the widget's text lines, or null when cleared. */
export function genericWidgetPanel(lines: string[] | undefined): UINode | null {
  if (!lines || lines.length === 0) return null;
  return ui.code(lines.join("\n"));
}

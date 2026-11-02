import type { FormValue, InteractionResponse, UINode } from "@switchyard/protocol";
import { ui } from "@switchyard/protocol";
import type { PiUiRequest, PiUiResponse } from "./pi-ui.js";
import { type Claim, InteractionResponseError, type ToolInfo } from "./types.js";

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

const ARGS_MAX = 4000;
const OUTPUT_MAX = 8000;

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n... (${s.length - max} more characters)` : s;
}

/** Text of a Pi tool result (`{content: [{type: "text", text}]}`), or JSON for anything else. */
export function toolResultText(result: unknown): string {
  if (result === undefined || result === null) return "";
  if (typeof result === "string") return result;
  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (c && typeof c === "object" && (c as { type?: unknown }).type === "text") {
          return String((c as { text?: unknown }).text ?? "");
        }
        if (c && typeof c === "object" && (c as { type?: unknown }).type === "image") {
          return "[image]";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

/** Generic tool card: name, status, arguments and output. */
export function genericToolCard(tool: ToolInfo): UINode {
  const finished = tool.result !== undefined || tool.isError !== undefined;
  const status = !finished ? "running" : tool.isError ? "error" : "ok";
  let args: string;
  try {
    args = JSON.stringify(tool.args ?? {}, null, 2);
  } catch {
    args = String(tool.args);
  }
  const children: UINode[] = [
    ui.progress(
      status === "running" ? "Running" : status === "ok" ? "Done" : "Failed",
      undefined,
      status,
    ),
    {
      t: "section",
      title: "Arguments",
      collapsible: true,
      children: [ui.code(truncate(args, ARGS_MAX), "json")],
    },
  ];
  if (finished) {
    const out = toolResultText(tool.result);
    children.push({
      t: "section",
      title: "Output",
      collapsible: true,
      children: [out ? ui.code(truncate(out, OUTPUT_MAX)) : ui.text("(no output)", "muted")],
    });
  }
  return { t: "section", title: tool.name, children };
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

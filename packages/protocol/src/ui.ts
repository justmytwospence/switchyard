import { z } from "zod";
import { SwitchyardError } from "./errors.js";

/** Portable UI components rendered by every client (web, mobile, terminal). */

export type Tone = "default" | "muted" | "success" | "warning" | "danger";
export type ActionTone = "default" | "primary" | "danger";

export interface ShowIf {
  field: string;
  values: string[];
}

export interface FieldOption {
  value: string;
  label: string;
  description?: string;
  preview?: string;
}

export type Field =
  | {
      kind: "select";
      name: string;
      label: string;
      options: FieldOption[];
      allowOther?: { label: string; placeholder?: string };
      showIf?: ShowIf;
    }
  | {
      kind: "multiselect";
      name: string;
      label: string;
      options: FieldOption[];
      allowOther?: { label: string; placeholder?: string };
      min?: number;
      max?: number;
      showIf?: ShowIf;
    }
  | {
      kind: "text";
      name: string;
      label: string;
      placeholder?: string;
      multiline?: boolean;
      prefill?: string;
      showIf?: ShowIf;
    };

export type UIRef =
  | { kind: "file"; path: string }
  | { kind: "session"; sessionId: string }
  | { kind: "task"; taskId: string }
  | { kind: "native_session"; hostId: string; sessionFile: string };

export type UINode =
  | { t: "text"; text: string; tone?: Tone }
  | { t: "markdown"; text: string }
  | { t: "code"; text: string; lang?: string }
  | { t: "diff"; patch: string }
  | { t: "list"; items: UINode[]; ordered?: boolean }
  | { t: "table"; columns: string[]; rows: string[][] }
  | { t: "section"; title?: string; collapsible?: boolean; children: UINode[] }
  | { t: "tabs"; tabs: { id: string; label: string; children: UINode[] }[] }
  | { t: "progress"; label: string; value?: number; status?: "running" | "ok" | "error" }
  | { t: "ref"; ref: UIRef; label: string }
  | { t: "form"; formId: string; fields: Field[]; submitLabel: string; cancelLabel?: string }
  | {
      t: "confirm";
      message: string;
      confirmLabel: string;
      cancelLabel: string;
      destructive?: boolean;
    }
  | { t: "actions"; actions: { id: string; label: string; tone?: ActionTone }[] };

const ToneSchema = z.enum(["default", "muted", "success", "warning", "danger"]);
const ShowIfSchema = z.object({ field: z.string(), values: z.array(z.string()) });
const OptionSchema = z.object({
  value: z.string(),
  label: z.string(),
  description: z.string().optional(),
  preview: z.string().optional(),
});
const AllowOther = z.object({ label: z.string(), placeholder: z.string().optional() });

export const FieldSchema: z.ZodType<Field> = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("select"),
    name: z.string(),
    label: z.string(),
    options: z.array(OptionSchema),
    allowOther: AllowOther.optional(),
    showIf: ShowIfSchema.optional(),
  }),
  z.object({
    kind: z.literal("multiselect"),
    name: z.string(),
    label: z.string(),
    options: z.array(OptionSchema),
    allowOther: AllowOther.optional(),
    min: z.number().int().min(0).optional(),
    max: z.number().int().min(1).optional(),
    showIf: ShowIfSchema.optional(),
  }),
  z.object({
    kind: z.literal("text"),
    name: z.string(),
    label: z.string(),
    placeholder: z.string().optional(),
    multiline: z.boolean().optional(),
    prefill: z.string().optional(),
    showIf: ShowIfSchema.optional(),
  }),
]);

const RefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file"), path: z.string() }),
  z.object({ kind: z.literal("session"), sessionId: z.string() }),
  z.object({ kind: z.literal("task"), taskId: z.string() }),
  z.object({ kind: z.literal("native_session"), hostId: z.string(), sessionFile: z.string() }),
]);

export const UINodeSchema: z.ZodType<UINode> = z.lazy(() =>
  z.discriminatedUnion("t", [
    z.object({ t: z.literal("text"), text: z.string(), tone: ToneSchema.optional() }),
    z.object({ t: z.literal("markdown"), text: z.string() }),
    z.object({ t: z.literal("code"), text: z.string(), lang: z.string().optional() }),
    z.object({ t: z.literal("diff"), patch: z.string() }),
    z.object({
      t: z.literal("list"),
      items: z.array(UINodeSchema),
      ordered: z.boolean().optional(),
    }),
    z.object({
      t: z.literal("table"),
      columns: z.array(z.string()),
      rows: z.array(z.array(z.string())),
    }),
    z.object({
      t: z.literal("section"),
      title: z.string().optional(),
      collapsible: z.boolean().optional(),
      children: z.array(UINodeSchema),
    }),
    z.object({
      t: z.literal("tabs"),
      tabs: z.array(
        z.object({ id: z.string(), label: z.string(), children: z.array(UINodeSchema) }),
      ),
    }),
    z.object({
      t: z.literal("progress"),
      label: z.string(),
      value: z.number().min(0).max(1).optional(),
      status: z.enum(["running", "ok", "error"]).optional(),
    }),
    z.object({ t: z.literal("ref"), ref: RefSchema, label: z.string() }),
    z.object({
      t: z.literal("form"),
      formId: z.string(),
      fields: z.array(FieldSchema),
      submitLabel: z.string(),
      cancelLabel: z.string().optional(),
    }),
    z.object({
      t: z.literal("confirm"),
      message: z.string(),
      confirmLabel: z.string(),
      cancelLabel: z.string(),
      destructive: z.boolean().optional(),
    }),
    z.object({
      t: z.literal("actions"),
      actions: z.array(
        z.object({
          id: z.string(),
          label: z.string(),
          tone: z.enum(["default", "primary", "danger"]).optional(),
        }),
      ),
    }),
  ]),
) as z.ZodType<UINode>;

export const UI_MAX_DEPTH = 12;
export const UI_MAX_NODES = 2000;

function children(node: UINode): UINode[] {
  switch (node.t) {
    case "list":
      return node.items;
    case "section":
      return node.children;
    case "tabs":
      return node.tabs.flatMap((tab) => tab.children);
    default:
      return [];
  }
}

/** Parse and bound a UI tree. Throws SwitchyardError(ui_tree_too_large) past the limits. */
export function validateUINode(input: unknown): UINode {
  const node = UINodeSchema.parse(input);
  let count = 0;
  const walk = (n: UINode, depth: number) => {
    count++;
    if (depth > UI_MAX_DEPTH) {
      throw new SwitchyardError("ui_tree_too_large", `UI tree deeper than ${UI_MAX_DEPTH}`);
    }
    if (count > UI_MAX_NODES) {
      throw new SwitchyardError("ui_tree_too_large", `UI tree has more than ${UI_MAX_NODES} nodes`);
    }
    for (const c of children(n)) walk(c, depth + 1);
  };
  walk(node, 1);
  return node;
}

/** Whether a field with `showIf` is visible given current form values. */
export function isFieldVisible(
  field: Field,
  values: Record<string, FormValue | undefined>,
): boolean {
  if (!field.showIf) return true;
  const v = values[field.showIf.field];
  if (v === undefined) return false;
  if (typeof v === "string") return field.showIf.values.includes(v);
  if (Array.isArray(v)) return v.some((x) => field.showIf!.values.includes(x));
  return false;
}

export type FormValue = string | string[] | { other: string };
export const FormValueSchema: z.ZodType<FormValue> = z.union([
  z.string(),
  z.array(z.string()),
  z.object({ other: z.string() }),
]);

export const InteractionResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("form"), values: z.record(z.string(), FormValueSchema) }),
  z.object({ kind: z.literal("confirm"), confirmed: z.boolean() }),
  z.object({ kind: z.literal("action"), actionId: z.string() }),
  z.object({ kind: z.literal("cancel") }),
]);
export type InteractionResponse = z.infer<typeof InteractionResponseSchema>;

/** Small builders for adapters. */
export const ui = {
  text: (text: string, tone?: Tone): UINode =>
    tone ? { t: "text", text, tone } : { t: "text", text },
  markdown: (text: string): UINode => ({ t: "markdown", text }),
  code: (text: string, lang?: string): UINode =>
    lang ? { t: "code", text, lang } : { t: "code", text },
  diff: (patch: string): UINode => ({ t: "diff", patch }),
  list: (items: UINode[], ordered?: boolean): UINode => ({ t: "list", items, ordered }),
  table: (columns: string[], rows: string[][]): UINode => ({ t: "table", columns, rows }),
  section: (title: string | undefined, children: UINode[], collapsible?: boolean): UINode => ({
    t: "section",
    title,
    children,
    collapsible,
  }),
  progress: (label: string, value?: number, status?: "running" | "ok" | "error"): UINode => ({
    t: "progress",
    label,
    value,
    status,
  }),
  actions: (actions: { id: string; label: string; tone?: ActionTone }[]): UINode => ({
    t: "actions",
    actions,
  }),
};

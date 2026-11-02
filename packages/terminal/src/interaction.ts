import {
  type Field,
  type FormValue,
  type Interaction,
  type InteractionResponse,
  isFieldVisible,
  type UINode,
} from "@switchyard/protocol";
import { editText, type KeyPress } from "./keys.js";
import { findControl, uiToText } from "./uinode.js";

/**
 * Keyboard model for answering an interaction in the terminal.
 *
 * - select: Up/Down move, Enter chooses and advances. With `allowOther`, the last row is the
 *   Other entry: type to fill it, Enter commits it.
 * - multiselect: Up/Down move, Space toggles, Enter confirms the field and advances. Values are
 *   always chosen by toggling, never by typing a comma-separated list.
 * - text: type; Enter advances; Alt+Enter inserts a newline in multi-line fields.
 * - Tab / Shift+Tab move between fields. Enter on the last visible field submits.
 * - confirm: Left/Right (or y/n), Enter answers.
 * - actions: Up/Down/Left/Right, Enter runs the action.
 */

export interface FieldState {
  selected: string[];
  otherChosen: boolean;
  otherText: string;
  text: string;
}

export type Control = Extract<UINode, { t: "form" | "confirm" | "actions" }>;

export interface InteractionUi {
  interactionId: string;
  revision: number;
  control: Control | null;
  /** Read-only text of the presentation, without the control. */
  body: string[];
  /** Form: index into the visible fields; `visible.length` is the Submit/Cancel row. */
  fieldIndex: number;
  /** Row cursor inside the current select/multiselect, or button cursor. */
  cursor: number;
  values: Record<string, FieldState>;
  error: string | null;
}

export type InteractionStep =
  | { kind: "update"; ui: InteractionUi }
  | { kind: "submit"; ui: InteractionUi; response: InteractionResponse }
  | { kind: "none" };

export function initialInteractionUi(i: Interaction): InteractionUi {
  const control = findControl(i.presentation);
  const values: Record<string, FieldState> = {};
  if (control?.t === "form") {
    for (const f of control.fields) {
      values[f.name] = {
        selected: [],
        otherChosen: false,
        otherText: "",
        text: f.kind === "text" ? (f.prefill ?? "") : "",
      };
    }
  }
  return {
    interactionId: i.id,
    revision: i.revision,
    control,
    body: uiToText(i.presentation, control ?? undefined),
    fieldIndex: 0,
    cursor: 0,
    values,
    error: null,
  };
}

export function fieldValue(field: Field, st: FieldState | undefined): FormValue | undefined {
  if (!st) return undefined;
  switch (field.kind) {
    case "text":
      return st.text;
    case "select":
      if (st.otherChosen) return { other: st.otherText };
      return st.selected[0];
    case "multiselect": {
      const vals = [...st.selected];
      if (st.otherChosen && st.otherText.trim()) vals.push(st.otherText.trim());
      return vals;
    }
  }
}

/** Visible fields in order (`showIf` refers to earlier visible fields). */
export function visibleFields(fields: Field[], values: Record<string, FieldState>): Field[] {
  const vals: Record<string, FormValue | undefined> = {};
  const out: Field[] = [];
  for (const f of fields) {
    if (!isFieldVisible(f, vals)) continue;
    out.push(f);
    vals[f.name] = fieldValue(f, values[f.name]);
  }
  return out;
}

export function buildValues(
  fields: Field[],
  values: Record<string, FieldState>,
): Record<string, FormValue> {
  const out: Record<string, FormValue> = {};
  for (const f of visibleFields(fields, values)) {
    const v = fieldValue(f, values[f.name]);
    if (v !== undefined) out[f.name] = v;
  }
  return out;
}

/** Validation message for one field, or null. */
export function fieldError(field: Field, st: FieldState | undefined): string | null {
  if (!st) return null;
  if (field.kind === "select") {
    if (st.otherChosen) return st.otherText.trim() ? null : "Type a value for Other";
    return st.selected.length === 0 ? "Choose an option" : null;
  }
  if (field.kind === "multiselect") {
    const n = st.selected.length + (st.otherChosen && st.otherText.trim() ? 1 : 0);
    if (st.otherChosen && !st.otherText.trim()) return "Type a value for Other";
    if (field.min !== undefined && n < field.min) return `Choose at least ${field.min}`;
    if (field.max !== undefined && n > field.max) return `Choose at most ${field.max}`;
  }
  return null;
}

/** Number of rows of a select/multiselect field (options plus Other). */
export function rowCount(field: Field): number {
  if (field.kind === "text") return 0;
  return field.options.length + (field.allowOther ? 1 : 0);
}

function isOtherRow(field: Field, cursor: number): boolean {
  return field.kind !== "text" && !!field.allowOther && cursor === field.options.length;
}

function withField(ui: InteractionUi, name: string, st: FieldState): InteractionUi {
  return { ...ui, values: { ...ui.values, [name]: st }, error: null };
}

function moveTo(ui: InteractionUi, fieldIndex: number, fields: Field[]): InteractionUi {
  const visible = visibleFields(fields, ui.values);
  const idx = Math.max(0, Math.min(fieldIndex, visible.length));
  const f = visible[idx];
  let cursor = 0;
  if (f && f.kind === "select") {
    const st = ui.values[f.name];
    if (st?.otherChosen) cursor = f.options.length;
    else if (st?.selected[0])
      cursor = Math.max(
        0,
        f.options.findIndex((o) => o.value === st.selected[0]),
      );
  }
  return { ...ui, fieldIndex: idx, cursor };
}

function submitForm(ui: InteractionUi, form: Extract<UINode, { t: "form" }>): InteractionStep {
  const visible = visibleFields(form.fields, ui.values);
  for (let i = 0; i < visible.length; i++) {
    const f = visible[i]!;
    const err = fieldError(f, ui.values[f.name]);
    if (err)
      return { kind: "update", ui: { ...moveTo(ui, i, form.fields), error: `${f.label}: ${err}` } };
  }
  return {
    kind: "submit",
    ui,
    response: { kind: "form", values: buildValues(form.fields, ui.values) },
  };
}

/** After committing field `index`, go to the next visible field or submit. */
function advance(ui: InteractionUi, form: Extract<UINode, { t: "form" }>): InteractionStep {
  const visible = visibleFields(form.fields, ui.values);
  const cur = visible[ui.fieldIndex];
  if (cur) {
    const err = fieldError(cur, ui.values[cur.name]);
    if (err) return { kind: "update", ui: { ...ui, error: err } };
  }
  if (ui.fieldIndex + 1 >= visible.length) return submitForm(ui, form);
  return { kind: "update", ui: moveTo(ui, ui.fieldIndex + 1, form.fields) };
}

function formKey(
  ui: InteractionUi,
  form: Extract<UINode, { t: "form" }>,
  input: string,
  key: KeyPress,
): InteractionStep {
  const visible = visibleFields(form.fields, ui.values);
  if (key.tab) {
    const next = key.shift ? ui.fieldIndex - 1 : ui.fieldIndex + 1;
    return { kind: "update", ui: moveTo(ui, next, form.fields) };
  }
  const field = visible[ui.fieldIndex];
  if (!field) {
    // Submit / Cancel row.
    const buttons = form.cancelLabel ? 2 : 1;
    if (key.leftArrow || key.rightArrow) {
      return { kind: "update", ui: { ...ui, cursor: (ui.cursor + 1) % buttons } };
    }
    if (key.upArrow) return { kind: "update", ui: moveTo(ui, ui.fieldIndex - 1, form.fields) };
    if (key.return) {
      if (ui.cursor === 1) return { kind: "submit", ui, response: { kind: "cancel" } };
      return submitForm(ui, form);
    }
    return { kind: "none" };
  }
  const st = ui.values[field.name]!;
  if (field.kind === "text") {
    if (key.return && !(field.multiline && key.meta)) return advance(ui, form);
    const next = editText(st.text, input, key, { multiline: !!field.multiline });
    if (next === null) return { kind: "none" };
    return { kind: "update", ui: withField(ui, field.name, { ...st, text: next }) };
  }
  const rows = rowCount(field);
  if (key.upArrow) return { kind: "update", ui: { ...ui, cursor: (ui.cursor - 1 + rows) % rows } };
  if (key.downArrow) return { kind: "update", ui: { ...ui, cursor: (ui.cursor + 1) % rows } };
  const onOther = isOtherRow(field, ui.cursor);
  if (field.kind === "select") {
    if (key.return) {
      if (onOther) {
        const chosen = { ...st, selected: [], otherChosen: true };
        if (!st.otherChosen || !st.otherText.trim()) {
          return {
            kind: "update",
            ui: {
              ...withField(ui, field.name, chosen),
              error: st.otherChosen ? "Type a value for Other" : null,
            },
          };
        }
        return advance(withField(ui, field.name, chosen), form);
      }
      const opt = field.options[ui.cursor];
      if (!opt) return { kind: "none" };
      return advance(
        withField(ui, field.name, { ...st, selected: [opt.value], otherChosen: false }),
        form,
      );
    }
    if (onOther) {
      const next = editText(st.otherText, input, key, { multiline: false });
      if (next === null) return { kind: "none" };
      return {
        kind: "update",
        ui: withField(ui, field.name, { ...st, selected: [], otherChosen: true, otherText: next }),
      };
    }
    return { kind: "none" };
  }
  // multiselect
  if (key.return) return advance(ui, form);
  if (onOther) {
    if (input === " " && !st.otherText) {
      return {
        kind: "update",
        ui: withField(ui, field.name, { ...st, otherChosen: !st.otherChosen }),
      };
    }
    const next = editText(st.otherText, input, key, { multiline: false });
    if (next === null) return { kind: "none" };
    return {
      kind: "update",
      ui: withField(ui, field.name, { ...st, otherChosen: next.length > 0, otherText: next }),
    };
  }
  if (input === " " && !key.ctrl && !key.meta) {
    const opt = field.options[ui.cursor];
    if (!opt) return { kind: "none" };
    if (st.selected.includes(opt.value)) {
      return {
        kind: "update",
        ui: withField(ui, field.name, {
          ...st,
          selected: st.selected.filter((v) => v !== opt.value),
        }),
      };
    }
    const count = st.selected.length + (st.otherChosen ? 1 : 0);
    if (field.max !== undefined && count >= field.max) {
      return { kind: "update", ui: { ...ui, error: `Choose at most ${field.max}` } };
    }
    return {
      kind: "update",
      ui: withField(ui, field.name, { ...st, selected: [...st.selected, opt.value] }),
    };
  }
  return { kind: "none" };
}

/** Handle one key for an interaction. Returns the new UI state, or a response to submit. */
export function interactionKey(ui: InteractionUi, input: string, key: KeyPress): InteractionStep {
  const c = ui.control;
  if (!c) return { kind: "none" };
  if (c.t === "form") return formKey(ui, c, input, key);
  if (c.t === "confirm") {
    if (key.leftArrow || key.rightArrow || key.tab) {
      return { kind: "update", ui: { ...ui, cursor: ui.cursor === 0 ? 1 : 0 } };
    }
    if (input === "y" || input === "Y") {
      return { kind: "submit", ui, response: { kind: "confirm", confirmed: true } };
    }
    if (input === "n" || input === "N") {
      return { kind: "submit", ui, response: { kind: "confirm", confirmed: false } };
    }
    if (key.return) {
      return { kind: "submit", ui, response: { kind: "confirm", confirmed: ui.cursor === 0 } };
    }
    return { kind: "none" };
  }
  const n = c.actions.length;
  if (n === 0) return { kind: "none" };
  if (key.leftArrow || key.upArrow || (key.tab && key.shift)) {
    return { kind: "update", ui: { ...ui, cursor: (ui.cursor - 1 + n) % n } };
  }
  if (key.rightArrow || key.downArrow || key.tab) {
    return { kind: "update", ui: { ...ui, cursor: (ui.cursor + 1) % n } };
  }
  if (key.return) {
    const a = c.actions[ui.cursor];
    if (!a) return { kind: "none" };
    return { kind: "submit", ui, response: { kind: "action", actionId: a.id } };
  }
  return { kind: "none" };
}

/** Whether a key on this interaction is text entry (so `?` and similar should not be global). */
export function isTyping(ui: InteractionUi): boolean {
  const c = ui.control;
  if (c?.t !== "form") return false;
  const f = visibleFields(c.fields, ui.values)[ui.fieldIndex];
  if (!f) return false;
  return f.kind === "text" || isOtherRow(f, ui.cursor);
}

export interface ControlLine {
  text: string;
  focused: boolean;
  kind: "label" | "row" | "button" | "input" | "error" | "hint";
}

/** Lines describing the control with the current focus, for rendering. */
export function controlLines(ui: InteractionUi): ControlLine[] {
  const c = ui.control;
  const out: ControlLine[] = [];
  if (!c) {
    out.push({
      text: "No answer controls; answer this from the web app.",
      focused: false,
      kind: "hint",
    });
    return out;
  }
  if (c.t === "confirm") {
    out.push({ text: c.message, focused: false, kind: "label" });
    out.push({
      text: `${ui.cursor === 0 ? ">" : " "} [${c.confirmLabel}]   ${ui.cursor === 1 ? ">" : " "} [${c.cancelLabel}]`,
      focused: true,
      kind: "button",
    });
    out.push({ text: "Left/Right choose, Enter answers (y/n)", focused: false, kind: "hint" });
  } else if (c.t === "actions") {
    c.actions.forEach((a, i) => {
      out.push({
        text: `${i === ui.cursor ? ">" : " "} ${a.label}${a.tone === "danger" ? " (destructive)" : ""}`,
        focused: i === ui.cursor,
        kind: "row",
      });
    });
    out.push({ text: "Up/Down choose, Enter runs", focused: false, kind: "hint" });
  } else {
    const visible = visibleFields(c.fields, ui.values);
    visible.forEach((f, idx) => {
      const focused = idx === ui.fieldIndex;
      const st = ui.values[f.name]!;
      out.push({ text: `${focused ? ">" : " "} ${f.label}`, focused, kind: "label" });
      if (f.kind === "text") {
        const value = st.text || (focused ? "" : (f.placeholder ?? ""));
        const lines = value.split("\n");
        lines.forEach((l, i) => {
          out.push({
            text: `    ${l}${focused && i === lines.length - 1 ? "_" : ""}`,
            focused,
            kind: "input",
          });
        });
        return;
      }
      if (!focused) {
        const v = fieldValue(f, st);
        const shown =
          v === undefined
            ? "(not answered)"
            : typeof v === "string"
              ? labelOf(f, v)
              : Array.isArray(v)
                ? v.map((x) => labelOf(f, x)).join(", ") || "(none)"
                : `Other: ${v.other}`;
        out.push({ text: `    ${shown}`, focused: false, kind: "row" });
        return;
      }
      f.options.forEach((o, i) => {
        const mark =
          f.kind === "multiselect"
            ? st.selected.includes(o.value)
              ? "[x]"
              : "[ ]"
            : st.selected[0] === o.value && !st.otherChosen
              ? "(*)"
              : "( )";
        out.push({
          text: `  ${i === ui.cursor ? ">" : " "} ${mark} ${o.label}${o.description ? ` - ${o.description}` : ""}`,
          focused: i === ui.cursor,
          kind: "row",
        });
        if (i === ui.cursor && o.preview) {
          for (const p of o.preview.split("\n"))
            out.push({ text: `        ${p}`, focused: false, kind: "hint" });
        }
      });
      if (f.allowOther) {
        const onOther = ui.cursor === f.options.length;
        const mark =
          f.kind === "multiselect"
            ? st.otherChosen
              ? "[x]"
              : "[ ]"
            : st.otherChosen
              ? "(*)"
              : "( )";
        const text = st.otherText || (onOther ? "" : (f.allowOther.placeholder ?? ""));
        out.push({
          text: `  ${onOther ? ">" : " "} ${mark} ${f.allowOther.label || "Other"}: ${text}${onOther ? "_" : ""}`,
          focused: onOther,
          kind: "row",
        });
      }
      out.push({
        text:
          f.kind === "multiselect"
            ? "    Up/Down move, Space toggles, Enter confirms"
            : "    Up/Down move, Enter chooses",
        focused: false,
        kind: "hint",
      });
    });
    const onButtons = ui.fieldIndex >= visible.length;
    const submit = `${onButtons && ui.cursor === 0 ? ">" : " "} [${c.submitLabel}]`;
    const cancel = c.cancelLabel
      ? `   ${onButtons && ui.cursor === 1 ? ">" : " "} [${c.cancelLabel}]`
      : "";
    out.push({ text: submit + cancel, focused: onButtons, kind: "button" });
    out.push({ text: "Tab next field, Shift+Tab previous", focused: false, kind: "hint" });
  }
  if (ui.error) out.push({ text: ui.error, focused: false, kind: "error" });
  return out;
}

function labelOf(f: Field, value: string): string {
  if (f.kind === "text") return value;
  return f.options.find((o) => o.value === value)?.label ?? value;
}

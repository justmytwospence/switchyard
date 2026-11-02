import { type Field, type FormValue, isFieldVisible } from "@switchyard/protocol";

/**
 * Pure form state logic for FormRenderer (tested without a DOM).
 *
 * Each field keeps its raw UI state; `buildValues` turns it into the
 * submitted `InteractionResponse` values, omitting hidden fields.
 */

export interface FieldState {
  /** Selected option values (select: at most one). */
  selected: string[];
  /** "Other" chosen (select/multiselect with allowOther). */
  otherChosen: boolean;
  otherText: string;
  /** Text field value. */
  text: string;
}

export type FormState = Record<string, FieldState>;

export function initialFormState(fields: Field[]): FormState {
  const out: FormState = {};
  for (const f of fields) {
    out[f.name] = {
      selected: [],
      otherChosen: false,
      otherText: "",
      text: f.kind === "text" ? (f.prefill ?? "") : "",
    };
  }
  return out;
}

/** The value a field contributes, or undefined when nothing is chosen. */
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
      // Multiselect "other" text is submitted as an extra entry.
      if (st.otherChosen && st.otherText.trim()) vals.push(st.otherText.trim());
      return vals;
    }
  }
}

/**
 * Visible fields in order. `showIf` refers to an earlier field, so visibility
 * is evaluated against the values of fields that are themselves visible.
 */
export function visibleFields(fields: Field[], state: FormState): Field[] {
  const values: Record<string, FormValue | undefined> = {};
  const out: Field[] = [];
  for (const f of fields) {
    if (!isFieldVisible(f, values)) continue;
    out.push(f);
    values[f.name] = fieldValue(f, state[f.name]);
  }
  return out;
}

/** Submitted values: visible fields only. */
export function buildValues(fields: Field[], state: FormState): Record<string, FormValue> {
  const out: Record<string, FormValue> = {};
  for (const f of visibleFields(fields, state)) {
    const v = fieldValue(f, state[f.name]);
    if (v !== undefined) out[f.name] = v;
  }
  return out;
}

/** Validation errors keyed by field name (visible fields only). Empty when valid. */
export function validateForm(fields: Field[], state: FormState): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const f of visibleFields(fields, state)) {
    const st = state[f.name];
    if (!st) continue;
    if (f.kind === "select") {
      if (st.otherChosen) {
        if (!st.otherText.trim()) errors[f.name] = "Enter a value or choose an option";
      } else if (st.selected.length === 0) errors[f.name] = "Choose an option";
    } else if (f.kind === "multiselect") {
      const n = st.selected.length + (st.otherChosen && st.otherText.trim() ? 1 : 0);
      if (st.otherChosen && !st.otherText.trim()) errors[f.name] = "Enter a value for Other";
      else if (f.min !== undefined && n < f.min) errors[f.name] = `Choose at least ${f.min}`;
      else if (f.max !== undefined && n > f.max) errors[f.name] = `Choose at most ${f.max}`;
    }
  }
  return errors;
}

/** Choose an option of a select (clears "other"). */
export function chooseSelect(st: FieldState, value: string): FieldState {
  return { ...st, selected: [value], otherChosen: false };
}

/** Choose "other" on a select. */
export function chooseSelectOther(st: FieldState): FieldState {
  return { ...st, selected: [], otherChosen: true };
}

/** Toggle a multiselect option, respecting `max` (a toggle past max is ignored). */
export function toggleMulti(st: FieldState, value: string, max?: number): FieldState {
  if (st.selected.includes(value)) {
    return { ...st, selected: st.selected.filter((v) => v !== value) };
  }
  const count = st.selected.length + (st.otherChosen ? 1 : 0);
  if (max !== undefined && count >= max) return st;
  return { ...st, selected: [...st.selected, value] };
}

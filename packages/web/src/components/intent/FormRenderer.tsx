import type { Field, FieldOption, UINode } from "@switchyard/protocol";
import { Check } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { Button } from "../ui/Button";
import { TextArea, TextInput } from "../ui/TextArea";
import { useIntent } from "./context";
import {
  buildValues,
  chooseSelect,
  chooseSelectOther,
  type FieldState,
  type FormState,
  fieldAnswered,
  initialFormState,
  toggleMulti,
  validateForm,
  visibleFields,
} from "./formLogic";

type FormNode = Extract<UINode, { t: "form" }>;

export interface FormRendererProps {
  node: FormNode;
  className?: string;
}

/**
 * Structured question form. Selects render as radio cards, multiselects as
 * toggle cards (never comma-separated entry), `allowOther` adds a free-text
 * option, `showIf` hides dependent fields (omitted from the values).
 * Submits `{kind: "form", values}` through the IntentContext. In the request dock a form with
 * several questions shows one at a time, with numbered step chips.
 */
export function FormRenderer({ node, className }: FormRendererProps) {
  const { onRespond, busy, disabled, dock } = useIntent();
  const [state, setState] = useState<FormState>(() => initialFormState(node.fields));
  const [attempted, setAttempted] = useState(false);
  const [step, setStep] = useState(0);
  const visible = useMemo(() => visibleFields(node.fields, state), [node.fields, state]);
  const errors = useMemo(() => validateForm(node.fields, state), [node.fields, state]);
  const locked = disabled || busy;
  const setField = (name: string, fs: FieldState) => setState((s) => ({ ...s, [name]: fs }));
  const stepped = !!dock && visible.length > 1;
  const at = Math.min(step, visible.length - 1);
  const last = at === visible.length - 1;
  const shown = stepped ? visible.slice(at, at + 1) : visible;
  const formRef = useRef<HTMLFormElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  // A question in the dock: 1 to 9 pick an option of the question on screen. Picking the only
  // choice of the last question moves focus to Submit, so Enter sends it; nothing is sent by a
  // digit alone.
  const only = shown.length === 1 ? shown[0]! : null;
  const keyField = dock?.keys && !locked && only && only.kind !== "text" ? only : null;
  const keyState = keyField ? state[keyField.name] : undefined;
  useEffect(() => {
    if (!keyField || !keyState) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || !/^[1-9]$/.test(e.key))
        return;
      const form = formRef.current;
      // Hidden (another question is showing, or the dock is folded): not this form's key.
      if (!form || form.offsetParent === null) return;
      const t = e.target instanceof HTMLElement ? e.target : null;
      const typing =
        t !== null &&
        (t.isContentEditable ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          (t instanceof HTMLInputElement && t.type !== "radio" && t.type !== "checkbox"));
      if (typing) return;
      const option = keyField.options[Number(e.key) - 1];
      if (!option) return;
      e.preventDefault();
      if (keyField.kind === "multiselect") {
        setField(keyField.name, toggleMulti(keyState, option.value, keyField.max));
        return;
      }
      setField(keyField.name, chooseSelect(keyState, option.value));
      if (stepped && !last) setStep(at + 1);
      else submitRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  return (
    <form
      ref={formRef}
      className={cn("flex flex-col gap-4", className)}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        // Enter in a text field of an earlier step moves on instead of submitting.
        if (stepped && !last) {
          setStep(at + 1);
          return;
        }
        setAttempted(true);
        if (Object.keys(errors).length > 0) {
          if (stepped)
            setStep(
              Math.max(
                0,
                visible.findIndex((f) => errors[f.name]),
              ),
            );
          return;
        }
        if (locked) return;
        onRespond?.({ kind: "form", values: buildValues(node.fields, state) });
      }}
    >
      {stepped && (
        <ol aria-label="Questions" className="flex flex-wrap items-center gap-1">
          {visible.map((f, i) => (
            <li key={f.name}>
              <button
                type="button"
                aria-current={i === at ? "step" : undefined}
                aria-label={`Question ${i + 1} of ${visible.length}: ${f.label}`}
                onClick={() => setStep(i)}
                className={cn(
                  "tap inline-flex h-6 min-w-6 items-center justify-center rounded-full border px-1.5 text-xs tabular-nums",
                  i === at
                    ? "border-accent bg-accent-soft text-text"
                    : attempted && errors[f.name]
                      ? "border-danger text-danger"
                      : "border-border text-muted hover:bg-surface-2",
                )}
              >
                {i !== at && fieldAnswered(f, state[f.name]) ? (
                  <Check aria-hidden className="size-3" />
                ) : (
                  i + 1
                )}
              </button>
            </li>
          ))}
        </ol>
      )}
      {shown.map((f) => (
        <FieldView
          key={f.name}
          field={f}
          state={state[f.name]!}
          onChange={(fs) => setField(f.name, fs)}
          error={attempted ? errors[f.name] : undefined}
          disabled={locked}
          hideLabel={!!dock && f.label.trim() === dock.title.trim()}
          keycaps={keyField === f}
        />
      ))}
      {!disabled && (
        <div className="flex flex-wrap items-center gap-2">
          {stepped && at > 0 && (
            <Button type="button" variant="secondary" onClick={() => setStep(at - 1)}>
              Back
            </Button>
          )}
          {stepped && !last ? (
            <Button type="button" variant="primary" onClick={() => setStep(at + 1)}>
              Next
            </Button>
          ) : (
            <Button ref={submitRef} type="submit" variant="primary" busy={busy}>
              {node.submitLabel || "Submit"}
            </Button>
          )}
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() => onRespond?.({ kind: "cancel" })}
          >
            {node.cancelLabel || "Cancel"}
          </Button>
          {attempted && Object.keys(errors).length > 0 && (
            <span role="alert" className="text-sm text-danger">
              Complete the highlighted fields.
            </span>
          )}
        </div>
      )}
    </form>
  );
}

function FieldView({
  field,
  state,
  onChange,
  error,
  disabled,
  hideLabel,
  keycaps,
}: {
  field: Field;
  state: FieldState;
  onChange: (s: FieldState) => void;
  error?: string;
  disabled?: boolean;
  /** The surrounding dock already shows this label as its title. */
  hideLabel?: boolean;
  /** Number the first nine options: the keys 1 to 9 pick them. */
  keycaps?: boolean;
}) {
  const id = useId();
  const errId = `${id}-err`;
  if (field.kind === "text") {
    const common = {
      id,
      value: state.text,
      placeholder: field.placeholder,
      disabled,
      "aria-invalid": !!error || undefined,
      "aria-describedby": error ? errId : undefined,
    };
    return (
      <div className="flex flex-col gap-1.5">
        <label htmlFor={id} className={hideLabel ? "sr-only" : "text-sm font-medium"}>
          {field.label}
        </label>
        {field.multiline ? (
          <TextArea
            {...common}
            minRows={3}
            onChange={(e) => onChange({ ...state, text: e.target.value })}
          />
        ) : (
          <TextInput {...common} onChange={(e) => onChange({ ...state, text: e.target.value })} />
        )}
        {error && (
          <p id={errId} className="text-sm text-danger">
            {error}
          </p>
        )}
      </div>
    );
  }

  const multi = field.kind === "multiselect";
  const selectedPreview =
    !multi && state.selected[0]
      ? field.options.find((o) => o.value === state.selected[0])?.preview
      : undefined;
  const hint =
    multi && (field.min !== undefined || field.max !== undefined)
      ? field.min !== undefined && field.max !== undefined
        ? `Choose ${field.min}–${field.max}`
        : field.min !== undefined
          ? `Choose at least ${field.min}`
          : `Choose up to ${field.max}`
      : multi
        ? "Choose any"
        : undefined;

  return (
    <fieldset
      className="flex min-w-0 flex-col gap-2"
      aria-describedby={error ? errId : undefined}
      aria-invalid={!!error || undefined}
    >
      <legend className={hideLabel ? "sr-only" : "mb-2 text-sm font-medium"}>
        {field.label}
        {hint && !hideLabel && <span className="ml-2 font-normal text-muted">{hint}</span>}
      </legend>
      {hint && hideLabel && <p className="text-sm text-muted">{hint}</p>}
      <div className="grid gap-2">
        {field.options.map((o, i) => (
          <OptionCard
            key={o.value}
            name={id}
            option={o}
            keycap={keycaps && i < 9 ? i + 1 : undefined}
            multi={multi}
            checked={state.selected.includes(o.value)}
            disabled={disabled}
            onToggle={() =>
              onChange(
                multi
                  ? toggleMulti(
                      state,
                      o.value,
                      field.kind === "multiselect" ? field.max : undefined,
                    )
                  : chooseSelect(state, o.value),
              )
            }
          />
        ))}
        {field.allowOther && (
          <OptionCard
            name={id}
            option={{ value: "__other__", label: field.allowOther.label || "Other" }}
            multi={multi}
            checked={state.otherChosen}
            disabled={disabled}
            onToggle={() =>
              onChange(
                multi ? { ...state, otherChosen: !state.otherChosen } : chooseSelectOther(state),
              )
            }
          />
        )}
      </div>
      {field.allowOther && state.otherChosen && (
        <TextInput
          aria-label={field.allowOther.label || "Other"}
          placeholder={field.allowOther.placeholder ?? "Type your answer"}
          value={state.otherText}
          disabled={disabled}
          autoFocus
          onChange={(e) => onChange({ ...state, otherText: e.target.value })}
        />
      )}
      {selectedPreview && (
        <pre className="max-h-64 max-w-full overflow-auto rounded-md border border-border bg-surface-2 px-3 py-2 text-xs leading-5">
          {selectedPreview}
        </pre>
      )}
      {error && (
        <p id={errId} className="text-sm text-danger">
          {error}
        </p>
      )}
    </fieldset>
  );
}

function OptionCard({
  name,
  option,
  multi,
  checked,
  disabled,
  onToggle,
  keycap,
}: {
  name: string;
  option: FieldOption;
  keycap?: number;
  multi: boolean;
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <label
      className={cn(
        "tap flex min-w-0 cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 text-sm",
        "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent",
        checked ? "border-accent bg-accent-soft" : "border-border bg-surface hover:bg-surface-2",
        disabled && "cursor-not-allowed opacity-70",
      )}
    >
      <input
        type={multi ? "checkbox" : "radio"}
        name={name}
        value={option.value}
        checked={checked}
        disabled={disabled}
        onChange={onToggle}
        className="sr-only"
      />
      <span
        aria-hidden
        className={cn(
          "mt-0.5 inline-flex size-4 shrink-0 items-center justify-center border",
          multi ? "rounded" : "rounded-full",
          checked ? "border-accent bg-accent text-accent-fg" : "border-border-strong bg-surface",
        )}
      >
        {checked &&
          (multi ? (
            <Check className="size-3" />
          ) : (
            <span className="size-1.5 rounded-full bg-accent-fg" />
          ))}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium break-words">{option.label}</span>
        {option.description && (
          <span className="block text-muted break-words">{option.description}</span>
        )}
      </span>
      {keycap !== undefined && (
        <kbd
          aria-hidden
          className="mt-0.5 hidden h-5 min-w-5 shrink-0 items-center justify-center rounded border border-border-strong px-1 font-mono text-[11px] text-muted pointer-fine:inline-flex"
        >
          {keycap}
        </kbd>
      )}
    </label>
  );
}

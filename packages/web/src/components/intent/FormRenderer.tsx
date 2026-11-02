import type { Field, FieldOption, UINode } from "@switchyard/protocol";
import { Check } from "lucide-react";
import { useId, useMemo, useState } from "react";
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
 * Submits `{kind: "form", values}` through the IntentContext.
 */
export function FormRenderer({ node, className }: FormRendererProps) {
  const { onRespond, busy, disabled } = useIntent();
  const [state, setState] = useState<FormState>(() => initialFormState(node.fields));
  const [attempted, setAttempted] = useState(false);
  const visible = useMemo(() => visibleFields(node.fields, state), [node.fields, state]);
  const errors = useMemo(() => validateForm(node.fields, state), [node.fields, state]);
  const locked = disabled || busy;
  const setField = (name: string, fs: FieldState) => setState((s) => ({ ...s, [name]: fs }));

  return (
    <form
      className={cn("flex flex-col gap-4", className)}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setAttempted(true);
        if (Object.keys(errors).length > 0 || locked) return;
        onRespond?.({ kind: "form", values: buildValues(node.fields, state) });
      }}
    >
      {visible.map((f) => (
        <FieldView
          key={f.name}
          field={f}
          state={state[f.name]!}
          onChange={(fs) => setField(f.name, fs)}
          error={attempted ? errors[f.name] : undefined}
          disabled={locked}
        />
      ))}
      {!disabled && (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" busy={busy}>
            {node.submitLabel || "Submit"}
          </Button>
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
}: {
  field: Field;
  state: FieldState;
  onChange: (s: FieldState) => void;
  error?: string;
  disabled?: boolean;
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
        <label htmlFor={id} className="text-sm font-medium">
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
      <legend className="mb-2 text-sm font-medium">
        {field.label}
        {hint && <span className="ml-2 font-normal text-muted">{hint}</span>}
      </legend>
      <div className="grid gap-2">
        {field.options.map((o) => (
          <OptionCard
            key={o.value}
            name={id}
            option={o}
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
}: {
  name: string;
  option: FieldOption;
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
    </label>
  );
}

import { useRef } from "react";
import { Button, Select, TextArea, TextInput } from "../../components/ui";
import type { SampleField } from "./policySampleArgs";

function maxId(fields: SampleField[]): number {
  return fields.reduce(
    (max, field) => Math.max(max, field.id, "children" in field ? maxId(field.children) : 0),
    0,
  );
}
function fresh(id: number, key = "", kind: SampleField["kind"] = "text"): SampleField {
  if (kind === "object" || kind === "list") return { id, key, kind, children: [] };
  if (kind === "boolean") return { id, key, kind, value: false };
  if (kind === "null") return { id, key, kind };
  return { id, key, kind, value: "" };
}

export function PolicySampleFields({
  fields,
  onChange,
  disabled,
}: {
  fields: SampleField[];
  onChange: (fields: SampleField[]) => void;
  disabled: boolean;
}) {
  const nextId = useRef(maxId(fields) + 1);
  nextId.current = Math.max(nextId.current, maxId(fields) + 1);
  function entries(
    items: SampleField[],
    change: (items: SampleField[]) => void,
    mode: "argument" | "field" | "item",
    depth: number,
  ) {
    return (
      <div className="flex min-w-0 flex-col gap-2">
        {items.map((field, i) => {
          const label = `${mode === "argument" ? "Argument" : mode === "field" ? "Field" : "Item"} ${i + 1}`;
          const update = (next: SampleField) =>
            change(items.map((item) => (item.id === field.id ? next : item)));
          return (
            <fieldset
              key={field.id}
              className="flex min-w-0 flex-col gap-2 rounded-md border border-border p-2"
            >
              <legend>{label}</legend>
              {mode !== "item" && (
                <label htmlFor={`sample-${field.id}-name`}>
                  Name
                  <TextInput
                    id={`sample-${field.id}-name`}
                    value={field.key}
                    disabled={disabled}
                    onChange={(e) => update({ ...field, key: e.target.value })}
                  />
                </label>
              )}
              <label htmlFor={`sample-${field.id}-type`}>
                Type
                <Select
                  id={`sample-${field.id}-type`}
                  value={field.kind}
                  disabled={disabled}
                  onChange={(e) =>
                    update(fresh(field.id, field.key, e.target.value as SampleField["kind"]))
                  }
                >
                  <option value="text">Text</option>
                  <option value="number">Number</option>
                  <option value="boolean">Yes / No</option>
                  <option value="null">None</option>
                  <option value="object">Object</option>
                  <option value="list">List</option>
                </Select>
              </label>
              {field.kind === "text" && (
                <label htmlFor={`sample-${field.id}-value`}>
                  Value
                  <TextArea
                    id={`sample-${field.id}-value`}
                    value={field.value}
                    disabled={disabled}
                    onChange={(e) => update({ ...field, value: e.target.value })}
                  />
                </label>
              )}
              {field.kind === "number" && (
                <label htmlFor={`sample-${field.id}-value`}>
                  Value
                  <TextInput
                    id={`sample-${field.id}-value`}
                    inputMode="decimal"
                    value={field.value}
                    disabled={disabled}
                    onChange={(e) => update({ ...field, value: e.target.value })}
                  />
                </label>
              )}
              {field.kind === "boolean" && (
                <label htmlFor={`sample-${field.id}-value`}>
                  Value
                  <Select
                    id={`sample-${field.id}-value`}
                    value={field.value ? "yes" : "no"}
                    disabled={disabled}
                    onChange={(e) => update({ ...field, value: e.target.value === "yes" })}
                  >
                    <option value="no">No</option>
                    <option value="yes">Yes</option>
                  </Select>
                </label>
              )}
              {(field.kind === "object" || field.kind === "list") &&
                entries(
                  field.children,
                  (children) => update({ ...field, children }),
                  field.kind === "object" ? "field" : "item",
                  depth + 1,
                )}
              <Button
                disabled={disabled}
                onClick={() => change(items.filter((item) => item.id !== field.id))}
              >
                Remove {label}
              </Button>
            </fieldset>
          );
        })}
        {depth < 20 && (
          <Button disabled={disabled} onClick={() => change([...items, fresh(nextId.current++)])}>
            Add {mode}
          </Button>
        )}
      </div>
    );
  }
  return (
    <fieldset className="min-w-0">
      <legend>Sample arguments</legend>
      {entries(fields, onChange, "argument", 0)}
    </fieldset>
  );
}

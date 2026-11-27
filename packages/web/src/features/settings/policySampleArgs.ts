import type { JsonValue } from "@switchyard/protocol";

export type SampleField = { id: number; key: string } & (
  | { kind: "text" | "number"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "null" }
  | { kind: "object" | "list"; children: SampleField[] }
);

const reserved = new Set(["__proto__", "prototype", "constructor"]);
const numberPattern = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

export function compileSampleArgs(
  fields: SampleField[],
  command?: string,
): Record<string, JsonValue> {
  function value(field: SampleField, path: string, depth: number): JsonValue {
    if (depth > 20) throw new Error("Sample arguments are nested too deeply.");
    switch (field.kind) {
      case "text":
        return field.value;
      case "boolean":
        return field.value;
      case "null":
        return null;
      case "number": {
        const n = Number(field.value);
        if (
          !numberPattern.test(field.value) ||
          !Number.isFinite(n) ||
          (Number.isInteger(n) && !Number.isSafeInteger(n))
        )
          throw new Error(`Enter a valid number for ${path}.`);
        return n;
      }
      case "object":
        return record(field.children, path, depth);
      case "list":
        return field.children.map((child, i) => value(child, `${path}[${i}]`, depth + 1));
    }
  }
  function record(
    items: SampleField[],
    path: string,
    depth: number,
    initial: [string, JsonValue][] = [],
  ): Record<string, JsonValue> {
    const entries = [...initial];
    const names = new Set(entries.map(([key]) => key));
    items.forEach((field, i) => {
      if (!field.key.trim())
        throw new Error(`${path ? `${path}: Field` : "Argument"} ${i + 1} needs a name.`);
      const name = path ? `${path}.${field.key}` : field.key;
      if (reserved.has(field.key)) throw new Error(`Reserved field name: ${name}.`);
      if (names.has(field.key)) throw new Error(`Duplicate field: ${name}.`);
      names.add(field.key);
      entries.push([field.key, value(field, name, depth + 1)]);
    });
    return Object.fromEntries(entries);
  }
  return record(fields, "", 0, command?.trim() ? [["command", command]] : []);
}

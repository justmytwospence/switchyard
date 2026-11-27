import type { ReactNode } from "react";

/** A bounded, inert presentation of machine data. Accessors are never evaluated. */
export function StructuredValue({ value }: { value: unknown }) {
  let remaining = 200;
  const ancestors = new Set<object>();
  const omitted = () => <span>More data omitted</span>;
  function render(v: unknown, depth: number): ReactNode {
    if (remaining <= 0) return omitted();
    remaining--;
    if (depth > 8) return omitted();
    if (v === null) return "None";
    if (typeof v === "string")
      return v === "" ? "Empty text" : v.length > 4000 ? `${v.slice(0, 4000)}…` : v;
    if (typeof v === "number") return Number.isFinite(v) ? String(v) : "Not available";
    if (typeof v === "boolean") return v ? "Yes" : "No";
    if (typeof v !== "object") return "Not available";
    const array = Array.isArray(v);
    const proto = Object.getPrototypeOf(v);
    if (!array && proto !== Object.prototype && proto !== null) return "Not available";
    if (ancestors.has(v)) return omitted();
    ancestors.add(v);
    const children: ReactNode[] = [];
    if (array) {
      for (let i = 0; i < v.length; i++) {
        if (remaining <= 0) {
          children.push(<li key="omitted">{omitted()}</li>);
          break;
        }
        const descriptor = Object.getOwnPropertyDescriptor(v, String(i));
        children.push(
          <li key={i}>
            {render(descriptor && "value" in descriptor ? descriptor.value : undefined, depth + 1)}
          </li>,
        );
      }
    } else {
      for (const key in v) {
        if (!Object.hasOwn(v, key)) continue;
        if (remaining <= 0) {
          children.push(<div key="omitted">{omitted()}</div>);
          break;
        }
        const descriptor = Object.getOwnPropertyDescriptor(v, key);
        children.push(
          <div key={key} className="min-w-0">
            <dt className="font-medium break-words">{key}</dt>
            <dd className="min-w-0 pl-3">
              {render(
                descriptor && "value" in descriptor ? descriptor.value : undefined,
                depth + 1,
              )}
            </dd>
          </div>,
        );
      }
    }
    ancestors.delete(v);
    if (!children.length) return array ? "No items" : "No fields";
    return array ? (
      <ol className="min-w-0 list-decimal space-y-1 pl-5">{children}</ol>
    ) : (
      <dl className="min-w-0 space-y-1">{children}</dl>
    );
  }
  return <div className="min-w-0 text-xs break-words whitespace-pre-wrap">{render(value, 0)}</div>;
}

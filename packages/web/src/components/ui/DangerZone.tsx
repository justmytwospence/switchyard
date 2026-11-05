import { type ReactNode, useId } from "react";

/** Destructive actions, set apart at the bottom of a detail page. */
export function DangerZone({
  description,
  children,
}: {
  description?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      data-testid="danger-zone"
      className="min-w-0 rounded-lg border border-danger/50 bg-surface p-4"
    >
      <h2 id={id} className="text-base font-semibold text-danger">
        Danger zone
      </h2>
      {description && <p className="text-sm text-muted">{description}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">{children}</div>
    </section>
  );
}

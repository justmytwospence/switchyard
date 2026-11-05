import { type ReactNode, useId } from "react";
import { cn } from "../../lib/cn";

export interface CardProps {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  testId?: string;
  /** Wrap the children in a flex column with gap-4. */
  stack?: boolean;
}

/** A titled, bordered block. The title is its accessible name. */
export function Card({
  title,
  description,
  actions,
  children,
  className,
  testId,
  stack,
}: CardProps) {
  const titleId = useId();
  return (
    <section
      aria-labelledby={title ? titleId : undefined}
      data-testid={testId}
      className={cn("min-w-0 rounded-lg border border-border bg-surface p-4", className)}
    >
      {(title || actions) && (
        <div className="mb-3 flex min-w-0 flex-wrap items-start gap-2">
          <div className="min-w-0 flex-[1_1_12rem]">
            {title && (
              <h2 id={titleId} className="text-base font-semibold">
                {title}
              </h2>
            )}
            {description && <p className="text-sm text-muted">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      {stack ? <div className="flex flex-col gap-4">{children}</div> : children}
    </section>
  );
}

import { cn } from "../../lib/cn";
import { useHighlight } from "../../lib/highlight";

/** Source with line numbers and syntax highlighting (when the language is known). */
export function CodeView({
  text,
  lang,
  wrap,
  className,
}: {
  text: string;
  lang: string | null;
  wrap: boolean;
  className?: string;
}) {
  const tokens = useHighlight(text, lang);
  const plain = text.split("\n");
  if (plain.length > 1 && plain[plain.length - 1] === "") plain.pop();
  const count = plain.length;
  return (
    <section
      aria-label="File contents"
      className={cn(
        "sy-code min-w-0 overflow-auto overscroll-contain rounded-md border border-border bg-surface font-mono text-xs leading-5",
        className,
      )}
    >
      <div className="grid grid-cols-[auto_minmax(0,1fr)]">
        {Array.from({ length: count }, (_, i) => {
          const line = tokens?.[i];
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity
            <div key={i} className="contents">
              <span
                data-line-number
                className="select-none border-r border-border bg-surface-2 px-3 text-right text-subtle tabular-nums"
              >
                {i + 1}
              </span>
              <span
                className={cn("px-3", wrap ? "break-all whitespace-pre-wrap" : "whitespace-pre")}
              >
                {line
                  ? line.map((t, j) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: tokens are positional
                      <span key={j} style={t.style as React.CSSProperties}>
                        {t.content}
                      </span>
                    ))
                  : plain[i]}
                {"\n"}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

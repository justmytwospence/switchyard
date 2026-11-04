import { cn } from "../../lib/cn";
import { useHighlight } from "../../lib/highlight";

/** Flat, full-width source with syntax highlighting (when the language is known). */
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
  return (
    <section
      aria-label="File contents"
      className={cn(
        "sy-code min-w-0 overflow-auto overscroll-contain bg-surface-2 py-2 font-mono text-xs leading-5",
        className,
      )}
    >
      <pre
        className={cn(
          "px-3",
          wrap ? "break-all whitespace-pre-wrap" : "w-max min-w-full whitespace-pre",
        )}
      >
        <code>
          {plain.map((line, i) => {
            const toks = tokens?.[i];
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity
              <span key={i}>
                {toks
                  ? toks.map((t, j) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: tokens are positional
                      <span key={j} style={t.style as React.CSSProperties}>
                        {t.content}
                      </span>
                    ))
                  : line}
                {i < plain.length - 1 ? "\n" : ""}
              </span>
            );
          })}
        </code>
      </pre>
    </section>
  );
}

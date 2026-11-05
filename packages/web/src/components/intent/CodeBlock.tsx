import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/cn";
import { langFor, useHighlight } from "../../lib/highlight";
import { copyText } from "../ui/Copy";

/** Monospace block; long lines scroll horizontally inside the block, never the page. */
export function CodeBlock({
  text,
  lang,
  className,
  maxHeight,
}: {
  text: string;
  lang?: string;
  className?: string;
  /** CSS length; scrolls vertically past it. */
  maxHeight?: string;
}) {
  const [copied, setCopied] = useState(false);
  const lines = useHighlight(text, langFor(lang));
  return (
    <div className={cn("sy-code group relative min-w-0 rounded-md bg-surface-2", className)}>
      {lang && <div className="px-3 pt-1.5 font-mono text-xs text-subtle">{lang}</div>}
      <pre
        className="max-w-full overflow-x-auto overscroll-x-contain px-3 py-2 text-xs leading-5"
        style={maxHeight ? { maxHeight, overflowY: "auto" } : undefined}
      >
        <code>
          {lines
            ? lines.map((line, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
                <span key={i}>
                  {line.map((t, j) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: tokens are positional
                    <span key={j} style={t.style as React.CSSProperties}>
                      {t.content}
                    </span>
                  ))}
                  {i < lines.length - 1 ? "\n" : ""}
                </span>
              ))
            : text}
        </code>
      </pre>
      <button
        type="button"
        aria-label={copied ? "Copied" : "Copy code"}
        title={copied ? "Copied" : "Copy code"}
        className="tap absolute top-1 right-1 inline-flex size-7 items-center justify-center rounded border border-border bg-surface text-muted opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-100"
        onClick={() => {
          void copyText(text, false).then((ok) => {
            if (!ok) return;
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? (
          <Check aria-hidden className="size-3.5" />
        ) : (
          <Copy aria-hidden className="size-3.5" />
        )}
      </button>
    </div>
  );
}

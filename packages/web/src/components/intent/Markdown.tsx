import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { Link } from "react-router";
import remarkGfm from "remark-gfm";
import { cn } from "../../lib/cn";
import { CodeBlock } from "./CodeBlock";

const components: Components = {
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const text = String(children ?? "");
    const lang = /language-([\w-]+)/.exec(className ?? "")?.[1];
    // Fenced blocks have a language class or contain newlines; inline code stays inline.
    if (lang || text.includes("\n"))
      return <CodeBlock text={text.replace(/\n$/, "")} lang={lang} />;
    return <code>{children}</code>;
  },
  table: ({ children }) => (
    <div className="max-w-full overflow-x-auto overscroll-x-contain">
      <table className="border-collapse text-sm [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:bg-surface-2 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left">
        {children}
      </table>
    </div>
  ),
  a: ({ href, children }) => {
    if (href?.startsWith("/") && !href.startsWith("//")) return <Link to={href}>{children}</Link>;
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
  img: ({ alt }) => <span className="text-muted">[image{alt ? `: ${alt}` : ""}]</span>,
};

/** GitHub-flavored markdown. Raw HTML is not rendered. */
export const Markdown = memo(function Markdown({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  return (
    <div className={cn("sy-prose text-sm", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

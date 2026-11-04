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

/** Plain text of rendered children (for heading ids). */
function textOf(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) {
    return textOf((node as { props: { children?: React.ReactNode } }).props.children);
  }
  return "";
}

export function headingSlug(text: string): string {
  return `plan-${text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")}`;
}

const componentsWithIds: Components = {
  ...components,
  h2: ({ children }) => <h2 id={headingSlug(textOf(children))}>{children}</h2>,
};

/** GitHub-flavored markdown. Raw HTML is not rendered. */
export const Markdown = memo(function Markdown({
  text,
  className,
  headingIds,
}: {
  text: string;
  className?: string;
  /** Give each h2 an id (`headingSlug`) so an outline can link to it. */
  headingIds?: boolean;
}) {
  return (
    <div className={cn("sy-prose text-sm", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={headingIds ? componentsWithIds : components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

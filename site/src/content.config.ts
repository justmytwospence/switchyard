/**
 * The docs collection renders the repository's own Markdown in place: docs/*.md and the
 * integration READMEs. Nothing is copied. Each file's first heading becomes its title, and
 * relative links become site URLs (for other docs) or GitHub URLs (for anything else).
 */

import { defineCollection } from "astro:content";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { docsSchema } from "@astrojs/starlight/schema";
import type { Loader } from "astro/loaders";
import { DOC_SOURCES, GITHUB, REPO_ROOT, slugOf } from "./docs-sources";

/** Rewrites one relative Markdown link target found in `source` (a repo-relative path). */
export function rewriteLink(source: string, target: string): string {
  if (/^([a-z][a-z0-9+.-]*:|#|\/)/i.test(target)) return target;
  const [path, hash] = target.split("#", 2);
  const repoPath = relative(REPO_ROOT, resolve(REPO_ROOT, dirname(source), path));
  const anchor = hash ? `#${hash}` : "";
  const slug = slugOf(repoPath);
  if (slug) return `/${slug}/${anchor}`;
  const abs = join(REPO_ROOT, repoPath);
  if (!existsSync(abs)) throw new Error(`${source}: broken link to ${target}`);
  const kind = statSync(abs).isDirectory() ? "tree" : "blob";
  return `${GITHUB}/${kind}/dev/${repoPath}${anchor}`;
}

/** Applies rewriteLink to every inline link and image outside code. */
export function rewriteLinks(source: string, markdown: string): string {
  let fenced = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      if (fenced) return line;
      // Leave inline code spans alone.
      return line
        .split(/(`[^`]*`)/)
        .map((part) =>
          part.startsWith("`")
            ? part
            : part.replace(
                /(\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g,
                (_, open, target, close) => `${open}${rewriteLink(source, target)}${close}`,
              ),
        )
        .join("");
    })
    .join("\n");
}

/** Code blocks and tables that scroll sideways get keyboard focus (WCAG scrollable regions). */
function keyboardScrollable(html: string): string {
  return html
    .replace(/<pre(?![^>]*tabindex)/g, '<pre tabindex="0"')
    .replace(
      /<table>/g,
      '<div class="table-scroll" tabindex="0" role="region" aria-label="Table"><table>',
    )
    .replace(/<\/table>/g, "</table></div>");
}

function plain(markdown: string): string {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function repoDocs(): Loader {
  return {
    name: "repo-docs",
    async load({ store, parseData, renderMarkdown, generateDigest, watcher }) {
      store.clear();
      for (const source of DOC_SOURCES) {
        const file = join(REPO_ROOT, source.path);
        const raw = readFileSync(file, "utf8");
        const heading = /^# (.+)$/m.exec(raw);
        if (!heading) throw new Error(`${source.path} has no top-level heading`);
        const body = rewriteLinks(source.path, raw.replace(heading[0], "").trimStart());
        const firstParagraph = body.split(/\n\s*\n/).find((p) => /^[A-Za-z*`[]/.test(p.trim()));
        const description = firstParagraph ? plain(firstParagraph).slice(0, 220) : undefined;
        const id = source.slug;
        const data = await parseData({
          id,
          data: {
            title: source.title ?? heading[1].trim(),
            description,
            editUrl: `${GITHUB}/edit/dev/${source.path}`,
          },
          filePath: file,
        });
        const rendered = await renderMarkdown(body, { fileURL: pathToFileURL(file) });
        store.set({
          id,
          data,
          body,
          filePath: source.path,
          digest: generateDigest(raw),
          rendered: { ...rendered, html: keyboardScrollable(rendered.html) },
        });
        watcher?.add(file);
      }
    },
  };
}

export const collections = {
  docs: defineCollection({ loader: repoDocs(), schema: docsSchema() }),
};

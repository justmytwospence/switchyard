import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** The repository root: the nearest directory up from the working directory with the CLI's build. */
function repoRoot(): string {
  let dir = process.cwd();
  while (!existsSync(join(dir, "scripts", "build-npm.mjs"))) {
    const up = dirname(dir);
    if (up === dir) throw new Error("Run the site build from inside the Switchyard repository");
    dir = up;
  }
  return dir;
}

export const REPO_ROOT = repoRoot();
export const GITHUB = "https://github.com/justmytwospence/switchyard";

export interface DocSource {
  /** Repository-relative Markdown file. */
  path: string;
  /** Site route without slashes. */
  slug: string;
  /** Sidebar label and page title, when the file's heading does not suit. */
  title?: string;
}

interface Group {
  label: string;
  items: DocSource[];
}

const doc = (name: string, title?: string): DocSource => ({
  path: `docs/${name}.md`,
  slug: `docs/${name}`,
  title,
});

/**
 * Every page of the docs, in sidebar order. scripts/check-links.mjs fails the build when a file in
 * docs/ or an integration README is missing here.
 */
export const SIDEBAR: Group[] = [
  { label: "Start here", items: [doc("getting-started"), doc("model")] },
  {
    label: "Using Switchyard",
    items: [
      doc("trackers"),
      doc("terminal-sessions"),
      { path: "integrations/herdr/README.md", slug: "docs/herdr", title: "herdr" },
      { path: "integrations/tmux/README.md", slug: "docs/tmux", title: "tmux" },
      doc("github"),
      doc("policies"),
      doc("keyboard-shortcuts"),
      doc("cli"),
    ],
  },
  {
    label: "Running it",
    items: [doc("deployment"), doc("auth"), doc("operations"), doc("compatibility")],
  },
  {
    label: "Extending it",
    items: [
      doc("adapters"),
      doc("client-sdk"),
      doc("plugin-boundaries", "Plugin ownership"),
      doc("architecture"),
    ],
  },
  {
    label: "Project",
    items: [
      doc("development"),
      doc("roadmap"),
      doc("acceptance-report"),
      doc("spec", "Specification"),
      doc("sources"),
    ],
  },
];

export const DOC_SOURCES: DocSource[] = SIDEBAR.flatMap((g) => g.items);

const bySlugPath = new Map(DOC_SOURCES.map((d) => [d.path, d.slug]));

/** The site route of a repository file, if it is a doc page. */
export function slugOf(repoPath: string): string | undefined {
  return bySlugPath.get(repoPath);
}

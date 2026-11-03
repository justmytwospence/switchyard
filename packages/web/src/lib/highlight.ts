import { useEffect, useState } from "react";
import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

/** Languages are loaded on first use, one chunk each. */
const LANG_LOADERS: Record<string, () => Promise<unknown>> = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsonc: () => import("shiki/langs/jsonc.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  scss: () => import("shiki/langs/scss.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  dockerfile: () => import("shiki/langs/dockerfile.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  lua: () => import("shiki/langs/lua.mjs"),
};

const ALIASES: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  typescript: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  javascript: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "jsonc",
  json5: "jsonc",
  css: "css",
  scss: "scss",
  html: "html",
  htm: "html",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  shell: "shellscript",
  console: "shellscript",
  shellscript: "shellscript",
  py: "python",
  python: "python",
  go: "go",
  rs: "rust",
  rust: "rust",
  sql: "sql",
  dockerfile: "dockerfile",
  diff: "diff",
  patch: "diff",
  xml: "xml",
  svg: "xml",
  plist: "xml",
  swift: "swift",
  rb: "ruby",
  ruby: "ruby",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  lua: "lua",
};

/** A supported language for a file name, extension or fence alias; null when there is none. */
export function langFor(nameOrLang: string | undefined): string | null {
  if (!nameOrLang) return null;
  const base = (nameOrLang.split("/").pop() ?? "").toLowerCase();
  if (base === "dockerfile") return "dockerfile";
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : base;
  return ALIASES[ext] ?? null;
}

const MAX_CHARS = 200_000;
const MAX_LINES = 5000;

export function shouldHighlight(text: string, lang: string | null): boolean {
  if (!lang || !(lang in LANG_LOADERS)) return false;
  if (text.length > MAX_CHARS) return false;
  let lines = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
  return lines <= MAX_LINES;
}

export type Token = { content: string; style?: Record<string, string> };

let highlighter: Promise<HighlighterCore> | undefined;
const loaded = new Map<string, Promise<void>>();

function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= createHighlighterCore({
    themes: [import("shiki/themes/github-light.mjs"), import("shiki/themes/github-dark.mjs")],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
  return highlighter;
}

const cache = new Map<string, Token[][]>();

async function tokenize(text: string, lang: string): Promise<Token[][]> {
  const key = `${lang}\0${text}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const hl = await getHighlighter();
  let ready = loaded.get(lang);
  if (!ready) {
    ready = LANG_LOADERS[lang]!().then((m) => hl.loadLanguage(m as never));
    loaded.set(lang, ready);
  }
  await ready;
  const { tokens } = hl.codeToTokens(text, {
    lang,
    themes: { light: "github-light", dark: "github-dark" },
    defaultColor: false,
  });
  const out = tokens.map((line) =>
    line.map((t) => ({
      content: t.content,
      style: t.htmlStyle as Record<string, string> | undefined,
    })),
  );
  cache.set(key, out);
  if (cache.size > 50) cache.delete(cache.keys().next().value as string);
  return out;
}

/** Highlighted tokens per line, or null while loading, when unsupported or too large. */
export function useHighlight(text: string, lang: string | null): Token[][] | null {
  const ok = shouldHighlight(text, lang);
  const [tokens, setTokens] = useState<Token[][] | null>(null);
  useEffect(() => {
    if (!ok || !lang) {
      setTokens(null);
      return;
    }
    let live = true;
    tokenize(text, lang).then(
      (t) => live && setTokens(t),
      () => live && setTokens(null),
    );
    return () => {
      live = false;
    };
  }, [ok, text, lang]);
  return ok ? tokens : null;
}

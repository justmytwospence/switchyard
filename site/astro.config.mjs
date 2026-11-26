// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import rehypeMermaid from "rehype-mermaid";
import { GITHUB, SIDEBAR } from "./src/docs-sources.ts";

export default defineConfig({
  site: process.env.SITE_URL ?? "https://switchyard-site.pages.dev",
  trailingSlash: "always",
  redirects: { "/docs": "/docs/getting-started/" },
  markdown: {
    // Diagrams render to inline SVG at build time, so they read without JavaScript.
    rehypePlugins: [[rehypeMermaid, { strategy: "img-svg", dark: true }]],
  },
  integrations: [
    starlight({
      title: "Switchyard",
      description:
        "Run Pi coding agents on your own machines, and drive them from your phone, your browser or your terminal.",
      logo: { src: "./src/assets/icon.svg" },
      favicon: "/icon.svg",
      social: [{ icon: "github", label: "GitHub", href: GITHUB }],
      customCss: ["./src/styles/docs.css"],
      expressiveCode: { themes: ["github-dark", "github-light"] },
      lastUpdated: false,
      pagination: true,
      sidebar: SIDEBAR.map((group) => ({
        label: group.label,
        items: group.items.map((d) => ({ slug: d.slug, ...(d.title ? { label: d.title } : {}) })),
      })),
    }),
  ],
});

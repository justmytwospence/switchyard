# Switchyard's site

The public site: a landing page and the docs. It is an [Astro](https://astro.build) [Starlight](https://starlight.astro.build) site with its own dependencies (outside the pnpm workspace, so the product's installs and CI never load them).

- **Docs are not copied.** `src/content.config.ts` renders `docs/*.md` and the module READMEs in place: each file's first heading is its title, and relative links become site links (other docs) or GitHub links (anything else). `src/docs-sources.ts` is the sidebar; a new doc must be added there or the link check fails.
- **Release facts come from the repository.** The version and install command are read from `package.json` and `scripts/build-npm.mjs` at build time.
- **Screenshots come from a seeded demo**, never from a real deployment: `capture/demo-stack.ts` starts a coordinator, two hosts running real Pi against a scripted mock model, made-up projects and a hermetic `gh`; `capture/capture.ts` signs a browser in and writes `src/assets/screens/*-{light,dark}.png`.

```sh
pnpm install            # in site/
pnpm build              # dist/
pnpm check              # links and anchors, then axe (WCAG 2 A/AA) in light and dark, and no-JS reading
pnpm dev                # local preview with reload

# Screenshots: build the product first, then capture (needs Pi on PATH and Playwright's Chromium).
(cd .. && pnpm build) && pnpm capture
node capture/demo-stack.ts   # or keep the demo running to look around; it prints a sign-in token
```

CI (`.github/workflows/site.yml`) builds and checks the site on every push that touches it, and deploys it to Cloudflare Pages: `dev` to production, other branches to their preview URL.

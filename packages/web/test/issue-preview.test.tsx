// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "../src/components/intent/Markdown";
import { IssuePreview } from "../src/features/discovery/IssuePreview";
import { openIssue } from "../src/features/workboard/api";
import { useSyncStore } from "../src/sync/store";
import { session } from "./fixtures";

const origin = "https://github.com/acme/widget/issues/17";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useSyncStore.getState().reset();
});

const facts = {
  itemId: "I_fixture",
  number: 17,
  repository: "acme/widget",
  url: origin,
  title: "Preview fixture",
  assignees: [],
  branches: [],
  pullRequest: null,
  board: null,
};
const repoLocator = {
  kind: "repository",
  projectId: "widget/project",
  number: 17,
  nodeId: facts.itemId,
} as const;
const trackedLocator = { kind: "tracked", id: "scope:I_fixture" } as const;

describe("issue locators", () => {
  it("reads by locator, aborts the old preview, and offers the GitHub fallback on older hosts", async () => {
    let late!: (response: Response) => void;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise((res) => {
            late = res;
          }),
      )
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: "unsupported_capability", message: "Old host" } },
          { status: 422 },
        ),
      )
      .mockResolvedValueOnce(Response.json({ body: "Current description", truncated: false }));
    vi.stubGlobal("fetch", fetcher);
    const view = render(<IssuePreview locator={trackedLocator} issue={facts} />);
    const signal = fetcher.mock.calls[0]?.[1]?.signal;
    view.rerender(<IssuePreview locator={repoLocator} issue={facts} />);
    expect(signal?.aborted).toBe(true);
    await screen.findByText(/Description unavailable.*Update a checkout/);
    expect(screen.getByRole("link", { name: "Open issue on GitHub" }).getAttribute("href")).toBe(
      origin,
    );
    await act(async () => late(Response.json({ body: "Removed preview", truncated: false })));
    expect(screen.queryByText("Removed preview")).toBeNull();
    await act(async () => screen.getByRole("button", { name: "Retry description" }).click());
    expect(screen.getByText("Current description")).toBeTruthy();
    expect(fetcher.mock.calls.map(([url, options]) => [url, options?.method])).toEqual([
      ["/api/issues/scope%3AI_fixture/description", "GET"],
      ["/api/projects/widget%2Fproject/issues/17/description", "GET"],
      ["/api/projects/widget%2Fproject/issues/17/description", "GET"],
    ]);
  });

  it("sends the expected node only for a repository open and keeps tracked opens compatible", async () => {
    const primary = session("primary");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ created: false, session: primary }));
    vi.stubGlobal("fetch", fetcher);
    await expect(openIssue(repoLocator, { prompt: "instruction" })).resolves.toMatchObject({
      created: false,
      session: { id: "primary" },
    });
    await openIssue(trackedLocator);
    expect(
      fetcher.mock.calls.map(([url, request]) => [
        url,
        request?.method,
        JSON.parse(String(request?.body)),
      ]),
    ).toEqual([
      [
        "/api/projects/widget%2Fproject/issues/17/open",
        "POST",
        { prompt: "instruction", expectedNodeId: facts.itemId },
      ],
      ["/api/issues/scope%3AI_fixture/open", "POST", {}],
    ]);
    expect(useSyncStore.getState().sessions.primary).toMatchObject({ id: "primary" });
  });
});

describe("issue description Markdown", () => {
  it("resolves external-document links against the issue, never against Switchyard", () => {
    const html = renderToStaticMarkup(
      <Markdown
        text="[repo](/acme/widget) [other](18) [section](#details)"
        externalBaseUrl={origin}
      />,
    );
    expect(html).toContain('href="https://github.com/acme/widget"');
    expect(html).toContain('href="https://github.com/acme/widget/issues/18"');
    expect(html).toContain('href="https://github.com/acme/widget/issues/17#details"');
    expect(html).toContain('target="_blank" rel="noopener noreferrer"');
  });

  it("does not render unsafe links, raw HTML, or remote images as active content", () => {
    const html = renderToStaticMarkup(
      <Markdown
        text={
          "[bad](javascript:alert%281%29) [mail](mailto:user@example.com)\n\n<script>alert(1)</script>\n\n![diagram](https://example.com/pixel.png)"
        }
        externalBaseUrl={origin}
      />,
    );
    expect(html).not.toMatch(/<a |<script|<img|pixel\.png/);
    expect(html).toContain("[image: diagram]");
  });

  it("keeps ordinary in-app Markdown routes intact", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <Markdown text="[session](/code/one)" />
      </MemoryRouter>,
    );
    expect(html).toContain('href="/code/one"');
    expect(html).not.toContain('target="_blank"');
  });
});

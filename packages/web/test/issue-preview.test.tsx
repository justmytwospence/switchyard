import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { Markdown } from "../src/components/intent/Markdown";

const origin = "https://github.com/acme/widget/issues/17";

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

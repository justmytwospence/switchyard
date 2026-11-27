import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { formatTime } from "../src/lib/time";

vi.mock("../src/lib/useResource", () => ({
  isObject: (value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value),
  useApiResource: () => ({
    data: { backup: { createdAt: "2026-01-01T00:00:00.000Z", files: [{ name: "db.sqlite" }] } },
    error: null,
    loading: false,
    fatal: false,
    reload: () => {},
  }),
}));

import { BackupsSection } from "../src/features/settings/BackupsSection";

describe("backup details", () => {
  it("renders nested information and formats dates without serialized objects", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <BackupsSection />
      </MemoryRouter>,
    );
    expect(html).toContain("Created at");
    expect(html).toContain(formatTime("2026-01-01T00:00:00.000Z"));
    expect(html).toContain("Files");
    expect(html).toContain("name");
    expect(html).toContain("db.sqlite");
    expect(html).not.toContain("{&quot;name&quot;");
  });
});

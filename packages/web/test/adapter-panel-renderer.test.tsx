import type { Panel } from "@switchyard/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdapterPanel } from "../src/features/code/AdapterPanel";
import type { SessionContext } from "../src/features/code/hooks";

const panel = {
  sessionId: "ses_1",
  adapterId: "frame",
  slot: "panel",
  title: "Frame",
  node: { t: "text", text: "portable content" },
  webRenderer: true,
  mobileFallback: "portable content",
  updatedAt: "2026-01-01T00:00:00Z",
} as Panel;
const ctx = {
  session: { id: "ses_1", hostId: "host_1", readOnly: false, archivedAt: null },
  host: { id: "host_1" },
  link: "connected",
  adapters: [{ id: "frame", status: "active", webRenderer: true }],
} as SessionContext;

describe("adapter renderer availability", () => {
  const render = (context: SessionContext) =>
    renderToStaticMarkup(<AdapterPanel ctx={context} panel={panel} allowFrame />);
  it("mounts only a currently advertised active host renderer", () => {
    expect(render(ctx)).toContain('sandbox="allow-scripts"');
    for (const adapters of [
      [],
      [{ id: "frame", status: "active", webRenderer: false }],
      [{ id: "frame", status: "disabled", webRenderer: true }],
    ]) {
      const html = render({ ...ctx, adapters } as SessionContext);
      expect(html).not.toContain("<iframe");
      expect(html).toContain("portable content");
    }
  });
});

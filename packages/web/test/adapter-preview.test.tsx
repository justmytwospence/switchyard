import type { AdapterPreview as Preview } from "@switchyard/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UINodeRendererProps } from "../src/components/intent/UINodeRenderer";
import {
  AdapterPreview,
  type PreviewAction,
  PreviewFrame,
} from "../src/features/settings/AdapterPreview";

const captured = vi.hoisted(() => [] as UINodeRendererProps[]);
const forbiddenApi = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("Preview must never call the live API");
  }),
);
vi.mock("../src/sync/api", () => ({ apiPost: forbiddenApi, apiGet: forbiddenApi }));
vi.mock("../src/components/intent/UINodeRenderer", async (original) => {
  const real = await original<typeof import("../src/components/intent/UINodeRenderer")>();
  return {
    ...real,
    UINodeRenderer: (props: UINodeRendererProps) => {
      captured.push(props);
      return <real.UINodeRenderer {...props} />;
    },
  };
});

const preview: Preview = {
  version: 1,
  name: "Local preview",
  adapter: { id: "test", version: "1.0.0" },
  steps: [],
  diagnostics: [],
  panels: [
    {
      sessionId: "ses_adapter_preview",
      adapterId: "test",
      slot: "@slot/panel",
      title: "Portable panel",
      node: {
        t: "form",
        formId: "note",
        fields: [{ kind: "text", name: "note", label: "Demo note" }],
        submitLabel: "Save local note",
      },
      webRenderer: false,
      mobileFallback: "Note form",
      updatedAt: "2026-01-01T00:00:00.000Z",
      contribution: { id: "panel", placement: "session.panel", actionId: "save" },
    },
  ],
  interactions: [
    {
      request: { id: "q", method: "confirm", title: "Local question", message: "Confirm" },
      presentation: {
        t: "confirm",
        message: "Local question",
        confirmLabel: "Yes locally",
        cancelLabel: "No locally",
      },
      state: "pending",
    },
  ],
  cards: [
    {
      t: "markdown",
      text: '<script>alert("unsafe")</script>\n\n![remote](https://example.invalid/image.png)',
    },
    { t: "actions", actions: [{ id: "demo", label: "Local card action" }] },
  ],
};

beforeEach(() => {
  captured.length = 0;
  forbiddenApi.mockClear();
});
const frame = (disabled = false, phone = false, actions: PreviewAction[] = [], data = preview) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <PreviewFrame
        preview={data}
        phone={phone}
        disabled={disabled}
        onAction={(envelope) => actions.push(envelope)}
      />
    </MemoryRouter>,
  );

describe("portable adapter preview", () => {
  it("renders shared portable forms and questions in desktop/390px phone frames, without raw HTML or remote images", () => {
    const desktop = frame();
    const phone = frame(false, true);
    expect(desktop).toContain("Desktop preview");
    expect(phone).toContain("Phone preview 390px");
    expect(phone).toContain("width:390px");
    for (const html of [desktop, phone]) {
      expect(html).toContain("Demo note");
      expect(html).toContain("Local question");
      expect(html).toContain("session.panel");
      expect(html).not.toContain("<script");
      expect(html).not.toContain("<iframe");
      expect(html).not.toContain("<img");
    }
  });

  it("records form, question and card actions as local envelopes and never dispatches the live API", () => {
    const actions: PreviewAction[] = [];
    frame(false, false, actions);
    captured[0]!.onRespond!({ kind: "form", values: { note: "local only" } });
    captured[1]!.onRespond!({ kind: "confirm", confirmed: true });
    captured[3]!.onRespond!({ kind: "action", actionId: "demo" });
    expect(actions).toEqual([
      {
        source: "session.panel",
        adapterId: "test",
        actionId: "save",
        payload: { kind: "form", values: { note: "local only" } },
      },
      { source: "interaction", requestId: "q", payload: { kind: "confirm", confirmed: true } },
      { source: "card", actionId: "demo", payload: { index: 1 } },
    ]);
    expect(forbiddenApi).not.toHaveBeenCalled();
  });

  it("makes read-only simulation and resolved questions non-dispatchable even if handlers are invoked directly", () => {
    const actions: PreviewAction[] = [];
    frame(true, true, actions);
    expect(captured.every((props) => props.disabled)).toBe(true);
    for (const props of captured) {
      props.onRespond?.({ kind: "cancel" });
      props.onRespond?.({ kind: "action", actionId: "should-not-run" });
    }
    expect(actions).toEqual([]);
    captured.length = 0;
    frame(false, false, actions, {
      ...preview,
      interactions: [{ ...preview.interactions[0]!, state: "resolved" }],
    });
    expect(captured[1]?.disabled).toBe(true);
    captured[1]?.onRespond?.({ kind: "confirm", confirmed: true });
    expect(actions).toEqual([]);
    expect(forbiddenApi).not.toHaveBeenCalled();
  });

  it("mounts a collapsible developer tool with file upload, read-only simulation and local action log", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AdapterPreview initialJson={JSON.stringify(preview)} />
      </MemoryRouter>,
    );
    expect(html).toContain("Portable UI preview");
    expect(html).toContain("<details");
    expect(html).toContain("not a sandbox");
    expect(html).toContain("Upload preview file");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("Render preview");
    expect(html).toContain('type="file"');
    expect(html).toContain("Simulate read-only / disabled");
    expect(html).toContain("Preview action log");
    expect(forbiddenApi).not.toHaveBeenCalled();
  });
});

import type { Diagnostic, Panel, SessionAdaptersResult, ToolItemData } from "@switchyard/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AdapterDiagnostics,
  AdapterDiagnosticsList,
} from "../src/features/code/AdapterDiagnostics";
import {
  AdapterPanel,
  isAdapterViewStale,
  STALE_ADAPTER_VIEW,
} from "../src/features/code/AdapterPanel";
import { codeApi } from "../src/features/code/api";
import type { SessionContext } from "../src/features/code/hooks";
import { TimelineRow, ToolCard } from "../src/features/code/TranscriptItems";
import { mergeDiagnostics } from "../src/features/settings/diagnosticsApi";
import { apiGet, apiPost } from "../src/sync/api";
import { session } from "./fixtures";

const store = vi.hoisted(() => ({ current: {} as Record<string, any> }));
vi.mock("../src/sync/store", () => ({
  useSyncStore: (selector: (s: Record<string, any>) => unknown) => selector(store.current),
}));
vi.mock("../src/sync/api", async (original) => ({
  ...(await original<typeof import("../src/sync/api")>()),
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

const generation = "11111111-1111-4111-8111-111111111111";
const replacement = "22222222-2222-4222-8222-222222222222";
const ctx = {
  session: session("s", { adapterGeneration: replacement }),
  link: "connected",
  adapters: [],
  host: { id: "hst_1", connectivity: "connected" },
} as unknown as SessionContext;
const panel: Panel = {
  sessionId: "s",
  adapterId: "fixture",
  slot: "test",
  title: "Test panel",
  node: {
    t: "form",
    formId: "test",
    fields: [{ kind: "text", name: "note", label: "Fixture note" }],
    submitLabel: "Run fixture",
  },
  webRenderer: false,
  mobileFallback: null,
  updatedAt: "2026-01-01T00:00:00Z",
  adapterGeneration: generation,
};
const diagnostic = (patch: Partial<Diagnostic> = {}): Diagnostic => ({
  at: "2026-01-01T00:00:00Z",
  adapterId: "fixture",
  sessionId: null,
  level: "error",
  message: "Broken fixture",
  ...patch,
});

beforeEach(() => {
  vi.clearAllMocks();
  store.current = { sessions: { s: ctx.session }, hosts: { hst_1: ctx.host }, interactions: {} };
});

describe("adapter generation compatibility", () => {
  it("only marks views stale when both generations are known", () => {
    expect(isAdapterViewStale(generation, replacement)).toBe(true);
    expect(isAdapterViewStale(generation, generation)).toBe(false);
    expect(isAdapterViewStale(undefined, replacement)).toBe(false);
    expect(isAdapterViewStale(generation, undefined)).toBe(false);
    expect(isAdapterViewStale()).toBe(false);
  });
  it("retains portable panel evidence while disabling stale controls", () => {
    const html = renderToStaticMarkup(<AdapterPanel ctx={ctx} panel={panel} />);
    expect(html).toContain("Fixture note");
    expect(html).not.toContain(">Run fixture<");
    expect(html).toContain('disabled=""');
    expect(html).toContain(STALE_ADAPTER_VIEW);
    const legacy = renderToStaticMarkup(
      <AdapterPanel ctx={ctx} panel={{ ...panel, adapterGeneration: undefined }} />,
    );
    expect(legacy).not.toContain('disabled=""');
    expect(legacy).toContain(">Run fixture<");
    expect(legacy).not.toContain(STALE_ADAPTER_VIEW);
  });
  it("keeps historical tool cards and output readable but not actionable", () => {
    const data = {
      toolCallId: "tool",
      name: "fixture",
      status: "ok",
      startedAt: "2026-01-01T00:00:00Z",
      args: {},
      output: "Original tool output",
      adapterId: "fixture",
      card: panel.node,
      adapterGeneration: generation,
    } as ToolItemData;
    const html = renderToStaticMarkup(<ToolCard data={data} stream={null} sessionId="s" />);
    expect(html).toContain("Original tool output");
    expect(html).toContain("Fixture note");
    expect(html).not.toContain(">Run fixture<");
    expect(html).toContain('disabled=""');
    expect(html).toContain(STALE_ADAPTER_VIEW);
  });
  it("retains the original custom message on stale notice cards", () => {
    const html = renderToStaticMarkup(
      <TimelineRow
        entry={{
          type: "item",
          key: "notice",
          stream: null,
          item: {
            id: "notice",
            sessionId: "s",
            order: 1,
            at: "2026-01-01T00:00:00Z",
            kind: "notice",
            data: {
              level: "info",
              text: "Original message",
              adapterId: "fixture",
              card: panel.node,
              adapterGeneration: generation,
            },
          },
        }}
        sessionId="s"
        interactionReadOnly={null}
        draftEmpty
        onUseSuggestion={() => {}}
        highlightInteractionId={null}
      />,
    );
    expect(html).toContain("Original message");
    expect(html).toContain('disabled=""');
    expect(html).toContain(STALE_ADAPTER_VIEW);
  });
});

describe("adapter diagnostics scope", () => {
  it("keeps history host identity, infers live hosts only from sessions, and never matches by adapter ID", () => {
    const history = { ...diagnostic(), hostId: "host-a" };
    const live = diagnostic({ sessionId: "s" });
    const merged = mergeDiagnostics([history], [live, diagnostic()], { s: ctx.session });
    expect(merged).toHaveLength(3);
    expect(merged.find((d) => d.sessionId === "s")?.hostId).toBe("hst_1");
    expect(merged.filter((d) => d.hostId === "host-a")).toEqual([history]);
    expect(merged.filter((d) => !d.hostId)).toEqual([diagnostic()]);
    expect(
      mergeDiagnostics([{ ...live, hostId: "hst_1", seq: 3 }], [live], { s: ctx.session }),
    ).toHaveLength(1);
    expect(
      mergeDiagnostics([{ ...live, hostId: "server-host" }], [], { s: ctx.session })[0]?.hostId,
    ).toBe("server-host");
  });
  it("shows an old-host explanation without exposing a reload control", () => {
    const html = renderToStaticMarkup(<AdapterDiagnostics ctx={ctx} />);
    expect(html).toContain("does not support adapter development");
    expect(html).not.toContain("<button");
    expect(apiGet).not.toHaveBeenCalled();
  });
  it("separates catalog and runtime status and discloses provenance in expandable details", () => {
    const result: SessionAdaptersResult = {
      generation,
      runtimeId: "runtime",
      reloadable: false,
      blockedReason: "Pending question",
      adapters: [
        {
          id: "fixture",
          version: "1.0.0",
          tier: "plugin",
          status: "active",
          detail: null,
          target: { extension: "fixture-extension", versionRange: "*", testedVersions: [] },
          capabilities: [],
          webRenderer: false,
          runtimeStatus: "disabled",
          runtimeDetail: "Target extension is not enabled in this session.",
          provenance: {
            scope: "project",
            source: "..",
            packageDir: "/private/source",
            manifestPath: "/private/manifest",
            targetVersion: "2.0.0",
            entrypoints: ["src/index.ts"],
            evidence: "runtime-reported",
          },
        },
      ],
      diagnostics: [diagnostic({ sessionId: "s" })],
    };
    const html = renderToStaticMarkup(<AdapterDiagnosticsList result={result} />);
    expect(html).toContain("Catalog: active · Runtime: disabled");
    expect(html).toContain("Target 2.0.0 · project");
    expect(html).toContain("Target extension is not enabled");
    expect(html).toContain("<summary");
    expect(html).toContain("/private/source");
    expect(html).toContain("src/index.ts");
    expect(html).toContain("Broken fixture");
  });
});

describe("typed adapter REST calls", () => {
  it("encodes session identity and propagates abort signals to inspection", () => {
    const signal = new AbortController().signal;
    codeApi.adapters("session/one", signal);
    expect(apiGet).toHaveBeenCalledWith("/api/sessions/session%2Fone/adapters", undefined, signal);
    codeApi.reloadAdapters("session/one");
    expect(apiPost).toHaveBeenCalledWith("/api/sessions/session%2Fone/adapters/reload");
  });
  it("sends the caller's rendered generation and leaves legacy actions generation-less", () => {
    codeApi.adapterAction("s", "fixture", "run", { text: "draft" }, generation);
    expect(apiPost).toHaveBeenLastCalledWith("/api/sessions/s/adapter-action", {
      adapterId: "fixture",
      actionId: "run",
      payload: { text: "draft" },
      generation,
    });
    codeApi.adapterAction("s", "fixture", "run");
    expect(apiPost).toHaveBeenLastCalledWith("/api/sessions/s/adapter-action", {
      adapterId: "fixture",
      actionId: "run",
      payload: undefined,
    });
  });
});

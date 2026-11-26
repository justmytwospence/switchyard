import {
  ADAPTER_PREVIEW_MAX_BYTES,
  type InteractionResponse,
  type Panel,
  type AdapterPreview as Preview,
  parseAdapterPreviewJson,
  type UINode,
} from "@switchyard/protocol";
import { useId, useState } from "react";
import { UINodeRenderer } from "../../components/intent/UINodeRenderer";
import { Button } from "../../components/ui/Button";

export interface AdapterPreviewProps {
  /** Optional developer fixture; never persisted or fetched. Normally mount with no props. */
  initialJson?: string;
}

export const PREVIEW_ACTION_NOTICE = "Preview action — not sent to Pi";
export interface PreviewAction {
  source: string;
  adapterId?: string;
  requestId?: string;
  actionId?: string;
  payload?: unknown;
}

/** Local-only log envelope. No session identity, coordinator API or dispatch is available. */
export function previewActionEntry(envelope: PreviewAction): string {
  return `${PREVIEW_ACTION_NOTICE}\n${JSON.stringify(envelope, null, 2)}`;
}

/** Developer tool: JSON stays in React memory and every interaction is simulated locally. */
export function AdapterPreview({ initialJson = "" }: AdapterPreviewProps) {
  const id = useId();
  const [json, setJson] = useState(initialJson);
  const [preview, setPreview] = useState<Preview | null>(() => {
    try {
      return initialJson ? parseAdapterPreviewJson(initialJson) : null;
    } catch {
      return null;
    }
  });
  const [error, setError] = useState<string | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const record = (envelope: PreviewAction) => {
    if (!disabled) setLog((previous) => [...previous.slice(-99), previewActionEntry(envelope)]);
  };
  const load = (text: string) => {
    setPreview(null);
    setLog([]);
    try {
      setPreview(parseAdapterPreviewJson(text));
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  return (
    <details className="min-w-0 rounded-lg border border-border p-4">
      <summary className="cursor-pointer font-semibold">Portable UI preview</summary>
      <div className="mt-3 flex min-w-0 flex-col gap-3">
        <p className="text-sm text-muted">
          Developer tool. Run adapter:preview with an explicitly selected trusted adapter in a
          separate Node process (not a sandbox), then paste or upload its JSON here. This browser
          only renders portable UI and simulates actions. Nothing is installed, persisted or sent to
          Pi or the server.
        </p>
        <label htmlFor={`${id}-json`} className="text-sm font-medium">
          Preview JSON (up to 1 MiB)
        </label>
        <textarea
          id={`${id}-json`}
          className="min-h-40 w-full rounded border border-border bg-surface p-2 font-mono text-xs"
          value={json}
          onChange={(event) => setJson(event.target.value)}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => load(json)}>Render preview</Button>
          <label className="text-sm">
            Upload preview JSON
            <input
              type="file"
              accept=".json,application/json"
              className="ml-2 max-w-full"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                if (file.size > ADAPTER_PREVIEW_MAX_BYTES) {
                  setPreview(null);
                  setError("Preview exceeds 1 MiB input limit");
                  return;
                }
                try {
                  const text = await file.text();
                  setJson(text);
                  load(text);
                } catch (failure) {
                  setError(String(failure));
                }
              }}
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={disabled}
              onChange={(event) => setDisabled(event.target.checked)}
            />
            Simulate read-only / disabled
          </label>
          <Button
            variant="secondary"
            onClick={() => {
              setJson("");
              setPreview(null);
              setLog([]);
              setError(null);
            }}
          >
            Clear preview
          </Button>
        </div>
        {error && (
          <pre
            role="alert"
            className="max-h-52 overflow-auto whitespace-pre-wrap break-words text-sm text-danger"
          >
            {error}
          </pre>
        )}
        {preview && (
          <>
            <h3 className="font-medium">
              {preview.name} · {preview.adapter.id}@{preview.adapter.version}
            </h3>
            <div className="grid min-w-0 grid-cols-1 gap-4 2xl:grid-cols-[minmax(0,1fr)_390px]">
              <PreviewFrame preview={preview} phone={false} disabled={disabled} onAction={record} />
              <PreviewFrame preview={preview} phone disabled={disabled} onAction={record} />
            </div>
            <details>
              <summary>Steps and diagnostics</summary>
              <ul className="text-sm">
                {preview.steps.map((step) => (
                  <li key={step.index}>
                    {step.index + 1}. {step.kind}: {step.ok ? "OK" : step.error}
                  </li>
                ))}
                {preview.diagnostics.map((diagnostic, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: immutable fixture diagnostics have no IDs
                  <li key={`${index}-${diagnostic.at}`}>
                    {diagnostic.level}: {diagnostic.message}
                  </li>
                ))}
              </ul>
            </details>
          </>
        )}
        <section aria-label="Preview action log" className="min-w-0">
          <h3 className="text-sm font-medium">Local simulated actions</h3>
          {log.length === 0 && <p className="text-sm text-muted">No preview actions yet.</p>}
          <pre
            aria-live="polite"
            className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs"
          >
            {log.join("\n\n")}
          </pre>
        </section>
      </div>
    </details>
  );
}

export interface PreviewFrameProps {
  preview: Preview;
  phone: boolean;
  disabled: boolean;
  onAction: (envelope: PreviewAction) => void;
}

/** Uses the shared portable renderer/forms, not live AdapterPanel or InteractionCard (which dispatch API calls). */
export function PreviewFrame({ preview, phone, disabled, onAction }: PreviewFrameProps) {
  const record = (envelope: PreviewAction) => {
    if (!disabled) onAction(envelope);
  };
  const renderNode = (node: UINode, envelope: PreviewAction, resolved = false) => (
    <UINodeRenderer
      node={node}
      disabled={disabled || resolved}
      busy={false}
      onRespond={(response: InteractionResponse) => {
        if (!resolved) record({ ...envelope, payload: response });
      }}
      onAction={(actionId) => {
        if (!resolved) record({ ...envelope, actionId });
      }}
      onOpenFile={(path) => record({ source: "file", payload: { path } })}
    />
  );
  const renderPanel = (panel: Panel) => (
    <article
      key={JSON.stringify([panel.adapterId, panel.slot])}
      className="min-w-0 rounded border border-border p-3"
    >
      <h4 className="mb-2 text-sm font-semibold">{panel.title}</h4>
      {panel.node ? (
        renderNode(panel.node, {
          source: panel.contribution?.placement ?? "panel",
          adapterId: panel.adapterId,
          actionId: panel.contribution?.actionId,
        })
      ) : (
        <p className="text-sm">{panel.mobileFallback}</p>
      )}
      {panel.contribution?.actionId &&
        ["palette.item", "slash.command"].includes(panel.contribution.placement) &&
        panel.node?.t !== "form" && (
          <Button
            disabled={disabled}
            onClick={() =>
              record({
                source: panel.contribution!.placement,
                adapterId: panel.adapterId,
                actionId: panel.contribution!.actionId,
              })
            }
          >
            Simulate {panel.title}
          </Button>
        )}
    </article>
  );
  // Same placement descriptors as session slots; deliberately no live session/store lookup.
  const placements = [
    "sidebar.header",
    "session.panel",
    "composer.tracker",
    "composer.pill",
    "session.badge",
    "palette.item",
    "slash.command",
    "sidebar.footer",
  ] as const;
  return (
    <section
      aria-label={phone ? "Phone preview 390px" : "Desktop preview"}
      className="min-w-0 max-w-full overflow-x-auto rounded-xl border border-border bg-surface-1 p-3"
      // Refs/Markdown links are inspectable but never navigate a live route or remote URL.
      onClickCapture={(event) => {
        const anchor = (event.target as HTMLElement).closest("a");
        if (!anchor) return;
        event.preventDefault();
        event.stopPropagation();
        record({ source: "link", payload: { href: anchor.getAttribute("href") } });
      }}
    >
      <div
        className="flex min-w-0 flex-col gap-3"
        style={phone ? { width: 390, maxWidth: "100%" } : undefined}
      >
        <h3 className="text-sm font-semibold">
          {phone ? "Phone · 390px" : "Desktop · portable UI"}
          {disabled ? " · Read-only" : ""}
        </h3>
        {preview.panels.filter((panel) => !panel.contribution).map(renderPanel)}
        {placements.map((placement) => {
          const panels = preview.panels
            .filter((panel) => panel.contribution?.placement === placement)
            .sort((a, b) => (a.contribution?.order ?? 0) - (b.contribution?.order ?? 0));
          return panels.length ? (
            <section key={placement} aria-label={placement} className="flex min-w-0 flex-col gap-2">
              <h4 className="text-xs text-muted">
                {phone && placement.startsWith("sidebar.") ? `Details · ${placement}` : placement}
              </h4>
              {panels.map(renderPanel)}
            </section>
          ) : null;
        })}
        {preview.interactions.map((interaction) => (
          <article
            key={interaction.request.id}
            aria-label={`Question: ${interaction.request.title}`}
            className="min-w-0 rounded border border-border p-3"
          >
            <h4 className="mb-2 text-sm font-semibold">
              {interaction.request.title} · {interaction.state}
            </h4>
            {renderNode(
              interaction.presentation,
              { source: "interaction", requestId: interaction.request.id },
              interaction.state === "resolved",
            )}
          </article>
        ))}
        {preview.cards.map((node, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: immutable fixture cards are positional
          <article key={`card-${index}`} className="min-w-0 rounded border border-border p-3">
            {renderNode(node, { source: "card", payload: { index } })}
          </article>
        ))}
      </div>
    </section>
  );
}

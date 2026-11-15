import {
  ADAPTER_PREVIEW_SESSION_ID,
  type AdapterPreview,
  AdapterPreviewFixtureSchema,
  AdapterPreviewSchema,
  boundContributionJson,
  type Diagnostic,
  type Panel,
  validateUINode,
} from "@switchyard/protocol";
import { genericClaim } from "./generic.js";
import { AdapterRegistry, loadAdapterFromDir } from "./registry.js";
import type { ClaimedInteraction } from "./session.js";
import type { AdapterEffect } from "./types.js";

const timestamp = "2026-01-01T00:00:00.000Z";
const message = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 4000);

/**
 * Execute an explicitly selected TRUSTED adapter using the real registry/session dispatch.
 * This is not a sandbox: adapter imports/hooks have normal Node privileges. The fake host
 * supplies only in-memory state and an effect sink, never Pi, a model, a token or a connection.
 * Invoke in a separate process (scripts/preview-adapter.mjs) for authoring previews.
 */
export async function runAdapterPreview({
  adapter: directory,
  fixture: input,
}: {
  adapter: string;
  fixture: unknown;
}): Promise<AdapterPreview> {
  // Validate before importing any adapter code.
  const fixture = AdapterPreviewFixtureSchema.parse(input);
  const { adapter, warnings } = await loadAdapterFromDir(directory, "owner");
  const registry = new AdapterRegistry();
  registry.setAdapters([adapter]);
  const preview: AdapterPreview = {
    version: 1,
    name: fixture.name,
    adapter: { id: adapter.manifest.id, version: adapter.manifest.version },
    steps: [],
    panels: [],
    interactions: [],
    cards: [],
    diagnostics: [],
  };
  const diagnostic = (level: Diagnostic["level"], text: string) => {
    if (preview.diagnostics.length >= 200) throw new Error("Preview exceeds 200 diagnostics");
    preview.diagnostics.push({
      sessionId: ADAPTER_PREVIEW_SESSION_ID,
      adapterId: adapter.manifest.id,
      level,
      message: text.slice(0, 4000),
      at: timestamp,
    });
  };
  for (const warning of warnings) diagnostic("warning", warning);
  const claimed = new Map<string, ClaimedInteraction>();
  let sinkError: unknown;
  let stepErrors: string[] = [];
  const capture = (effect: AdapterEffect) => {
    try {
      switch (effect.type) {
        case "panel": {
          const key = (p: Panel) => p.adapterId === effect.adapterId && p.slot === effect.slot;
          preview.panels = preview.panels.filter((p) => !key(p));
          if (effect.node !== null) {
            const { type: _type, ...panel } = effect;
            // Portable only: do not load or emit the custom renderer entrypoint.
            const portable = {
              ...panel,
              node: validateUINode(effect.node),
              sessionId: ADAPTER_PREVIEW_SESSION_ID,
              webRenderer: false,
              updatedAt: timestamp,
            };
            // Validate and detach mutable adapter-owned objects immediately.
            const checked = AdapterPreviewSchema.parse({
              ...preview,
              panels: [...preview.panels, portable],
            });
            preview.panels = checked.panels;
          }
          break;
        }
        case "diagnostic":
          diagnostic(effect.level, effect.message);
          if (effect.level === "error") stepErrors.push(effect.message);
          break;
        case "log":
          diagnostic(effect.level === "debug" ? "info" : effect.level, effect.message);
          if (effect.level === "error") stepErrors.push(effect.message);
          break;
        case "attention":
          diagnostic("info", `Simulated attention (${effect.reason}): ${effect.summary}`);
          break;
        case "subagent":
          diagnostic(
            "info",
            `Simulated subagent link: ${effect.link.label} (${effect.link.status})`,
          );
          break;
        case "state":
          // State is held by AdapterSession; do not export arbitrary persisted state.
          if (effect.value !== undefined) boundContributionJson(effect.value);
          break;
      }
    } catch (error) {
      // AdapterSession intentionally isolates sink exceptions. Keep them visible to the runner.
      sinkError = error;
    }
  };
  const session = registry.openSession({
    sessionId: ADAPTER_PREVIEW_SESSION_ID,
    initialState: fixture.initialState,
    emit: capture,
  });
  let restored = false;
  try {
    for (const [index, step] of fixture.steps.entries()) {
      stepErrors = [];
      sinkError = undefined;
      let error: string | null = null;
      const oldCards = [...preview.cards];
      const oldInteractions = [...preview.interactions];
      try {
        switch (step.kind) {
          case "restore": {
            if (restored || index !== 0)
              throw new Error("Restore must be the first step and run only once on a new context");
            const restorable = session as typeof session & { restore?: () => Promise<void> };
            if (!restorable.restore)
              throw new Error("This SDK does not support presentation restore");
            restored = true;
            await restorable.restore();
            break;
          }
          case "toolStart": {
            await session.onToolStart(step.data);
            const card = await session.toolCard(step.data);
            if (card) preview.cards.push(card.node);
            break;
          }
          case "toolUpdate": {
            await session.onToolUpdate(step.data);
            const card = await session.toolCard({ ...step.data, result: step.data.partialResult });
            if (card) preview.cards.push(card.node);
            break;
          }
          case "toolEnd": {
            await session.onToolEnd(step.data);
            const card = await session.toolCard(step.data);
            if (card) preview.cards.push(card.node);
            break;
          }
          case "status": {
            if (
              !(await session.onStatus(step.data.key, step.data.text)) &&
              step.data.text !== undefined
            ) {
              preview.cards.push({ t: "text", text: `${step.data.key}: ${step.data.text}` });
            }
            break;
          }
          case "widget": {
            if (!(await session.onWidget(step.data.key, step.data.lines)) && step.data.lines) {
              preview.cards.push({ t: "text", text: step.data.lines.join("\n") });
            }
            break;
          }
          case "dialog": {
            if (preview.interactions.some((i) => i.request.id === step.data.id))
              throw new Error(`Duplicate dialog ${step.data.id}`);
            const outcome = await session.onUiRequest(step.data);
            preview.interactions.push({
              request: step.data,
              presentation:
                outcome.kind === "claim"
                  ? outcome.claim.presentation
                  : genericClaim(step.data).presentation,
              state: outcome.kind === "queued" ? "resolved" : "pending",
            });
            if (outcome.kind === "claim") claimed.set(step.data.id, outcome);
            break;
          }
          case "answer": {
            const interaction = claimed.get(step.data.requestId);
            if (!interaction) throw new Error(`No pending dialog ${step.data.requestId}`);
            const result = await session.respond(interaction, step.data.response);
            const shown = preview.interactions.find((i) => i.request.id === step.data.requestId)!;
            if (result.kind === "reclaim") {
              claimed.set(step.data.requestId, {
                kind: "claim",
                claim: result.claim,
                adapterId: null,
                request: result.request,
              });
              shown.presentation = result.claim.presentation;
              throw new Error(result.reason);
            }
            claimed.delete(step.data.requestId);
            shown.state = "resolved";
            break;
          }
          case "customMessage": {
            await session.onCustomMessage(step.data);
            if (step.data.display !== false) {
              const card = await session.customMessageCard(step.data);
              if (card) preview.cards.push(card.node);
            }
            break;
          }
          case "action": {
            const result = await session.onAction(
              adapter.manifest.id,
              step.data.actionId,
              step.data.payload,
            );
            if (!result.ok) throw new Error(result.reason);
            break;
          }
        }
        if (sinkError) throw sinkError;
        if (stepErrors.length) throw new Error(stepErrors.join("; "));
        AdapterPreviewSchema.parse(preview);
      } catch (failure) {
        error = message(failure);
        // Invalid cards must not make the entire output unrenderable. Keep a legitimate
        // generic reclaim (including its pending state) when a claim mapper failed.
        preview.cards = oldCards;
        try {
          AdapterPreviewSchema.parse(preview);
        } catch {
          preview.interactions = oldInteractions;
        }
        if (preview.diagnostics.length < 200) diagnostic("error", error);
      }
      preview.steps.push({ index, kind: step.kind, ok: error === null, error });
    }
  } finally {
    registry.closeSession(ADAPTER_PREVIEW_SESSION_ID);
  }
  return AdapterPreviewSchema.parse(preview);
}

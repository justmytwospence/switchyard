import { z } from "zod";
import {
  boundContributionJson,
  contributionSlot,
  validateContribution,
  validateContributionCard,
} from "./contributions.js";
import { Diagnostic, Panel } from "./entities.js";
import { InteractionResponseSchema, validateUINode } from "./ui.js";

export const ADAPTER_PREVIEW_MAX_BYTES = 1024 * 1024;
export const ADAPTER_PREVIEW_MAX_STEPS = 200;
export const ADAPTER_PREVIEW_SESSION_ID = "ses_adapter_preview";

/** Apply JSON/complexity limits before recursive protocol schemas are entered. */
function bounded(input: unknown, ctx: z.RefinementCtx): unknown {
  try {
    boundContributionJson(input, ADAPTER_PREVIEW_MAX_BYTES);
    return input;
  } catch (error) {
    ctx.addIssue({ code: "custom", message: (error as Error).message });
    return z.NEVER;
  }
}

const Id = z.string().min(1).max(200);
const Text = z.string().max(64 * 1024);
const Tool = { toolCallId: Id, name: Id, args: z.unknown() };
const DialogCommon = { id: Id, title: Text };
// Structural Pi RPC dialog shape: protocol must not depend on the adapter SDK.
export const AdapterPreviewPiUiRequestSchema = z.discriminatedUnion("method", [
  z
    .object({
      ...DialogCommon,
      method: z.literal("select"),
      options: z.array(Text).max(200),
      timeout: z.number().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      ...DialogCommon,
      method: z.literal("confirm"),
      message: Text,
      timeout: z.number().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      ...DialogCommon,
      method: z.literal("input"),
      placeholder: Text.optional(),
      timeout: z.number().nonnegative().optional(),
    })
    .strict(),
  z.object({ ...DialogCommon, method: z.literal("editor"), prefill: Text.optional() }).strict(),
]);

export const AdapterPreviewStepSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("restore") }).strict(),
  z.object({ kind: z.literal("toolStart"), data: z.object(Tool).strict() }).strict(),
  z
    .object({
      kind: z.literal("toolUpdate"),
      data: z
        .object({ ...Tool, partialResult: z.unknown(), details: z.unknown().optional() })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("toolEnd"),
      data: z
        .object({
          ...Tool,
          result: z.unknown(),
          isError: z.boolean(),
          details: z.unknown().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("status"),
      data: z.object({ key: Id, text: Text.optional() }).strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("widget"),
      data: z.object({ key: Id, lines: z.array(Text).max(200).optional() }).strict(),
    })
    .strict(),
  z.object({ kind: z.literal("dialog"), data: AdapterPreviewPiUiRequestSchema }).strict(),
  z
    .object({
      kind: z.literal("answer"),
      data: z.object({ requestId: Id, response: InteractionResponseSchema }).strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("customMessage"),
      data: z
        .object({
          customType: Id,
          content: z.unknown(),
          display: z.boolean().optional(),
          details: z.unknown().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("action"),
      data: z.object({ actionId: Id, payload: z.unknown() }).strict(),
    })
    .strict(),
]);
export type AdapterPreviewStep = z.infer<typeof AdapterPreviewStepSchema>;

export const AdapterPreviewFixtureSchema = z
  .unknown()
  .transform(bounded)
  .pipe(
    z
      .object({
        version: z.literal(1),
        name: z.string().min(1).max(200),
        initialState: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
        steps: z.array(AdapterPreviewStepSchema).max(ADAPTER_PREVIEW_MAX_STEPS),
      })
      .strict(),
  );
export type AdapterPreviewFixture = z.infer<typeof AdapterPreviewFixtureSchema>;

const PortableNode = z.unknown().transform((input, ctx) => {
  try {
    return validateUINode(input);
  } catch (error) {
    ctx.addIssue({ code: "custom", message: (error as Error).message });
    return z.NEVER;
  }
});
const PreviewPanel = Panel.extend({ webRenderer: z.literal(false) }).superRefine((panel, ctx) => {
  try {
    if (panel.sessionId !== ADAPTER_PREVIEW_SESSION_ID)
      throw new Error("Preview panels must use the fake preview session");
    if (panel.node !== null) validateUINode(panel.node);
    if (panel.contribution) {
      const { id, ...descriptor } = panel.contribution;
      if (panel.slot !== contributionSlot(id))
        throw new Error("Contribution slot does not match its id");
      validateContribution(id, {
        ...descriptor,
        title: panel.title,
        node: panel.node,
        mobileFallback: panel.mobileFallback,
        ...(panel.state === undefined ? {} : { state: panel.state }),
      });
    }
  } catch (error) {
    ctx.addIssue({ code: "custom", message: (error as Error).message });
  }
});

export const AdapterPreviewSchema = z
  .unknown()
  .transform(bounded)
  .pipe(
    z
      .object({
        version: z.literal(1),
        name: z.string().min(1).max(200),
        adapter: z.object({ id: Id, version: Id }).strict(),
        steps: z
          .array(
            z
              .object({
                index: z
                  .number()
                  .int()
                  .min(0)
                  .max(ADAPTER_PREVIEW_MAX_STEPS - 1),
                kind: z.enum([
                  "restore",
                  "toolStart",
                  "toolUpdate",
                  "toolEnd",
                  "status",
                  "widget",
                  "dialog",
                  "answer",
                  "customMessage",
                  "action",
                ]),
                ok: z.boolean(),
                error: z.string().max(4000).nullable(),
              })
              .strict(),
          )
          .max(ADAPTER_PREVIEW_MAX_STEPS),
        panels: z.array(PreviewPanel).max(256),
        interactions: z
          .array(
            z
              .object({
                request: AdapterPreviewPiUiRequestSchema,
                presentation: PortableNode,
                state: z.enum(["pending", "resolved"]),
              })
              .strict(),
          )
          .max(ADAPTER_PREVIEW_MAX_STEPS),
        cards: z
          .array(
            z.unknown().transform((input, ctx) => {
              try {
                return validateContributionCard(input);
              } catch (error) {
                ctx.addIssue({ code: "custom", message: (error as Error).message });
                return z.NEVER;
              }
            }),
          )
          .max(ADAPTER_PREVIEW_MAX_STEPS * 3),
        diagnostics: z
          .array(
            Diagnostic.extend({ message: z.string().max(4000) }).refine(
              (d) => d.sessionId === null || d.sessionId === ADAPTER_PREVIEW_SESSION_ID,
              "Preview diagnostics must use the fake preview session",
            ),
          )
          .max(200),
      })
      .strict()
      .superRefine((preview, ctx) => {
        const slots = new Set<string>();
        let contributions = 0;
        for (const panel of preview.panels) {
          if (panel.adapterId !== preview.adapter.id)
            ctx.addIssue({
              code: "custom",
              message: "Preview panel belongs to a different adapter",
            });
          const key = JSON.stringify([panel.adapterId, panel.slot]);
          if (slots.has(key))
            ctx.addIssue({ code: "custom", message: "Duplicate preview panel slot" });
          slots.add(key);
          if (panel.contribution && ++contributions > 64)
            ctx.addIssue({
              code: "custom",
              message: "At most 64 contributions per adapter/session",
            });
        }
        const requests = new Set<string>();
        for (const interaction of preview.interactions) {
          if (requests.has(interaction.request.id))
            ctx.addIssue({ code: "custom", message: "Duplicate preview dialog" });
          requests.add(interaction.request.id);
        }
      }),
  );
export type AdapterPreview = z.infer<typeof AdapterPreviewSchema>;

function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes > ADAPTER_PREVIEW_MAX_BYTES) break;
  }
  return bytes;
}

/** Bound the raw UTF-8 input too (including JSON whitespace), before JSON.parse. */
export function parseAdapterPreviewJson(text: string): AdapterPreview {
  if (utf8Bytes(text) > ADAPTER_PREVIEW_MAX_BYTES)
    throw new Error("Preview exceeds 1 MiB input limit");
  return AdapterPreviewSchema.parse(JSON.parse(text));
}

export function parseAdapterPreviewFixtureJson(text: string): AdapterPreviewFixture {
  if (utf8Bytes(text) > ADAPTER_PREVIEW_MAX_BYTES)
    throw new Error("Fixture exceeds 1 MiB input limit");
  return AdapterPreviewFixtureSchema.parse(JSON.parse(text));
}

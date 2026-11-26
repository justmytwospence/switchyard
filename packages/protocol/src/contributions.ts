import { z } from "zod";
import { type UINode, validateUINode } from "./ui.js";

export const ContributionPlacement = z.enum([
  "sidebar.header",
  "sidebar.footer",
  "session.panel",
  "composer.pill",
  /** `adapter.trackers.v1`: a live summary above the input that opens its detail. */
  "composer.tracker",
  /** `adapter.trackers.v1`: a short word on the session's navigator row. */
  "session.badge",
  "palette.item",
  "slash.command",
]);
export type ContributionPlacement = z.infer<typeof ContributionPlacement>;

const Id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/);
const ActionId = z.string().min(1).max(200);
const Keywords = z.array(z.string().min(1).max(80)).max(20);
/** What a `composer.tracker` shows beside its title. */
export const TrackerSummary = z
  .object({
    /** Progress or a count, such as "2/5" or "3". */
    count: z.string().min(1).max(24).optional(),
    status: z.enum(["idle", "running", "ok", "error", "attention"]).optional(),
    /** The step in progress, such as the current todo. */
    step: z.string().min(1).max(120).optional(),
  })
  .strict();
export type TrackerSummary = z.infer<typeof TrackerSummary>;
const Common = {
  placement: ContributionPlacement,
  order: z.number().int().min(-1000).max(1000).optional(),
  actionId: ActionId.optional(),
  tracker: TrackerSummary.optional(),
};
export const ContributionDescriptor = z
  .object({
    id: Id,
    ...Common,
    name: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,39}$/)
      .optional(),
    keywords: Keywords.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.placement === "slash.command" && (!v.name || !v.actionId)) {
      ctx.addIssue({ code: "custom", message: "Slash commands need name and actionId" });
    }
    if (v.placement === "palette.item" && !v.actionId) {
      ctx.addIssue({ code: "custom", message: "Palette items need actionId" });
    }
    if (v.placement !== "slash.command" && v.name !== undefined) {
      ctx.addIssue({ code: "custom", message: "Only slash commands have names" });
    }
    if (v.placement !== "palette.item" && v.keywords !== undefined) {
      ctx.addIssue({ code: "custom", message: "Only palette items have keywords" });
    }
    if (v.placement === "composer.pill" && v.actionId !== undefined) {
      ctx.addIssue({ code: "custom", message: "Composer pills are not interactive" });
    }
    if (v.placement === "session.badge" && v.actionId !== undefined) {
      ctx.addIssue({ code: "custom", message: "Session badges are not interactive" });
    }
    if (v.placement !== "composer.tracker" && v.tracker !== undefined) {
      ctx.addIssue({ code: "custom", message: "Only composer trackers have a tracker summary" });
    }
  });
export type ContributionDescriptor = z.infer<typeof ContributionDescriptor>;

const ContributionInput = z
  .object({
    ...Common,
    title: z.string().min(1).max(100),
    node: z.unknown(),
    mobileFallback: z.string().min(1).max(2000),
    state: z.unknown().optional(),
    name: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,39}$/)
      .optional(),
    keywords: Keywords.optional(),
  })
  .strict();
export type AdapterContribution = Omit<z.infer<typeof ContributionInput>, "node"> & {
  node: UINode;
};

export const SESSION_BADGE_MAX = 24;

/** Bound untrusted JSON before recursive Zod parsing; avoid cycles and pathological inputs. */
export function boundContributionJson(value: unknown, maxBytes = 256 * 1024): void {
  const stack: { value: unknown; depth: number; leave?: boolean }[] = [{ value, depth: 0 }];
  const ancestors = new Set<object>();
  let count = 0;
  let characterCount = 0;
  while (stack.length) {
    const { value: v, depth, leave } = stack.pop()!;
    if (leave) {
      ancestors.delete(v as object);
      continue;
    }
    if (++count > 20_000 || depth > 32) throw new Error("Contribution exceeds complexity limit");
    if (typeof v === "string") {
      characterCount += v.length;
      if (characterCount > maxBytes) throw new Error("Contribution exceeds size limit");
    }
    if (v === null || typeof v === "string" || typeof v === "boolean") continue;
    if (typeof v === "number" && Number.isFinite(v)) continue;
    if (!v || typeof v !== "object") throw new Error("Contribution contains a non-JSON value");
    if (ancestors.has(v)) throw new Error("Contribution contains a cycle");
    ancestors.add(v);
    stack.push({ value: v, depth, leave: true });
    if (Array.isArray(v)) {
      for (const child of v) stack.push({ value: child, depth: depth + 1 });
    } else {
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) {
        throw new Error("Contribution contains a non-plain object");
      }
      for (const [key, child] of Object.entries(v)) {
        characterCount += key.length;
        if (characterCount > maxBytes) throw new Error("Contribution exceeds size limit");
        stack.push({ value: child, depth: depth + 1 });
      }
    }
  }
  const json = JSON.stringify(value);
  let bytes = 0;
  for (const char of json) {
    const code = char.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes > maxBytes) throw new Error("Contribution exceeds size limit");
  }
}

function hasInteractive(node: UINode): boolean {
  if (node.t === "form" || node.t === "confirm") return true;
  if (node.t === "section") return node.children.some(hasInteractive);
  if (node.t === "list") return node.items.some(hasInteractive);
  if (node.t === "tabs") return node.tabs.some((t) => t.children.some(hasInteractive));
  return false;
}

export function validateContribution(
  id: string,
  input: unknown,
): {
  descriptor: ContributionDescriptor;
  title: string;
  node: UINode;
  mobileFallback: string;
  state?: unknown;
} {
  Id.parse(id);
  boundContributionJson(input);
  const parsed = ContributionInput.parse(input);
  const node = validateUINode(parsed.node);
  const { title, mobileFallback, state, node: _node, ...meta } = parsed;
  const descriptor = ContributionDescriptor.parse({ ...meta, id });
  if (descriptor.placement === "slash.command" && node.t !== "form") {
    throw new Error("Slash command content must be a form");
  }
  if (descriptor.placement === "composer.pill" && node.t !== "text" && node.t !== "progress") {
    throw new Error("Composer pill content must be text or progress");
  }
  if (descriptor.placement === "session.badge") {
    if (node.t !== "text" && node.t !== "badge") {
      throw new Error("Session badge content must be text or a badge");
    }
    if (node.text.length === 0 || node.text.length > SESSION_BADGE_MAX) {
      throw new Error(`Session badge text must be 1 to ${SESSION_BADGE_MAX} characters`);
    }
  }
  if (descriptor.placement !== "session.panel" && state !== undefined) {
    throw new Error("Only session panels accept renderer state");
  }
  if (state !== undefined) boundContributionJson(state, 64 * 1024);
  if (hasInteractive(node) && !descriptor.actionId) {
    throw new Error("Interactive content requires actionId");
  }
  return { descriptor, title, node, mobileFallback, ...(state === undefined ? {} : { state }) };
}

export function validateContributionCard(node: unknown): UINode {
  boundContributionJson(node);
  const checked = validateUINode(node);
  if (hasInteractive(checked)) throw new Error("Timeline cards cannot contain forms or confirms");
  return checked;
}

export function contributionSlot(id: string): string {
  return `@slot/${Id.parse(id)}`;
}

export function contributionKey(adapterId: string, id: string): string {
  return JSON.stringify([adapterId, Id.parse(id)]);
}

/** One line that says what a tracker says: its title, count and current step. */
export function trackerText(title: string, tracker: TrackerSummary | undefined): string {
  const head = tracker?.count ? `${title} ${tracker.count}` : title;
  return tracker?.step ? `${head} · ${tracker.step}` : head;
}

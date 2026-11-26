import type {
  AdapterContext,
  AdapterFeature,
  ChecklistItem,
  Claim,
  PiUiRequest,
  ServerAdapter,
  ToolInfo,
  ToolViewData,
  UINode,
} from "@switchyard/adapter-sdk/contract";

/**
 * Example adapter on contract v2, for a fictional Pi extension `pi-tasks` with two tools:
 * `tasks` (`{action: "set" | "list", items?: {text, state}[]}`) keeps a task list, and
 * `ask_owner` (`{question, options}`) asks the user through a `select` dialog.
 *
 * - `toolView`: the `tasks` row reads "Updated tasks · 2/5" and opens a checklist; the
 *   `ask_owner` row is hidden, because the dock shows the question and the transcript its answer.
 * - a `composer.tracker` and a `session.badge` follow the list.
 * - `claimInteraction` says the dialog is a question.
 *
 * Every v2 feature is guarded with `supports`, so the same file loads on a host from before
 * contract v2: there the tracker is a pill, the checklist a list, and the rows are the client's
 * own. It has no runtime imports (`import type` is erased).
 */

export const TASKS_TOOL = "tasks";
export const ASK_TOOL = "ask_owner";

type Task = { text: string; state: ChecklistItem["state"] };

/** Whether this host's contract has a v2 feature. `ctx.features` is undefined before v2. */
export function supports(ctx: Pick<AdapterContext, "features">, feature: AdapterFeature): boolean {
  return ctx.features?.includes(feature) === true;
}

const STATES = ["todo", "doing", "done", "skipped"];

export function parseTasks(args: unknown): Task[] | null {
  const items = (args as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return null;
  const out: Task[] = [];
  for (const i of items) {
    const text = (i as { text?: unknown } | null)?.text;
    const state = (i as { state?: unknown } | null)?.state;
    if (typeof text !== "string" || typeof state !== "string" || !STATES.includes(state)) continue;
    out.push({ text, state: state as Task["state"] });
  }
  return out;
}

export function summary(tasks: Task[]): { count: string; step: string | undefined } {
  const done = tasks.filter((t) => t.state === "done" || t.state === "skipped").length;
  return {
    count: `${done}/${tasks.length}`,
    step: tasks.find((t) => t.state === "doing")?.text.slice(0, 120),
  };
}

const MARK = { todo: "[ ]", doing: "[~]", done: "[x]", skipped: "[-]" } as const;
const fallback = (tasks: Task[]): string =>
  tasks.map((t) => `${MARK[t.state]} ${t.text}`).join("\n") || "No tasks";

/** The list as a checklist where the host draws one, else as a plain list. */
export function tasksNode(tasks: Task[], ctx: Pick<AdapterContext, "features">): UINode {
  if (supports(ctx, "ui.nodes.v2")) return { t: "checklist", items: tasks };
  return {
    t: "list",
    items: tasks.map((t) => ({ t: "text", text: `${MARK[t.state]} ${t.text}` })),
  };
}

function publish(tasks: Task[], ctx: AdapterContext): void {
  ctx.state.set("tasks", tasks);
  const s = summary(tasks);
  const node = tasksNode(tasks, ctx);
  if (!supports(ctx, "adapter.trackers.v1")) {
    // Before v2: a pill with the same words.
    ctx.setContribution(
      "tasks",
      tasks.length
        ? {
            placement: "composer.pill",
            title: "Tasks",
            node: { t: "text", text: `Tasks ${s.count}` },
            mobileFallback: fallback(tasks),
          }
        : null,
    );
    return;
  }
  const open = tasks.some((t) => t.state === "todo" || t.state === "doing");
  ctx.setContribution(
    "tasks",
    tasks.length
      ? {
          placement: "composer.tracker",
          title: "Tasks",
          node,
          mobileFallback: fallback(tasks),
          tracker: {
            count: s.count,
            status: open ? "running" : "ok",
            ...(s.step ? { step: s.step } : {}),
          },
        }
      : null,
  );
  ctx.setContribution(
    "tasks-badge",
    open
      ? {
          placement: "session.badge",
          title: "Tasks",
          node: { t: "badge", text: `Tasks ${s.count}` },
          mobileFallback: `Tasks ${s.count}`,
        }
      : null,
  );
}

const adapter: ServerAdapter = {
  onRestore(ctx) {
    const tasks = ctx.state.get<Task[]>("tasks");
    if (tasks) publish(tasks, ctx);
  },

  onToolEnd(e, ctx) {
    if (e.name !== TASKS_TOOL || e.isError) return;
    const tasks = parseTasks(e.args);
    if (tasks) publish(tasks, ctx);
  },

  // Only called on a host with `tool.views.v1`.
  toolView(tool: ToolInfo, ctx): ToolViewData | undefined {
    if (tool.name === ASK_TOOL) return { hide: true };
    if (tool.name !== TASKS_TOOL) return undefined;
    const tasks = parseTasks(tool.args) ?? ctx.state.get<Task[]>("tasks") ?? [];
    return {
      verb: parseTasks(tool.args) ? "Updated tasks" : "Listed tasks",
      activeVerb: "Updating tasks",
      target: "",
      meta: tasks.length ? [summary(tasks).count] : [],
      detail: tasksNode(tasks, ctx),
    };
  },

  claimInteraction(req: PiUiRequest): Claim | undefined {
    if (req.method !== "select" || !req.title.startsWith("Owner question:")) return undefined;
    const title = req.title.slice("Owner question:".length).trim();
    return {
      title,
      // Ignored by a host before v2; there the dialog is simply not known to be a question.
      kind: "question",
      presentation: {
        t: "form",
        formId: "ask-owner",
        fields: [
          {
            kind: "select",
            name: "answer",
            label: title,
            options: req.options.map((o) => ({ value: o, label: o })),
          },
        ],
        submitLabel: "Answer",
      },
      toPiResponse(resp) {
        if (resp.kind !== "form") return { cancelled: true };
        const v = resp.values.answer;
        if (typeof v !== "string" || !req.options.includes(v)) return { cancelled: true };
        return { value: v };
      },
    };
  },
};

export default adapter;

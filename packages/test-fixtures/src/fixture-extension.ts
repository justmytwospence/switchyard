/**
 * Pi extension used by real-Pi tests. Load with `pi -e <dist/fixture-extension.js>`.
 * It imports nothing at runtime; the extension API is typed loosely because Pi is not a dependency.
 * Tool parameters use plain JSON Schema, which Pi validates without TypeBox.
 */

type ToolResult = { content: { type: "text"; text: string }[]; details: unknown };

const text = (t: string, details?: unknown): ToolResult => ({
  content: [{ type: "text", text: t }],
  details,
});

const noParams = { type: "object", properties: {}, additionalProperties: false };

export default function fixtureExtension(pi: any): void {
  pi.registerTool({
    name: "fixture_select",
    label: "Fixture select",
    description: "Ask the user to pick a fruit.",
    parameters: noParams,
    async execute(
      _id: string,
      _params: unknown,
      signal: AbortSignal | undefined,
      _u: any,
      ctx: any,
    ) {
      const value = await ctx.ui.select("Pick a fruit", ["Apple", "Banana"], { signal });
      return text(`selected ${String(value)}`, { value: value ?? null });
    },
  });

  pi.registerTool({
    name: "fixture_confirm",
    label: "Fixture confirm",
    description: "Ask the user to confirm.",
    parameters: noParams,
    async execute(
      _id: string,
      _params: unknown,
      signal: AbortSignal | undefined,
      _u: any,
      ctx: any,
    ) {
      const confirmed = await ctx.ui.confirm("Proceed?", "The fixture wants to continue.", {
        signal,
      });
      return text(`confirmed ${String(confirmed)}`, { confirmed });
    },
  });

  pi.registerTool({
    name: "fixture_input",
    label: "Fixture input",
    description: "Ask the user for a name.",
    parameters: noParams,
    async execute(
      _id: string,
      _params: unknown,
      signal: AbortSignal | undefined,
      _u: any,
      ctx: any,
    ) {
      const value = await ctx.ui.input("Your name", "type a name", { signal });
      return text(`input ${String(value)}`, { value: value ?? null });
    },
  });

  pi.registerTool({
    name: "fixture_editor",
    label: "Fixture editor",
    description: "Ask the user to edit text.",
    parameters: noParams,
    async execute(
      _id: string,
      _params: unknown,
      _signal: AbortSignal | undefined,
      _u: any,
      ctx: any,
    ) {
      const value = await ctx.ui.editor("Edit the note", "line 1\nline 2");
      return text(`editor ${String(value)}`, { value: value ?? null });
    },
  });

  pi.registerTool({
    name: "fixture_custom",
    label: "Fixture custom",
    description: "Open a terminal-only custom component.",
    parameters: noParams,
    async execute(
      _id: string,
      _params: unknown,
      _signal: AbortSignal | undefined,
      _u: any,
      ctx: any,
    ) {
      const result = await ctx.ui.custom((_tui: any, _theme: any, _kb: any, done: any) => ({
        render: () => ["fixture custom component"],
        handleInput: () => done("from component"),
        invalidate: () => {},
      }));
      return text(`custom returned ${String(result)}`, { result: result ?? null });
    },
  });

  pi.registerTool({
    name: "fixture_slow",
    label: "Fixture slow",
    description: "Wait for a long time (30 s by default), honouring abort.",
    parameters: {
      type: "object",
      properties: { ms: { type: "number", description: "milliseconds to wait" } },
      additionalProperties: false,
    },
    async execute(_id: string, params: any, signal: AbortSignal | undefined) {
      const ms = typeof params?.ms === "number" ? params.ms : 30000;
      const aborted = await new Promise<boolean>((resolve) => {
        if (signal?.aborted) return resolve(true);
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve(false);
        }, ms);
        const onAbort = () => {
          clearTimeout(timer);
          resolve(true);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
      if (aborted) throw new Error("fixture_slow aborted");
      return text(`slept ${ms}ms`);
    },
  });

  pi.registerTool({
    name: "fixture_status",
    label: "Fixture status",
    description: "Set a status line and a text widget.",
    parameters: noParams,
    async execute(
      _id: string,
      _params: unknown,
      _signal: AbortSignal | undefined,
      _u: any,
      ctx: any,
    ) {
      ctx.ui.setStatus("fixture", "fixture working");
      ctx.ui.setWidget("fixture", ["fixture widget line 1", "fixture widget line 2"]);
      ctx.ui.notify("fixture notified", "info");
      return text("status set");
    },
  });
}

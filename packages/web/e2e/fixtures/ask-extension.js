/**
 * E2E-only Pi extension that registers `ask_user_question` with the same RPC dialog shape as
 * @justmytwospence/pi-ask-user-question, so the e2e owner adapter in `adapters/ask-user-question`
 * claims it and the web app renders a structured form (single select as radio cards, multi select
 * as checkboxes) instead of comma-separated numbers.
 *
 * - single select: `select("[header] question", ["1. label - description", ..., "N. Type something."])`
 * - multi select: one `input("[header] question\n1. label\n...")` answered with "1,3"
 */

const questionSchema = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          question: { type: "string" },
          header: { type: "string" },
          multiSelect: { type: "boolean" },
          options: {
            type: "array",
            items: {
              type: "object",
              properties: { label: { type: "string" }, description: { type: "string" } },
              required: ["label"],
            },
          },
        },
        required: ["question", "header", "options"],
      },
    },
  },
  required: ["questions"],
};

export default function askExtension(pi) {
  pi.registerTool({
    name: "ask_user_question",
    label: "Ask user question",
    description: "Ask the user structured questions.",
    parameters: questionSchema,
    async execute(_id, params, signal, _u, ctx) {
      const answers = [];
      for (const q of params.questions ?? []) {
        const numbered = q.options.map(
          (o, i) => `${i + 1}. ${o.label}${o.description ? ` - ${o.description}` : ""}`,
        );
        const title = `[${q.header}] ${q.question}`;
        if (q.multiSelect) {
          const value = await ctx.ui.input(`${title}\n${numbered.join("\n")}`, "1,3", { signal });
          const picked = String(value ?? "")
            .split(",")
            .map((s) => Number.parseInt(s.trim(), 10))
            .filter((n) => n >= 1 && n <= q.options.length)
            .map((n) => q.options[n - 1].label);
          answers.push(`${q.header}: ${picked.join(", ") || "(none)"}`);
        } else {
          const value = await ctx.ui.select(
            title,
            [...numbered, `${numbered.length + 1}. Type something.`],
            { signal },
          );
          answers.push(`${q.header}: ${String(value ?? "(none)")}`);
        }
      }
      return { content: [{ type: "text", text: answers.join("\n") }], details: { answers } };
    },
  });
}

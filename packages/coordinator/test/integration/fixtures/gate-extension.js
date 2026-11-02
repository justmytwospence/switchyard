/**
 * Test-only Pi extension: a tool gate. `fixture_gate` asks "Allow this call?" (Allow / Block)
 * through `ctx.ui.select` and reports the decision. Loaded with `pi -e` by the integration tests.
 */
export default function gateExtension(pi) {
  pi.registerTool({
    name: "fixture_gate",
    label: "Fixture gate",
    description: "A gated call that needs approval.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_id, _params, signal, _u, ctx) {
      const choice = await ctx.ui.select("Allow this call?", ["Allow", "Block"], { signal });
      const allowed = choice === "Allow";
      return {
        content: [
          { type: "text", text: allowed ? "call allowed" : `call blocked (${String(choice)})` },
        ],
        details: { choice: choice ?? null, allowed },
      };
    },
  });
}

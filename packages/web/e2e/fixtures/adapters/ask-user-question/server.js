/**
 * E2E-only owner adapter for `../../ask-extension.js`. Core no longer bundles adapters (the real
 * ask-user-question adapter ships in pi-plugins), so the e2e host loads this one from its owner
 * adapter dir. It claims the first question dialog of an `ask_user_question` call, shows every
 * question in one form, and answers the extension's dialog sequence from it: a numbered option for
 * a single select, "1,3" for a multi select.
 */

const PENDING = "pending:";

/** An invalid answer: the interaction stays pending (matched by name, like the SDK's error). */
function invalid(message) {
  const err = new Error(message);
  err.name = "InteractionResponseError";
  return err;
}

const fields = (questions) =>
  questions.map((q, i) => ({
    kind: q.multiSelect ? "multiselect" : "select",
    name: `q${i + 1}`,
    label: q.question,
    options: q.options.map((o) => ({
      value: o.label,
      label: o.label,
      ...(o.description ? { description: o.description } : {}),
    })),
  }));

function sequence(questions, values) {
  return questions.map((q, i) => {
    const v = values[`q${i + 1}`];
    const picked = (Array.isArray(v) ? v : [v]).map(
      (label) => q.options.findIndex((o) => o.label === label) + 1,
    );
    if (picked.length === 0 || picked.some((n) => n === 0)) {
      throw invalid(`"${q.question}" needs an answer`);
    }
    const owns = (req) => req.title.startsWith(`[${q.header}]`);
    if (q.multiSelect) {
      return {
        match: (req) => req.method === "input" && owns(req),
        response: { value: picked.sort((a, b) => a - b).join(",") },
      };
    }
    return {
      match: (req) => req.method === "select" && owns(req),
      response: (req) => {
        const opt = req.options.find((o) => o.startsWith(`${picked[0]}. `));
        return opt === undefined ? undefined : { value: opt };
      },
    };
  });
}

export default {
  onToolStart(e, ctx) {
    if (e.name !== "ask_user_question" || !Array.isArray(e.args?.questions)) return;
    ctx.state.set(`${PENDING}${e.toolCallId}`, { toolCallId: e.toolCallId, args: e.args });
  },

  onToolEnd(e, ctx) {
    if (e.name === "ask_user_question") ctx.state.delete(`${PENDING}${e.toolCallId}`);
  },

  claimInteraction(req, ctx) {
    if (req.method !== "select" && req.method !== "input") return undefined;
    for (const key of ctx.state.keys().filter((k) => k.startsWith(PENDING))) {
      const { toolCallId, args, claimed } = ctx.state.get(key);
      const first = args.questions[0];
      if (claimed || !first || !req.title.startsWith(`[${first.header}]`)) continue;
      ctx.state.set(key, { toolCallId, args, claimed: true });
      return {
        title: first.question,
        ownerToolCallId: toolCallId,
        presentation: {
          t: "form",
          formId: `ask-user-question:${toolCallId}`,
          fields: fields(args.questions),
          submitLabel: "Submit answers",
          cancelLabel: "Cancel",
        },
        toPiResponse(resp) {
          if (resp.kind === "cancel") return { cancelled: true };
          if (resp.kind !== "form") throw invalid(`expected the question form, got ${resp.kind}`);
          return { sequence: sequence(args.questions, resp.values) };
        },
      };
    }
    return undefined;
  },
};

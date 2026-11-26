const form = {
  t: "form",
  formId: "fixture-slots",
  fields: [{ kind: "text", name: "note", label: "Fixture note" }],
  submitLabel: "Save note",
};

function publish(ctx, value) {
  const last = ctx.state.get("last") ?? "No action yet";
  const slots = [
    [
      "header",
      {
        placement: "sidebar.header",
        title: "Slots header",
        node: { t: "text", text: value },
        mobileFallback: value,
      },
    ],
    [
      "footer",
      {
        placement: "sidebar.footer",
        title: "Slots footer",
        node: { t: "text", text: last },
        mobileFallback: last,
      },
    ],
    [
      "panel",
      {
        placement: "session.panel",
        title: "Slots details",
        node: form,
        mobileFallback: last,
        actionId: "save",
        state: { value, last },
      },
    ],
    [
      "pill",
      {
        placement: "composer.pill",
        title: "Slots pill",
        node: { t: "text", text: "Slots ready" },
        mobileFallback: "Slots ready",
      },
    ],
    [
      "tracker",
      {
        placement: "composer.tracker",
        title: "Slots tracker",
        node: {
          t: "checklist",
          items: [
            { text: "First step", state: "done" },
            { text: "Second step", state: "doing" },
          ],
        },
        mobileFallback: "1 of 2",
        tracker: { count: "1/2", status: "running", step: "Second step" },
      },
    ],
    [
      "badge",
      {
        placement: "session.badge",
        title: "Slots badge",
        node: { t: "badge", text: "slots", tone: "warning" },
        mobileFallback: "slots",
      },
    ],
    [
      "palette",
      {
        placement: "palette.item",
        title: "Slots palette",
        node: { t: "text", text: "Confirm fixture action" },
        mobileFallback: "Confirm fixture action",
        actionId: "run",
        keywords: ["fixture-slots"],
      },
    ],
    [
      "command",
      {
        placement: "slash.command",
        title: "Slots command",
        name: "note",
        node: form,
        mobileFallback: "Enter a fixture note",
        actionId: "save",
      },
    ],
  ];
  for (const [id, contribution] of slots) ctx.setContribution(id, value ? contribution : null);
}

export default {
  onStatus(key, text, ctx) {
    if (key !== "slots") return false;
    if (text) ctx.state.set("value", text);
    else ctx.state.delete("value");
    publish(ctx, text);
    return true;
  },
  onAction(id, payload, ctx) {
    if (id !== "run" && id !== "save") throw new Error("Unknown fixture action");
    ctx.state.set("last", `${id}: ${JSON.stringify(payload)}`);
    const value = ctx.state.get("value");
    if (value) publish(ctx, value);
  },
  toolCard(tool) {
    return tool.name === "fixture_status" ? { t: "text", text: "Slots tool card" } : undefined;
  },
  toolView(tool) {
    return tool.name === "fixture_status"
      ? { verb: "Checked the fixture", activeVerb: "Checking the fixture", meta: ["slots"] }
      : undefined;
  },
  customMessageCard(message) {
    return message.customType === "slots-visible"
      ? { t: "text", text: "Slots custom card" }
      : undefined;
  },
};

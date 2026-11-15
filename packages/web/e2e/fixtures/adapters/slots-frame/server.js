export default {
  onStatus(key, value, ctx) {
    if (key !== "slots") return false;
    ctx.setContribution(
      "frame",
      value
        ? {
            placement: "session.panel",
            title: "Slots frame",
            node: { t: "text", text: `Portable frame: ${value}` },
            mobileFallback: `Portable frame: ${value}`,
            state: { value },
          }
        : null,
    );
    return false;
  },
};

export * from "./api.js";
export * from "./client-wire.js";
export * from "./entities.js";
export * from "./errors.js";
export * from "./events.js";
export * from "./host-wire.js";
export * from "./ids.js";
export * from "./terminal-wire.js";
export * from "./titles.js";
export * from "./ui.js";

export const PROTOCOL_VERSION = 1;
export const PI_SUPPORTED_RANGE = ">=1.4.0 <1.6.0";
export const DEFAULT_PORT = 7400;
export const MARKERS = {
  done: "SWITCHYARD: DONE",
  blocked: "SWITCHYARD: BLOCKED",
  noChange: "SWITCHYARD: NO_CHANGE",
} as const;

import { afterEach } from "vitest";

// The terminal extension refuses a second active copy per process (a global shim plus `-e`);
// tests load it many times without a Pi session shutdown in between.
afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("switchyard.terminal.loaded")];
});

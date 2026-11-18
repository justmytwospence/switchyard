import { defineConfig } from "vitest/config";
import { tags } from "../../vitest.shared.ts";
export default defineConfig({
  test: {
    tags,
    name: "pi-runtime",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});

import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    name: "pi-runtime",
    include: ["test/**/*.test.ts"],
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});

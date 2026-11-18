import { defineConfig } from "vitest/config";
import { tags } from "../../vitest.shared.ts";
export default defineConfig({
  test: {
    tags,
    name: "client",
    include: ["test/**/*.test.ts"],
    testTimeout: 60000,
  },
});

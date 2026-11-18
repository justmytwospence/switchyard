import { defineConfig } from "vitest/config";
import { tags } from "../../vitest.shared.ts";
export default defineConfig({
  test: {
    tags,
    name: "adapter-examples",
    include: ["test/**/*.test.ts"],
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});

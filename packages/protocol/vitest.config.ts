import { defineConfig } from "vitest/config";
import { tags } from "../../vitest.shared.ts";
export default defineConfig({
  test: {
    tags,
    name: "protocol",
    include: ["test/**/*.test.ts"],
  },
});

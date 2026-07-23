import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    restoreMocks: true,
    testTimeout: 10_000,
  },
});

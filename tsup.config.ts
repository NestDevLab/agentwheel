import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/cli/index.ts", "run-as-worker": "src/transport/run-as-worker.ts" },
  format: ["esm"],
  splitting: false,
  dts: false,
  clean: true,
  sourcemap: false,
  target: "node18",
  banner: {
    js: "#!/usr/bin/env node",
  },
});

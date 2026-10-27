import { chmod, copyFile } from "node:fs/promises";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/cli/index.ts", "run-as-worker": "src/transport/run-as-worker.ts" },
  format: ["esm"],
  splitting: false,
  noExternal: ["zod", "jsonc-parser"],
  dts: false,
  clean: true,
  sourcemap: false,
  target: "node18",
  async onSuccess() { await copyFile("src/transport/run-as-fs.py", "dist/run-as-fs.py"); await chmod("dist/run-as-fs.py", 0o644); },
  banner: {
    js: "#!/usr/bin/env node",
  },
});

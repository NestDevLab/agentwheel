import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli/index.ts"],
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: false,
  target: "node18",
  banner: {
    js: "#!/usr/bin/env node",
  },
});

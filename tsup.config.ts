import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli/index.ts", "src/render.ts", "src/mcp/server.ts", "src/tools-core/index.ts"],
  format: ["esm"],
  target: "node18",
  outDir: "dist",
  clean: true,
  splitting: false,
  sourcemap: true,
  dts: false,
  shims: true,
  external: ["@anthropic-ai/sdk"],
  banner: {},
});

import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    globals: true,
    root: ".",
    include: ["test/**/*.test.ts"],
    // A dev shell's sandbox override must never leak into tests: suites that
    // isolate state by redirecting HOME would silently lose to VIBEDRIFT_HOME
    // (and test writes would land in the dev's sandbox). Blank = unset.
    env: { VIBEDRIFT_HOME: "" },
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
});

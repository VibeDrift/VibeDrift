import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/**", "node_modules/**", "test/fixtures/**", "eval/**"],
  },
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "no-useless-escape": "warn",
      "no-useless-assignment": "warn",
    },
  },
  {
    // Test code legitimately builds partial mocks with `any` (fixture shapes,
    // stubbed clients). Typing every one adds churn without catching real
    // bugs, so `no-explicit-any` is relaxed for tests only — src stays strict.
    // Every other rule (unused vars, etc.) still applies to tests.
    files: ["test/**/*.ts", "**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    // Release-gating scripts (scripts/sync-plugin-version.mjs,
    // scripts/publish-guard.mjs, etc.) were previously excluded by the
    // blanket scripts/** ignore above and got zero lint coverage. They're
    // plain Node ESM, not TypeScript, so they just need the runtime
    // globals declared — the top-level eslint.configs.recommended rules
    // above already apply to them once they're no longer ignored.
    files: ["scripts/*.mjs"],
    languageOptions: {
      sourceType: "module",
      ecmaVersion: 2022,
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        performance: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        globalThis: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
      },
    },
  },
);

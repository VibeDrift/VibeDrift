import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/**", "node_modules/**", "test/fixtures/**", "scripts/**", "eval/**"],
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
);

# reuse-repo

A small services codebase with a shared helper layer in `lib/`. Declared
conventions (seed for VibeDrift's intent-hint parser):

- **Async:** use async/await.
- **Exports:** named exports only. No default exports.
- **Errors:** throw on failure; do not return null from functions that can fail.

# then-chain-repo

This is an older callback-style codebase. Declared conventions (seed for
VibeDrift's intent-hint parser):

- **Async:** use `.then()` chains for all asynchronous code. Do NOT use
  async/await — it is banned in this codebase for consistency with the
  existing promise-chain style.
- **Exports:** named exports only. No default exports.

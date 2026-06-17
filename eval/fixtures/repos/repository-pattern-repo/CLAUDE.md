# repository-pattern-repo

Declared conventions (seed for VibeDrift's intent-hint parser):

- **Exports:** named exports only. No default exports.
- **Data access:** go through the injected `repo` abstraction
  (`repo.<entity>.findById(...)`). No raw SQL or direct `db` access.
- **Async:** async/await throughout. No .then() chains.
- **Errors:** throw `NotFoundError` on a miss; never return null.

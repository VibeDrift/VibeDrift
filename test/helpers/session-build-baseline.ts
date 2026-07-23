// Test helper: build and persist a baseline for the repo at argv[2], under the
// HOME the child was spawned with (baseline cache is homedir-derived). Used by
// the session-hook exit-2 integration test to stage a real baseline the hook
// child can load. Relative imports so it runs under tsx without alias config.
import { buildBaseline, writeBaseline } from "../../src/core/baseline.js";

const repo = process.argv[2];
buildBaseline(repo)
  .then((b) => writeBaseline(b))
  .then(() => process.exit(0))
  .catch((err) => {
    process.stderr.write(String(err) + "\n");
    process.exit(1);
  });

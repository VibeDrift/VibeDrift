#!/usr/bin/env node
/* global process */
// Fail-open even if the build is missing/corrupt: a hook must never break the agent.
import("../dist/session/hook-entry.js").catch(() => process.exit(0));

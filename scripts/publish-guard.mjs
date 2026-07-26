#!/usr/bin/env node
/**
 * Publish guard: a prod `npm publish` may only happen through the sanctioned
 * release flow. Local/rehearsal registries are always allowed, so the release
 * rehearsal and any localhost testing keep working with zero ceremony.
 *
 *   allowed:  npm publish --registry http://localhost:4873   (rehearsal)
 *   allowed:  VIBEDRIFT_RELEASE=1 npm publish                (scripts/release.sh)
 *   refused:  npm publish                                    (casual/accidental)
 */
const reg = process.env.npm_config_registry || "";
const isLocal = /localhost|127\.0\.0\.1/.test(reg);
if (!isLocal && process.env.VIBEDRIFT_RELEASE !== "1") {
  console.error(
    "\npublish blocked: prod releases go through scripts/release.sh\n" +
    "(it runs the gate, bumps, tags, publishes, and creates the GitHub release).\n" +
    "Rehearse against a local registry instead: bash scripts/release-rehearsal.sh\n",
  );
  process.exit(1);
}

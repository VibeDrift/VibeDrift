#!/usr/bin/env bash
# Release rehearsal: prove the REAL install experience without touching the
# public npm registry.
#
# What it does, end to end:
#   1. starts a throwaway local npm registry (Verdaccio) with fresh storage,
#   2. publishes THIS checkout to it (prepublishOnly runs the full gate),
#   3. installs the package FROM that registry via `npx` into a clean prefix,
#   4. smoke-runs the installed CLI inside a VIBEDRIFT_HOME sandbox:
#      --version must match package.json, `doctor` must run, and a scan of a
#      tiny fixture must produce JSON — fully offline (--local-only).
#
# Nothing here can reach registry.npmjs.org for publishing: every publish and
# install pins --registry to the local one (dependency downloads are proxied
# through it read-only). Safe to run anywhere; leaves no state behind.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${REHEARSAL_PORT:-4873}"
REG="http://localhost:${PORT}"
TMPBASE="${TMPDIR:-/tmp}"; TMPBASE="${TMPBASE%/}"
WORK="$(mktemp -d "$TMPBASE/vd-rehearsal.XXXXXX")"
VERDACCIO_PID=""

cleanup() {
  [ -n "$VERDACCIO_PID" ] && kill "$VERDACCIO_PID" 2>/dev/null || true
  if [ "${REHEARSAL_KEEP:-0}" = "1" ]; then echo "kept workdir: $WORK"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

say() { printf '\n\033[1m» %s\033[0m\n' "$*"; }

VERSION="$(node -p "require('$ROOT/package.json').version")"
NAME="$(node -p "require('$ROOT/package.json').name")"

say "release rehearsal for ${NAME}@${VERSION} against ${REG}"

# ── 1. throwaway registry (fresh storage, anonymous publish, npmjs proxy for deps)
cat > "$WORK/verdaccio.yaml" <<EOF
storage: $WORK/storage
uplinks:
  npmjs:
    url: https://registry.npmjs.org/
packages:
  '${NAME}':
    access: \$all
    publish: \$all
  '@*/*':
    access: \$all
    publish: \$all
    proxy: npmjs
  '**':
    access: \$all
    publish: \$all
    proxy: npmjs
log: { type: stdout, level: warn }
EOF
# Fetch verdaccio into the npx cache FIRST, in the foreground and bounded, so
# the start-up wait below never includes the download. Eight rehearsal runs on
# 2026-09-04 UTC died with "verdaccio did not start" and nothing in verdaccio's own
# log, first at a 30 s wait and then at 120 s; verdaccio never ran, npx was
# still downloading it. npm's fetch-timeout bounds an IDLE socket only, and its
# default is five minutes, so a registry that accepts a connection and then
# stalls hangs almost indefinitely (measured: still hanging at 90 s under npm
# defaults, 11 s with the bound below). npm does not bound TCP connect at all,
# so an unreachable registry costs the OS connect timeout instead, about 75 s
# on macOS and longer on Linux; `timeout` caps that when it is installed.
#
# Measured cold fetch times ranged from 14 s to over 120 s, and that tail is
# the bug; a warm npx cache answers in 1 s. Three attempts, because partial
# progress stays in the npm cache and a retry resumes from it.
VERDACCIO_SPEC="${REHEARSAL_VERDACCIO_SPEC:-verdaccio@5.33.0}"
FETCH_CAP=""; command -v timeout >/dev/null 2>&1 && FETCH_CAP="timeout ${REHEARSAL_FETCH_CAP_S:-90}"
fetch_verdaccio() {
  $FETCH_CAP env npm_config_fetch_timeout=10000 npm_config_fetch_retries=0 \
    npx --yes "$VERDACCIO_SPEC" --version >"$WORK/verdaccio-fetch.log" 2>&1
}
for attempt in 1 2 3; do
  fetch_verdaccio && break
  [ "$attempt" = 3 ] && { echo "could not fetch $VERDACCIO_SPEC in 3 attempts"; tail -20 "$WORK/verdaccio-fetch.log"; exit 1; }
  echo "fetching $VERDACCIO_SPEC failed or stalled (attempt $attempt), retrying"
  sleep 5
done
echo "  ✓ $VERDACCIO_SPEC fetched"

npx --yes "$VERDACCIO_SPEC" --config "$WORK/verdaccio.yaml" --listen "$PORT" >"$WORK/verdaccio.log" 2>&1 &
VERDACCIO_PID=$!
START_BUDGET_S="${REHEARSAL_START_BUDGET_S:-60}"
for i in $(seq 1 "$START_BUDGET_S"); do
  curl -sf "$REG/-/ping" >/dev/null 2>&1 && break
  [ "$i" = "$START_BUDGET_S" ] && { echo "verdaccio did not start within ${START_BUDGET_S}s"; tail -20 "$WORK/verdaccio.log"; exit 1; }
  sleep 1
done
say "registry up (pid $VERDACCIO_PID)"

# ── 2. publish this checkout to it (npm insists on a token; any value satisfies
#      an anonymous-publish registry)
(
  cd "$ROOT"
  VIBEDRIFT_PUBLISH_SANDBOX=1 npm publish --registry "$REG" --//localhost:${PORT}/:_authToken=rehearsal
)
say "published ${NAME}@${VERSION} to the rehearsal registry"

# ── 3. install FROM the rehearsal registry into a clean prefix, sandboxed state
export VIBEDRIFT_HOME="$WORK/home"
mkdir -p "$WORK/fixture/src" "$WORK/npx-cache"
printf 'export async function alpha(){ return 1; }\nexport async function beta(){ return 2; }\n' \
  > "$WORK/fixture/src/sample.ts"

# Install FROM the rehearsal registry into an explicit clean prefix. We do NOT
# use npx here: npm exec resolves local projects and GLOBAL installs first, so
# on any machine with the real CLI installed globally, npx would silently run
# that instead of the rehearsal artifact (observed in practice). An explicit
# --prefix install is deterministic and exercises the same tarball + bin wiring.
cd "$WORK"
npm install --prefix "$WORK/install" --registry "$REG" --cache "$WORK/npm-cache" \
  --no-fund --no-audit "${NAME}@${VERSION}" >/dev/null
CLI="$WORK/install/node_modules/.bin/vibedrift"
[ -x "$CLI" ] || { echo "FAIL: installed bin missing at $CLI"; exit 1; }

say "npx auto-select invariant holds (exactly one bin, named vibedrift)"
node -e '
  const p = require(process.argv[1] + "/install/node_modules/@vibedrift/cli/package.json");
  const bins = Object.keys(p.bin || {});
  if (bins.length !== 1 || bins[0] !== "vibedrift") {
    console.error("FAIL: bin map is " + JSON.stringify(p.bin) +
      " — npx cannot auto-select unless there is exactly one bin (this exact bug shipped in 0.17.0)");
    process.exit(1);
  }
' "$WORK"
echo "  ✓ single bin: vibedrift"

say "installed CLI reports its version"
GOT="$("$CLI" --version 2>/dev/null | tail -1)"
[ "$GOT" = "$VERSION" ] || { echo "FAIL: version mismatch: got '"'"'$GOT'"'"', want '"'"'$VERSION'"'"'"; exit 1; }
echo "  ✓ $GOT"

say "installed CLI sees the state sandbox (doctor)"
DOC="$("$CLI" doctor 2>/dev/null || true)"
echo "$DOC" | grep -q "VIBEDRIFT_HOME" || { echo "FAIL: doctor does not report the sandbox override"; exit 1; }
echo "$DOC" | grep -q "$WORK/home" || { echo "FAIL: doctor reports a different state root"; exit 1; }
echo "  ✓ doctor reports \$VIBEDRIFT_HOME sandbox"

say "offline scan of the fixture produces JSON"
OUT="$("$CLI" scan "$WORK/fixture" --format json --local-only 2>/dev/null)"
printf '%s' "$OUT" | node -e 'JSON.parse(require("fs").readFileSync(0,"utf8"))' \
  || { echo "FAIL: scan output is not valid JSON"; exit 1; }
echo "  ✓ scan ok"

say "state stayed in the sandbox"
[ -d "$WORK/home" ] || { echo "FAIL: sandbox home was never created"; exit 1; }
echo "  ✓ $(find "$WORK/home" -maxdepth 1 -mindepth 1 | wc -l | tr -d ' ') state entries under \$VIBEDRIFT_HOME"

say "REHEARSAL PASSED — ${NAME}@${VERSION} installs and runs from a cold registry"

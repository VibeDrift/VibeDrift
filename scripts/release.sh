#!/usr/bin/env bash
# One-shot release for @vibedrift/cli.
#
# Runs the full release in order so a release can never again ship to npm
# without a matching GitHub Release (the step that was easy to forget):
#   sanity gate -> version bump + tag -> npm publish -> push commit+tag ->
#   gh release create (notes pulled from CHANGELOG.md).
#
# Usage:   bash scripts/release.sh [patch|minor|major]      (default: patch)
# Prereqs: npm logged in (`npm whoami`), gh authenticated (`gh auth status`),
#          clean working tree, and a CHANGELOG.md section for the new version
#          (put it under `## [Unreleased]`; this script does NOT write it).
set -euo pipefail
cd "$(dirname "$0")/.."

BUMP="${1:-patch}"
case "$BUMP" in patch|minor|major) ;; *) echo "usage: release.sh [patch|minor|major]" >&2; exit 1;; esac

# 0. Refuse to release a dirty tree — never ship stray uncommitted changes.
if [ -n "$(git status --porcelain | grep -v '^??' || true)" ]; then
  echo "ERROR: uncommitted tracked changes present. Commit or stash first." >&2
  git status --short >&2
  exit 1
fi

# 1. Sanity gate. prepublishOnly re-runs this, but fail fast BEFORE the bump.
echo "==> sanity: lint + typecheck + test + build"
npm run lint
npm run typecheck
npm test
npm run build

# 2. Version bump -> commit + tag vX.Y.Z.
echo "==> npm version $BUMP"
npm version "$BUMP" -m "release: v%s"
VERSION="$(node -p "require('./package.json').version")"
TAG="v$VERSION"

# 3. Publish to npm (prepublishOnly gate re-runs the sanity checks).
echo "==> npm publish $TAG"
npm publish --access public

# 4. Push the version commit + tag.
echo "==> git push --follow-tags"
git push origin HEAD --follow-tags

# 5. GitHub Release, notes lifted from the CHANGELOG.md section for this version.
echo "==> gh release create $TAG"
NOTES="$(awk -v v="$VERSION" '
  $0 ~ "^## +\\[?" v "\\]?" {f=1; next}
  f && /^## / {exit}
  f {print}
' CHANGELOG.md)"
[ -z "${NOTES//[[:space:]]/}" ] && NOTES="See CHANGELOG.md for details."
gh release create "$TAG" --title "$TAG" --notes "$NOTES"

echo ""
echo "Released $TAG — npm + git tag + GitHub Release all in sync."
echo "NEXT (separate repo, not automated here): add a /releases entry in"
echo "  vibedrift-landing-page/src/lib/releases.ts and run 'vercel --prod'."

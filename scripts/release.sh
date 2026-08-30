#!/usr/bin/env bash
# One-shot release for @vibedrift/cli.
#
# Runs the full release in order so a release can never ship to npm without a
# matching, correctly-annotated GitHub Release:
#   sanity gate -> validate CHANGELOG -> promote heading + version bump
#   -> commit + tag -> npm publish -> push -> gh release create.
#
# Write your notes under `## [Unreleased]` in CHANGELOG.md. This script
# PROMOTES that heading to `## X.Y.Z — <date>` as part of the version commit,
# so the tagged tree is self-consistent and the GitHub Release notes are
# lifted from the section that actually exists. It refuses to release when
# `[Unreleased]` is missing or empty, because a release with no notes is
# never what anyone wants (0.18.0 shipped that way before this guard existed).
#
# Usage:   bash scripts/release.sh [patch|minor|major]      (default: patch)
# Prereqs: npm logged in (`npm whoami`), gh authenticated (`gh auth status`),
#          clean working tree, notes under `## [Unreleased]`.
set -euo pipefail
cd "$(dirname "$0")/.."

BUMP="${1:-patch}"
case "$BUMP" in patch|minor|major) ;; *) echo "usage: release.sh [patch|minor|major]" >&2; exit 1;; esac

# Extract the body of a `## <label>` section, stopping at the next `## `.
# $1 is the LITERAL first token of the heading, e.g. "0.18.0" or "[Unreleased]".
# Deliberately string equality, not a regex: `awk -v` strips backslash escapes,
# so a pattern like `\[Unreleased\]` silently degrades into a character class
# and matches nothing.
section_body() {
  awk -v want="$1" '
    substr($0, 1, 3) == "## " {
      if (started) exit
      hdr = substr($0, 4)
      sub(/^[ \t]+/, "", hdr)
      split(hdr, parts, /[ \t]/)
      if (parts[1] == want) started = 1
      next
    }
    started { print }
  ' CHANGELOG.md
}
blank() { [ -z "${1//[[:space:]]/}" ]; }

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

# 2. Validate the CHANGELOG *before* mutating anything, so a missing section
#    costs nothing to recover from.
echo "==> checking CHANGELOG.md for release notes"
if ! grep -qE '^## +\[Unreleased\]' CHANGELOG.md; then
  echo "ERROR: no '## [Unreleased]' heading in CHANGELOG.md." >&2
  echo "       Add your notes under '## [Unreleased]' and re-run." >&2
  exit 1
fi
if blank "$(section_body "[Unreleased]")"; then
  echo "ERROR: '## [Unreleased]' in CHANGELOG.md is empty." >&2
  echo "       Describe the release there and re-run. Refusing to publish" >&2
  echo "       a release with no notes." >&2
  exit 1
fi

# 3. Bump package.json only (no commit, no tag) so we know the version the
#    CHANGELOG heading must carry. Restored if anything below fails.
echo "==> npm version $BUMP"
npm version "$BUMP" --no-git-tag-version >/dev/null
VERSION="$(node -p "require('./package.json').version")"
TAG="v$VERSION"
restore_bump() { git checkout -- package.json package-lock.json .claude-plugin/plugin.json 2>/dev/null || true; }
trap 'restore_bump' ERR

# 3b. Keep the Claude Code plugin manifest's version in lockstep with the
#     package.json bump above (CI's --check would otherwise catch this later,
#     but fail here instead so the release stops before anything is tagged).
echo "==> syncing .claude-plugin/plugin.json version"
node scripts/sync-plugin-version.mjs

# 4. Promote `## [Unreleased]` -> `## X.Y.Z — <date>`. Written with awk, not
#    `sed -i`, which is not portable between GNU and BSD/macOS.
echo "==> promoting CHANGELOG heading to $VERSION"
awk -v repl="## $VERSION — $(date +%F)" '
  !seen && /^## +\[Unreleased\]/ { print repl; seen=1; next }
  { print }
' CHANGELOG.md > CHANGELOG.md.tmp && mv CHANGELOG.md.tmp CHANGELOG.md

# 5. Lift the notes from the section we just wrote, and assert they are real
#    BEFORE publishing. This is the guard that was missing: the old script
#    substituted "See CHANGELOG.md for details." and published anyway.
NOTES="$(section_body "$VERSION")"
if blank "$NOTES"; then
  echo "ERROR: extracted empty release notes for $VERSION after promotion." >&2
  echo "       CHANGELOG.md may be malformed. Nothing published." >&2
  restore_bump
  git checkout -- CHANGELOG.md 2>/dev/null || true
  exit 1
fi
NOTES="$NOTES
**Full changelog:** [CHANGELOG.md](https://github.com/VibeDrift/VibeDrift/blob/main/CHANGELOG.md)"

# 6. One commit carrying both the bump and the promoted heading, then the tag,
#    so the tagged tree never says "[Unreleased]" for shipped work.
echo "==> commit + tag $TAG"
git add package.json package-lock.json CHANGELOG.md .claude-plugin/plugin.json
git commit -q -m "release: $TAG"
git tag -a "$TAG" -m "release: $TAG"
trap - ERR

# 7. Publish to npm (prepublishOnly gate re-runs the sanity checks).
echo "==> npm publish $TAG"
VIBEDRIFT_RELEASE=1 npm publish --access public

# 8. Push the version commit + tag.
echo "==> git push --follow-tags"
git push origin HEAD --follow-tags

# 9. GitHub Release, notes lifted from the CHANGELOG section for this version.
echo "==> gh release create $TAG"
gh release create "$TAG" --title "$TAG" --notes "$NOTES"

echo ""
echo "Released $TAG — npm + git tag + GitHub Release all in sync."
echo "NEXT (separate repo, not automated here): add a /releases entry in"
echo "  vibedrift-landing-page/src/lib/releases.ts and run 'vercel --prod'."

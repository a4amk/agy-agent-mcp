#!/usr/bin/env bash
# Builds the GitHub release notes from the CHANGELOG.
#
#   release-notes.sh <output-file>
#
# The notes are the CHANGELOG section of the released version - the "## <version>"
# heading whose version matches the tag - followed by a "Full Changelog" compare
# link against the previous release tag. A missing or empty section fails
# loudly: a release page without the release notes (and an npm release without
# them) is worse than a failed release.
#
# The tag comes from the ref, so it is treated as untrusted input: it is
# matched against a pattern and quoted everywhere it is used, never interpolated
# into a command.
set -euo pipefail

REPO_URL="${RELEASE_REPO_URL:-https://github.com/a4amk/agy-agent-mcp}"
CHANGELOG="${RELEASE_CHANGELOG:-CHANGELOG.md}"
OUTPUT="${1:-}"

fail() {
  printf '::error::%s\n' "$*"
  exit 1
}

tag="${GITHUB_REF_NAME:-}"
[ -n "$tag" ] || fail "no GITHUB_REF_NAME in the environment - a release is triggered by a tag push"

printf '%s\n' "$tag" | grep -Eq '^v[0-9]+(\.[0-9]+)*(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$' ||
  fail "the tag '${tag}' is not a release tag (expected v<version>)"

version="${tag#v}"

[ -f "$CHANGELOG" ] || fail "the changelog '${CHANGELOG}' does not exist"

# The section of the released version: from its "## <version>" heading up to
# the next "## " heading (or the end of the file). The heading may carry a "v".
section="$(awk -v want="$version" '
  /^## / {
    heading = substr($0, 4)
    sub(/^v/, "", heading)
    if (heading == want) { printing = 1; print $0; next }
    printing = 0
    next
  }
  printing { print }
' "$CHANGELOG")"

[ -n "$section" ] ||
  fail "the changelog has no '## ${version}' section - rename the CHANGELOG heading to '## ${version}' in the release commit"

# A heading without a body would publish a near-empty release.
body="$(printf '%s\n' "$section" | sed '1d')"
[ -n "$(printf '%s' "$body" | tr -d '[:space:]')" ] ||
  fail "the changelog section '## ${version}' is empty - a release needs its notes"

# The compare link needs the tags: the checkout only fetched the released one.
git fetch --quiet --tags origin || fail "could not fetch the tags from origin"

# The previous release tag = the newest tag older than the released one.
# "sort -V" puts the tags in version order (it understands the "v" prefix), so
# the tag right before the released one is the newest older tag. The selection
# is positional on purpose: a string comparison would disagree with the
# version order ("v0.10.0" < "v0.9.0" lexically, but it is the newer tag).
previous_tag="$(git tag --list 'v*' | sort -V | awk -v current="$tag" '
  seen { next }
  $0 == current { seen = 1; next }
  { previous = $0 }
  END { if (seen) print previous }
')"

if [ -n "$previous_tag" ]; then
  compare="${REPO_URL}/compare/${previous_tag}...${tag}"
else
  compare="${REPO_URL}/releases/tag/${tag}"
fi

notes="$(printf '%s\n\n**Full Changelog**: %s\n' "$section" "$compare")"

if [ -n "$OUTPUT" ]; then
  printf '%s\n' "$notes" >"$OUTPUT"
else
  printf '%s\n' "$notes"
fi

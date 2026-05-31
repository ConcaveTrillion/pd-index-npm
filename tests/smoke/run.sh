#!/usr/bin/env bash
# End-to-end smoke test for pdomain-index-npm.
#
# Preconditions:
#   - PACKAGE has at least one published version in the index.
#   - You have curl, jq, and npm installed.
#
# What it does:
#   1. curl the packument JSON, validate shape.
#   2. curl the tarball URL the packument points at, validate it's a real tgz.
#   3. Create a brand-new throwaway directory.
#   4. Write a minimal .npmrc pointing the @pdomain scope at the index.
#   5. `npm install ${PACKAGE}@${VERSION:-latest}` from that dir.
#   6. Assert npm installed the expected package/version from the registry.
#
# Exit non-zero on any step's failure.

set -euo pipefail

REGISTRY="${REGISTRY:-https://pdomain.github.io/pdomain-index-npm/}"
REGISTRY="${REGISTRY%/}/"
PACKAGE="${PACKAGE:-@pdomain/pdomain-ui}"
VERSION="${VERSION:-}"
# GitHub Pages decodes %2f to / in the path, so we use the real slash form.
PKG_PATH="$PACKAGE"

case "$PACKAGE" in
  @pdomain/*) ;;
  *) echo "PACKAGE must be an @pdomain/* package name" >&2; exit 2 ;;
esac

case "$PACKAGE$VERSION" in
  *$'\n'*|*$'\r'*) echo "PACKAGE and VERSION must not contain newlines" >&2; exit 2 ;;
esac

echo "::group::Fetch + validate packument"
PACKUMENT_URL="${REGISTRY}${PKG_PATH}/"
PACKUMENT=$(curl -fsSL "$PACKUMENT_URL")
echo "$PACKUMENT" | jq -e --arg package "$PACKAGE" '.name == $package' >/dev/null
if [ -z "$VERSION" ]; then
  VERSION=$(echo "$PACKUMENT" | jq -r '."dist-tags".latest')
fi
test -n "$VERSION" && test "$VERSION" != "null"
echo "$PACKUMENT" | jq -e --arg version "$VERSION" '.versions[$version].dist.tarball | test("^https://github[.]com/pdomain/pdomain-ui/releases/download/.+[.]tgz$")' >/dev/null
TARBALL_URL=$(echo "$PACKUMENT" | jq -r --arg version "$VERSION" '.versions[$version].dist.tarball')
echo "OK: packument shape valid; tarball URL = $TARBALL_URL"
echo "::endgroup::"

echo "::group::Fetch + validate tarball"
TGZ=$(mktemp --suffix=.tgz)
TAR_LIST=$(mktemp)
WORK=$(mktemp -d)
trap 'rm -f "$TGZ" "$TAR_LIST"; rm -rf "$WORK"' EXIT
curl -fsSL "$TARBALL_URL" -o "$TGZ"
file "$TGZ" | grep -q "gzip compressed" || { echo "Tarball is not gzip!"; exit 1; }
tar -tzf "$TGZ" > "$TAR_LIST"
grep -q "^package/package.json$" "$TAR_LIST" || { echo "Tarball missing package.json!"; exit 1; }
echo "OK: tarball is real npm-shape gzipped tar"
echo "::endgroup::"

echo "::group::Install via npm from a clean directory"
pushd "$WORK" >/dev/null
cat > .npmrc <<NPM
@pdomain:registry=${REGISTRY}
NPM
npm init -y >/dev/null
npm install --no-audit --no-fund "${PACKAGE}@${VERSION}"
PACKAGE_JSON_PATH="./node_modules/${PACKAGE}/package.json" \
EXPECTED_PACKAGE="$PACKAGE" \
EXPECTED_VERSION="$VERSION" \
  node -e "const p=require(process.env.PACKAGE_JSON_PATH); if (p.name !== process.env.EXPECTED_PACKAGE || p.version !== process.env.EXPECTED_VERSION) process.exit(1)"
popd >/dev/null
echo "OK: clean-dir npm install resolved through pdomain-index-npm"
echo "::endgroup::"

echo "SMOKE PASSED"

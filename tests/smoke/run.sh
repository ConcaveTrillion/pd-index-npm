#!/usr/bin/env bash
# End-to-end smoke test for pdomain-index-npm.
#
# Preconditions:
#   - @pdomain/pdomain-ui has at least one published version in the index.
#   - You have curl, jq, and npm installed.
#
# What it does:
#   1. curl the packument JSON, validate shape.
#   2. curl the tarball URL the packument points at, validate it's a real tgz.
#   3. Create a brand-new throwaway directory.
#   4. Write a minimal .npmrc pointing the @pdomain scope at the index.
#   5. `npm install @pdomain/pdomain-ui@<latest>` from that dir.
#   6. Assert npm installed the expected package/version from the registry.
#
# Exit non-zero on any step's failure.

set -euo pipefail

REGISTRY="${REGISTRY:-https://pdomain.github.io/pdomain-index-npm/}"
PACKAGE="@pdomain/pdomain-ui"
# GitHub Pages decodes %2f to / in the path, so we use the real slash form.
PKG_PATH="@pdomain/pdomain-ui"

echo "::group::Fetch + validate packument"
PACKUMENT_URL="${REGISTRY}${PKG_PATH}/"
PACKUMENT=$(curl -fsSL "$PACKUMENT_URL")
echo "$PACKUMENT" | jq -e '.name == "@pdomain/pdomain-ui"' >/dev/null
VERSION=$(echo "$PACKUMENT" | jq -r '."dist-tags".latest')
test -n "$VERSION" && test "$VERSION" != "null"
echo "$PACKUMENT" | jq -e ".versions.\"$VERSION\".dist.tarball | startswith(\"https://\")" >/dev/null
TARBALL_URL=$(echo "$PACKUMENT" | jq -r ".versions.\"$VERSION\".dist.tarball")
echo "OK: packument shape valid; tarball URL = $TARBALL_URL"
echo "::endgroup::"

echo "::group::Fetch + validate tarball"
TGZ=$(mktemp --suffix=.tgz)
curl -fsSL "$TARBALL_URL" -o "$TGZ"
file "$TGZ" | grep -q "gzip compressed" || { echo "Tarball is not gzip!"; exit 1; }
TAR_LIST=$(mktemp)
tar -tzf "$TGZ" > "$TAR_LIST"
grep -q "^package/package.json$" "$TAR_LIST" || { echo "Tarball missing package.json!"; exit 1; }
echo "OK: tarball is real npm-shape gzipped tar"
echo "::endgroup::"

echo "::group::Install via npm from a clean directory"
WORK=$(mktemp -d)
pushd "$WORK" >/dev/null
cat > .npmrc <<NPM
@pdomain:registry=${REGISTRY}
NPM
npm init -y >/dev/null
npm install --no-audit --no-fund "${PACKAGE}@${VERSION}"
node -e "const p=require('./node_modules/@pdomain/pdomain-ui/package.json'); if (p.name !== '${PACKAGE}' || p.version !== '${VERSION}') process.exit(1)"
popd >/dev/null
rm -rf "$WORK"
echo "OK: clean-dir npm install resolved through pdomain-index-npm"
echo "::endgroup::"

echo "SMOKE PASSED"

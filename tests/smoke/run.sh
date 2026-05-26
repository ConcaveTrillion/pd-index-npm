#!/usr/bin/env bash
# End-to-end smoke test for pdomain-index-npm.
#
# Preconditions:
#   - The smoke-test fixture @pdomain/test-package@0.0.1 has been
#     published to the index (via the publish.yml workflow).
#   - You have curl, jq, and npm installed.
#
# What it does:
#   1. curl the packument JSON, validate shape.
#   2. curl the tarball URL the packument points at, validate it's a real tgz.
#   3. Create a brand-new throwaway directory.
#   4. Write a minimal .npmrc pointing the @concavetrillion scope at the index.
#   5. `npm install @pdomain/test-package@0.0.1` from that dir.
#   6. require() the installed package; assert it logs the smoke string.
#
# Exit non-zero on any step's failure.

set -euo pipefail

REGISTRY="${REGISTRY:-https://concavetrillion.github.io/pdomain-index-npm/}"
PACKAGE="@pdomain/test-package"
VERSION="0.0.1"
# GitHub Pages decodes %2f to / in the path, so we use the real slash form.
PKG_PATH="@pdomain/test-package"

echo "::group::Fetch + validate packument"
# npm GETs /@concavetrillion%2ftest-package; Pages decodes to /@pdomain/test-package/
# and serves index.html. We curl the decoded path directly.
PACKUMENT_URL="${REGISTRY}${PKG_PATH}/"
PACKUMENT=$(curl -fsSL "$PACKUMENT_URL")
echo "$PACKUMENT" | jq -e '.name == "@pdomain/test-package"' >/dev/null
echo "$PACKUMENT" | jq -e ".versions.\"$VERSION\".dist.tarball | startswith(\"https://\")" >/dev/null
TARBALL_URL=$(echo "$PACKUMENT" | jq -r ".versions.\"$VERSION\".dist.tarball")
echo "OK: packument shape valid; tarball URL = $TARBALL_URL"
echo "::endgroup::"

echo "::group::Fetch + validate tarball"
TGZ=$(mktemp --suffix=.tgz)
curl -fsSL "$TARBALL_URL" -o "$TGZ"
file "$TGZ" | grep -q "gzip compressed" || { echo "Tarball is not gzip!"; exit 1; }
tar -tzf "$TGZ" | grep -q "^package/package.json$" || { echo "Tarball missing package.json!"; exit 1; }
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
node -e "console.log(require('${PACKAGE}'))" | grep -q "pdomain-index-npm smoke ok"
popd >/dev/null
rm -rf "$WORK"
echo "OK: clean-dir npm install resolved through pdomain-index-npm"
echo "::endgroup::"

echo "SMOKE PASSED"

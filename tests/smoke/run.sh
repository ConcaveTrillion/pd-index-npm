#!/usr/bin/env bash
# End-to-end smoke test for pd-index-npm.
#
# Preconditions:
#   - The smoke-test fixture @concavetrillion/test-package@0.0.1 has been
#     published to the index (run Task 5's smoke-test once, manually).
#   - You have curl, jq, and npm installed.
#
# What it does:
#   1. curl the packument JSON, validate shape.
#   2. curl the tarball URL the packument points at, validate it's a real tgz.
#   3. Create a brand-new throwaway directory.
#   4. Write a minimal .npmrc pointing the @concavetrillion scope at the index.
#   5. `npm install @concavetrillion/test-package@0.0.1` from that dir.
#   6. require() the installed package; assert it logs the smoke string.
#
# Exit non-zero on any step's failure.

set -euo pipefail

REGISTRY="${REGISTRY:-https://concavetrillion.github.io/pd-index-npm/}"
PACKAGE="@concavetrillion/test-package"
VERSION="0.0.1"
ENC="@concavetrillion%2ftest-package"

echo "::group::Fetch + validate packument"
PACKUMENT_URL="${REGISTRY}${ENC}/"
PACKUMENT=$(curl -fsSL "$PACKUMENT_URL")
echo "$PACKUMENT" | jq -e '.name == "@concavetrillion/test-package"' >/dev/null
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
@concavetrillion:registry=${REGISTRY}
NPM
npm init -y >/dev/null
npm install --no-audit --no-fund "${PACKAGE}@${VERSION}"
node -e "console.log(require('${PACKAGE}'))" | grep -q "pd-index-npm smoke ok"
popd >/dev/null
rm -rf "$WORK"
echo "OK: clean-dir npm install resolved through pd-index-npm"
echo "::endgroup::"

echo "SMOKE PASSED"

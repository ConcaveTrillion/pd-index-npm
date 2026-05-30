import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rebuildPackuments } from "../scripts/rebuild-packuments.js";
import { buildMinimalTarball } from "./_tar.js";

const BASE_URL = "https://pdomain.github.io/pdomain-index-npm/";

async function fixtureWithTarball(
  pkgs: Array<{ name: string; version: string; [key: string]: unknown }>,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pdomain-index-npm-"));
  for (const pkg of pkgs) {
    // Use real slash directory structure (not %2f encoded)
    const tgzDir = join(root, pkg.name, "-");
    await mkdir(tgzDir, { recursive: true });
    const shortName = pkg.name.includes("/")
      ? pkg.name.split("/")[1]
      : pkg.name;
    const tgzBytes = await buildMinimalTarball(pkg);
    await writeFile(join(tgzDir, `${shortName}-${pkg.version}.tgz`), tgzBytes);
  }
  return root;
}

test("rebuildPackuments writes a valid packument JSON next to the tarball dir", async () => {
  const root = await fixtureWithTarball([
    { name: "@pdomain/test-package", version: "0.0.1" },
  ]);
  await rebuildPackuments({ root, baseUrl: BASE_URL });

  // Packument is stored as @pdomain/test-package/index.html
  const packumentPath = join(root, "@pdomain", "test-package", "index.html");
  const doc = JSON.parse(await readFile(packumentPath, "utf8")) as {
    name: string;
    "dist-tags": Record<string, string>;
    versions: Record<
      string,
      { dist: { tarball: string; integrity: string; shasum: string } }
    >;
  };

  assert.equal(doc.name, "@pdomain/test-package");
  assert.equal(doc["dist-tags"].latest, "0.0.1");
  assert.ok(doc.versions["0.0.1"]);
  assert.match(
    doc.versions["0.0.1"].dist.tarball,
    /^https:\/\/pdomain\.github\.io\/pdomain-index-npm\/@pdomain\/test-package\/-\/test-package-0\.0\.1\.tgz$/,
  );
  assert.match(doc.versions["0.0.1"].dist.integrity, /^sha512-/);
  assert.match(doc.versions["0.0.1"].dist.shasum, /^[0-9a-f]{40}$/);
});

test("rebuildPackuments merges multiple versions under one packument", async () => {
  const root = await fixtureWithTarball([
    { name: "@pdomain/test-package", version: "0.0.1" },
    { name: "@pdomain/test-package", version: "0.0.2" },
  ]);
  await rebuildPackuments({ root, baseUrl: BASE_URL });

  const packumentPath = join(root, "@pdomain", "test-package", "index.html");
  const doc = JSON.parse(await readFile(packumentPath, "utf8")) as {
    "dist-tags": Record<string, string>;
    versions: Record<string, unknown>;
    time: Record<string, string>;
  };

  assert.equal(doc["dist-tags"].latest, "0.0.2");
  assert.ok(doc.versions["0.0.1"]);
  assert.ok(doc.versions["0.0.2"]);
  assert.ok(doc.time["created"]);
  assert.ok(doc.time["modified"]);
});

test("rebuildPackuments respects prerelease ordering for dist-tags", async () => {
  const root = await fixtureWithTarball([
    { name: "@pdomain/test-package", version: "0.1.0-alpha.1" },
    { name: "@pdomain/test-package", version: "0.1.0-alpha.2" },
    { name: "@pdomain/test-package", version: "0.1.0" },
  ]);
  await rebuildPackuments({ root, baseUrl: BASE_URL });

  const packumentPath = join(root, "@pdomain", "test-package", "index.html");
  const doc = JSON.parse(await readFile(packumentPath, "utf8")) as {
    "dist-tags": Record<string, string>;
  };

  assert.equal(doc["dist-tags"].latest, "0.1.0");
  assert.equal(doc["dist-tags"].alpha, "0.1.0-alpha.2");
});

test("rebuildPackuments preserves install-relevant metadata fields", async () => {
  const root = await fixtureWithTarball([
    {
      name: "@pdomain/test-package",
      version: "0.1.0-alpha",
      dependencies: { konva: "^9.0.0", clsx: "^2.0.0" },
      peerDependencies: { react: "^18.0.0" },
      peerDependenciesMeta: { react: { optional: false } },
      optionalDependencies: { fsevents: "^2.0.0" },
      bundleDependencies: [],
      engines: { node: ">=20" },
      type: "module",
      exports: { ".": { import: "./dist/index.js" } },
      bin: { "test-cli": "./dist/cli.js" },
      os: ["linux"],
      cpu: ["x64"],
      deprecated: false,
    },
  ]);
  await rebuildPackuments({ root, baseUrl: BASE_URL });

  const packumentPath = join(root, "@pdomain", "test-package", "index.html");
  const doc = JSON.parse(await readFile(packumentPath, "utf8")) as {
    versions: Record<string, Record<string, unknown>>;
  };
  const v = doc.versions["0.1.0-alpha"];

  assert.deepEqual(v.dependencies, { konva: "^9.0.0", clsx: "^2.0.0" });
  assert.deepEqual(v.peerDependencies, { react: "^18.0.0" });
  assert.deepEqual(v.peerDependenciesMeta, { react: { optional: false } });
  assert.deepEqual(v.optionalDependencies, { fsevents: "^2.0.0" });
  assert.deepEqual(v.bundleDependencies, []);
  assert.deepEqual(v.engines, { node: ">=20" });
  assert.equal(v.type, "module");
  assert.deepEqual(v.exports, { ".": { import: "./dist/index.js" } });
  assert.deepEqual(v.bin, { "test-cli": "./dist/cli.js" });
  assert.deepEqual(v.os, ["linux"]);
  assert.deepEqual(v.cpu, ["x64"]);
});

test("rebuildPackuments omits absent metadata fields", async () => {
  const root = await fixtureWithTarball([
    { name: "@pdomain/test-package", version: "0.0.1" },
  ]);
  await rebuildPackuments({ root, baseUrl: BASE_URL });

  const packumentPath = join(root, "@pdomain", "test-package", "index.html");
  const doc = JSON.parse(await readFile(packumentPath, "utf8")) as {
    versions: Record<string, Record<string, unknown>>;
  };
  const v = doc.versions["0.0.1"];

  assert.equal("dependencies" in v, false);
  assert.equal("peerDependencies" in v, false);
});

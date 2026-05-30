/**
 * rebuild-packuments.ts
 *
 * Scans a registry root directory (typically a gh-pages checkout), finds all
 * .tgz files under each @scope/name/-/ directory, parses the tarball to
 * extract package.json, computes integrity + shasum, and (re)writes the
 * packument JSON file at <root>/@scope/name/index.html.
 *
 * The on-disk layout uses actual slash-based directories (not %2f-encoded
 * names) so that GitHub Pages can serve them correctly.
 *
 * This is the safety-net script: run it if a packument ever drifts from the
 * actual tarballs on disk. The publish script calls it incrementally (one
 * package at a time). You can also call it directly:
 *
 *   node dist/rebuild-packuments.js --root ./gh-pages-checkout
 */

import { readdir, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import {
  tarballUrlFor,
  packumentPathFor,
  type Packument,
  type PackumentVersion,
} from "./registry-layout.js";

// ---------------------------------------------------------------------------
// Minimal tar entry reader (no third-party dep)
// ---------------------------------------------------------------------------

interface TarEntry {
  name: string;
  size: number;
  data: Buffer;
}

function parseTarEntries(buf: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0+$/, "");
    const sizeOctal = header
      .subarray(124, 136)
      .toString("ascii")
      .replace(/\0+$/, "")
      .trim();
    const size = parseInt(sizeOctal, 8) || 0;
    const typeFlag = header[156];
    offset += 512;
    if (typeFlag === 0 || typeFlag === 48) {
      entries.push({ name, size, data: buf.subarray(offset, offset + size) });
    }
    offset += Math.ceil(size / 512) * 512;
  }
  return entries;
}

async function extractPackageJson(
  tgzBuffer: Buffer,
): Promise<Record<string, unknown>> {
  const gunzipped = await new Promise<Buffer>((resolve, reject) => {
    const gunzip = createGunzip();
    const chunks: Buffer[] = [];
    Readable.from(tgzBuffer).pipe(gunzip);
    gunzip.on("data", (c: Buffer) => chunks.push(c));
    gunzip.on("end", () => resolve(Buffer.concat(chunks)));
    gunzip.on("error", reject);
  });
  const entries = parseTarEntries(gunzipped);
  const entry = entries.find(
    (e) =>
      e.name === "package/package.json" || e.name.endsWith("/package.json"),
  );
  if (!entry) throw new Error("No package/package.json found in tarball");
  return JSON.parse(entry.data.toString("utf8")) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Semver comparison (no third-party dep)
// ---------------------------------------------------------------------------

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string;
  prereleaseTag: string;
  raw: string;
}

function parseVersion(v: string): ParsedVersion {
  const match = v.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9][a-zA-Z0-9._-]*))?$/,
  );
  if (!match) throw new Error(`Invalid semver: ${v}`);
  const prerelease = match[4] ?? "";
  const prereleaseTag =
    prerelease.split(".")[0].replace(/\d+$/, "") || prerelease.split(".")[0];
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease,
    prereleaseTag,
    raw: v,
  };
}

function semverCompare(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  if (!pa.prerelease && pb.prerelease) return 1;
  if (pa.prerelease && !pb.prerelease) return -1;
  if (pa.prerelease < pb.prerelease) return -1;
  if (pa.prerelease > pb.prerelease) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Install-relevant metadata
// ---------------------------------------------------------------------------

/**
 * Fields a package manager needs from a packument version object to resolve
 * a dependency tree. Omitting `dependencies` here is what previously caused
 * `@pdomain/pdomain-ui` to install with no transitive deps fetched.
 */
const INSTALL_METADATA_KEYS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "optionalDependencies",
  "bundleDependencies",
  "bundledDependencies",
  "engines",
  "exports",
  "imports",
  "type",
  "bin",
  "os",
  "cpu",
  "sideEffects",
  "funding",
  "deprecated",
  "hasInstallScript",
] as const;

function pickInstallMetadata(
  pkgJson: Record<string, unknown>,
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of INSTALL_METADATA_KEYS) {
    if (pkgJson[key] !== undefined) {
      picked[key] = pkgJson[key];
    }
  }
  return picked;
}

function stringField(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RebuildOptions {
  root: string;
  baseUrl: string;
  packageName?: string;
}

export interface RebuildResult {
  rebuilt: string[];
}

/**
 * Walk the registry root for scope directories (@...) and find packages.
 * Returns an array of canonical package names like "@pdomain/pdomain-ui".
 */
async function findPackages(
  root: string,
  filterName?: string,
): Promise<string[]> {
  const results: string[] = [];
  let scopeDirs: string[];
  try {
    scopeDirs = (await readdir(root)).filter((e) => e.startsWith("@"));
  } catch {
    return results;
  }

  for (const scopeDir of scopeDirs) {
    if (filterName && !filterName.startsWith(scopeDir)) continue;
    const scopePath = join(root, scopeDir);
    let pkgDirs: string[];
    try {
      const s = await stat(scopePath);
      if (!s.isDirectory()) continue;
      pkgDirs = await readdir(scopePath);
    } catch {
      continue;
    }

    for (const pkgDir of pkgDirs) {
      const canonicalName = `${scopeDir}/${pkgDir}`;
      if (filterName && canonicalName !== filterName) continue;
      // Check if there's a -/ tarball directory
      const tarballDir = join(scopePath, pkgDir, "-");
      try {
        const s = await stat(tarballDir);
        if (s.isDirectory()) results.push(canonicalName);
      } catch {
        // no -/ dir
      }
    }
  }
  return results;
}

export async function rebuildPackuments(
  opts: RebuildOptions,
): Promise<RebuildResult> {
  const { root, baseUrl } = opts;
  const rebuilt: string[] = [];

  const packages = await findPackages(root, opts.packageName);

  for (const canonicalName of packages) {
    const tarballDir = join(root, canonicalName, "-");

    let tarballs: string[];
    try {
      tarballs = (await readdir(tarballDir)).filter((f) => f.endsWith(".tgz"));
    } catch {
      continue;
    }
    if (tarballs.length === 0) continue;

    // Load existing packument to preserve time.created
    const packumentRelPath = packumentPathFor(canonicalName);
    const packumentAbsPath = join(root, packumentRelPath);
    let existingCreated: string | undefined;
    let existingVersionTimes: Record<string, string> = {};
    try {
      const existing = JSON.parse(
        await readFile(packumentAbsPath, "utf8"),
      ) as Packument;
      existingCreated = existing.time?.created;
      existingVersionTimes = { ...existing.time };
      delete existingVersionTimes["created"];
      delete existingVersionTimes["modified"];
    } catch {
      // No existing packument
    }

    const versionMeta: Record<string, PackumentVersion> = {};
    const versionTimes: Record<string, string> = {};

    for (const tgzFile of tarballs) {
      const tgzPath = join(tarballDir, tgzFile);
      const tgzBuffer = await readFile(tgzPath);

      let pkgJson: Record<string, unknown>;
      try {
        pkgJson = await extractPackageJson(tgzBuffer);
      } catch (err) {
        console.warn(`Skipping ${tgzFile}: ${(err as Error).message}`);
        continue;
      }

      const name = stringField(pkgJson["name"], canonicalName);
      const version = stringField(pkgJson["version"]);
      if (!version) continue;

      const shasum = createHash("sha1").update(tgzBuffer).digest("hex");
      const sha512 = createHash("sha512").update(tgzBuffer).digest("base64");
      const integrity = `sha512-${sha512}`;
      const tarball = tarballUrlFor(baseUrl, name, version);

      versionMeta[version] = {
        name,
        version,
        description: stringField(pkgJson["description"]),
        main: stringField(pkgJson["main"], "index.js"),
        ...pickInstallMetadata(pkgJson),
        dist: { tarball, shasum, integrity },
      };

      if (existingVersionTimes[version]) {
        versionTimes[version] = existingVersionTimes[version];
      } else {
        const fileStat = await stat(tgzPath);
        versionTimes[version] = fileStat.mtime.toISOString();
      }
    }

    if (Object.keys(versionMeta).length === 0) continue;

    const sortedVersions = Object.keys(versionMeta).sort(semverCompare);

    const distTags: Record<string, string> = {};
    const stableVersions = sortedVersions.filter(
      (v) => !parseVersion(v).prerelease,
    );
    distTags["latest"] =
      stableVersions.length > 0
        ? stableVersions[stableVersions.length - 1]
        : sortedVersions[sortedVersions.length - 1];

    const prereleasesByTag: Record<string, string[]> = {};
    for (const v of sortedVersions) {
      const parsed = parseVersion(v);
      if (parsed.prerelease) {
        const tag = parsed.prereleaseTag || "prerelease";
        if (!prereleasesByTag[tag]) prereleasesByTag[tag] = [];
        prereleasesByTag[tag].push(v);
      }
    }
    for (const [tag, versions] of Object.entries(prereleasesByTag)) {
      distTags[tag] = versions[versions.length - 1];
    }

    const now = new Date().toISOString();
    const created = existingCreated ?? versionTimes[sortedVersions[0]] ?? now;
    const time: Record<string, string> = {
      created,
      modified: now,
      ...versionTimes,
    };

    const versions: Record<string, PackumentVersion> = {};
    for (const v of sortedVersions) {
      versions[v] = versionMeta[v];
    }

    const packument: Packument = {
      name: canonicalName,
      "dist-tags": distTags,
      versions,
      time,
    };

    await mkdir(dirname(packumentAbsPath), { recursive: true });
    await writeFile(
      packumentAbsPath,
      JSON.stringify(packument, null, 2),
      "utf8",
    );
    rebuilt.push(canonicalName);
  }

  return { rebuilt };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const idx = (flag: string) => args.indexOf(flag);

  const root = idx("--root") >= 0 ? args[idx("--root") + 1] : process.cwd();
  const baseUrl =
    idx("--base-url") >= 0
      ? args[idx("--base-url") + 1]
      : "https://pdomain.github.io/pdomain-index-npm/";
  const packageName =
    idx("--package") >= 0 ? args[idx("--package") + 1] : undefined;

  rebuildPackuments({ root, baseUrl, packageName })
    .then(({ rebuilt }) => {
      if (rebuilt.length === 0) {
        console.log("No packuments rebuilt (no tarballs found).");
      } else {
        console.log(`Rebuilt packuments for: ${rebuilt.join(", ")}`);
      }
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

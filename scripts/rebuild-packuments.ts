/**
 * rebuild-packuments.ts
 *
 * Scans a registry root directory (typically a gh-pages checkout), finds all
 * .tgz files under each <scope>%2f<name>/-/ directory, parses the tarball to
 * extract package.json, computes integrity + shasum, and (re)writes the
 * packument JSON file at <root>/<scope>%2f<name>/index.html.
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
  encodeScopedName,
  decodeScopedName,
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

/** Read all tar entries from a Buffer (uncompressed tar). */
function parseTarEntries(buf: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    // Check for end-of-archive (two 512-byte zero blocks)
    if (header.every((b) => b === 0)) break;

    const name = header.subarray(0, 100).toString("utf8").replace(/\0+$/, "");
    const sizeOctal = header
      .subarray(124, 136)
      .toString("ascii")
      .replace(/\0+$/, "")
      .trim();
    const size = parseInt(sizeOctal, 8) || 0;
    const typeFlag = header[156];

    offset += 512; // skip header block

    if (typeFlag === 0 || typeFlag === 48 /* '0' */) {
      // Regular file
      const data = buf.subarray(offset, offset + size);
      entries.push({ name, size, data });
    }

    // Advance past data blocks (padded to 512-byte boundaries)
    offset += Math.ceil(size / 512) * 512;
  }
  return entries;
}

/** Extract package/package.json from a .tgz Buffer. */
async function extractPackageJson(
  tgzBuffer: Buffer,
): Promise<Record<string, unknown>> {
  // Gunzip
  const gunzipped = await new Promise<Buffer>((resolve, reject) => {
    const gunzip = createGunzip();
    const chunks: Buffer[] = [];
    const readable = Readable.from(tgzBuffer);
    readable.pipe(gunzip);
    gunzip.on("data", (chunk: Buffer) => chunks.push(chunk));
    gunzip.on("end", () => resolve(Buffer.concat(chunks)));
    gunzip.on("error", reject);
    readable.on("error", reject);
  });

  const entries = parseTarEntries(gunzipped);
  const pkgEntry = entries.find(
    (e) =>
      e.name === "package/package.json" ||
      e.name.endsWith("/package.json"),
  );
  if (!pkgEntry) {
    throw new Error("No package/package.json found in tarball");
  }
  return JSON.parse(pkgEntry.data.toString("utf8")) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Semver comparison (no third-party dep)
// ---------------------------------------------------------------------------

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string;
  prereleaseTag: string; // e.g. "alpha" from "0.1.0-alpha.2"
  raw: string;
}

function parseVersion(v: string): ParsedVersion {
  const match = v.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9][a-zA-Z0-9._-]*))?$/,
  );
  if (!match) throw new Error(`Invalid semver: ${v}`);
  const prerelease = match[4] ?? "";
  const prereleaseTag = prerelease.split(".")[0].replace(/\d+$/, "") || prerelease.split(".")[0];
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease,
    prereleaseTag,
    raw: v,
  };
}

/** Compare two version strings. Returns negative / 0 / positive. */
function semverCompare(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  // A prerelease version is always lower than the release version
  if (!pa.prerelease && pb.prerelease) return 1;
  if (pa.prerelease && !pb.prerelease) return -1;
  // Both have prerelease or neither does
  if (pa.prerelease < pb.prerelease) return -1;
  if (pa.prerelease > pb.prerelease) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RebuildOptions {
  /** Path to the registry root (gh-pages checkout or local fixture). */
  root: string;
  /** Base URL of the registry, e.g. "https://concavetrillion.github.io/pd-index-npm/" */
  baseUrl: string;
  /** Optional: only rebuild this one packument (canonical npm name). */
  packageName?: string;
}

export interface RebuildResult {
  rebuilt: string[];
}

export async function rebuildPackuments(
  opts: RebuildOptions,
): Promise<RebuildResult> {
  const { root, baseUrl } = opts;
  const rebuilt: string[] = [];

  // Find all encoded package dirs (e.g. "@concavetrillion%2fpd-ui")
  const entries = await readdir(root);
  const encodedDirs = entries.filter((e) => {
    if (opts.packageName) {
      return e === encodeScopedName(opts.packageName);
    }
    return e.startsWith("@") && e.includes("%2");
  });

  for (const encodedDir of encodedDirs) {
    const canonicalName = decodeScopedName(encodedDir);
    const tarballDir = join(root, encodedDir, "-");

    // Check the -/ subdirectory exists
    let tarballs: string[];
    try {
      const s = await stat(tarballDir);
      if (!s.isDirectory()) continue;
      tarballs = (await readdir(tarballDir)).filter((f) => f.endsWith(".tgz"));
    } catch {
      // No -/ directory yet — skip
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
      // No existing packument — start fresh
    }

    // Parse each tarball
    const versionMeta: Record<string, PackumentVersion> = {};
    const versionTimes: Record<string, string> = {};

    for (const tgzFile of tarballs) {
      const tgzPath = join(tarballDir, tgzFile);
      const tgzBuffer = await readFile(tgzPath);

      // Extract package.json from the tarball
      let pkgJson: Record<string, unknown>;
      try {
        pkgJson = await extractPackageJson(tgzBuffer);
      } catch (err) {
        console.warn(`Skipping ${tgzFile}: ${(err as Error).message}`);
        continue;
      }

      const name = String(pkgJson["name"] ?? canonicalName);
      const version = String(pkgJson["version"] ?? "");
      if (!version) continue;

      // Compute hashes
      const shasum = createHash("sha1").update(tgzBuffer).digest("hex");
      const sha512 = createHash("sha512").update(tgzBuffer).digest("base64");
      const integrity = `sha512-${sha512}`;

      const tarball = tarballUrlFor(baseUrl, name, version);

      versionMeta[version] = {
        name,
        version,
        description: String(pkgJson["description"] ?? ""),
        main: String(pkgJson["main"] ?? "index.js"),
        dist: { tarball, shasum, integrity },
      };

      // Preserve existing timestamp for this version, or use file mtime
      if (existingVersionTimes[version]) {
        versionTimes[version] = existingVersionTimes[version];
      } else {
        const fileStat = await stat(tgzPath);
        versionTimes[version] = fileStat.mtime.toISOString();
      }
    }

    if (Object.keys(versionMeta).length === 0) continue;

    // Sort versions
    const sortedVersions = Object.keys(versionMeta).sort(semverCompare);

    // Determine dist-tags
    const distTags: Record<string, string> = {};

    // latest = highest non-prerelease, or highest overall if all are prereleases
    const stableVersions = sortedVersions.filter(
      (v) => !parseVersion(v).prerelease,
    );
    if (stableVersions.length > 0) {
      distTags["latest"] = stableVersions[stableVersions.length - 1];
    } else {
      distTags["latest"] = sortedVersions[sortedVersions.length - 1];
    }

    // Per-prerelease-tag dist-tags (e.g. "alpha" -> latest alpha version)
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

    // Build time object
    const now = new Date().toISOString();
    const allTimes = { ...versionTimes };
    const created = existingCreated ?? versionTimes[sortedVersions[0]] ?? now;

    const time: Record<string, string> = {
      created,
      modified: now,
      ...allTimes,
    };

    // Build ordered versions object
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

    // Ensure the parent directory exists (should already exist as the encoded dir)
    await mkdir(dirname(packumentAbsPath), { recursive: true });
    await writeFile(packumentAbsPath, JSON.stringify(packument, null, 2), "utf8");
    rebuilt.push(canonicalName);
  }

  return { rebuilt };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const rootIdx = args.indexOf("--root");
  const baseUrlIdx = args.indexOf("--base-url");
  const pkgIdx = args.indexOf("--package");

  const root = rootIdx >= 0 ? args[rootIdx + 1] : process.cwd();
  const baseUrl =
    baseUrlIdx >= 0
      ? args[baseUrlIdx + 1]
      : "https://concavetrillion.github.io/pd-index-npm/";
  const packageName = pkgIdx >= 0 ? args[pkgIdx + 1] : undefined;

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

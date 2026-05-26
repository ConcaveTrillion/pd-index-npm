/**
 * publish.ts
 *
 * Publishes a single .tgz tarball into the pdomain-index-npm static registry.
 *
 * Algorithm:
 *   1. If tarballUrl given, download via Node 20 native fetch().
 *   2. Parse package/package.json out of the tarball to get { name, version }.
 *   3. Compute integrity (SHA-512) + shasum (SHA-1).
 *   4. Check existing packument — if same version exists with DIFFERENT shasum,
 *      throw PublishConflictError. Same-bytes re-publish is idempotent (no-op).
 *   5. Write tarball into <root>/@scope/name/-/<name>-<version>.tgz.
 *   6. Call rebuildPackuments({ root, baseUrl, packageName }) to refresh the packument.
 *
 * CLI usage:
 *   node dist/scripts/publish.js --tarball <path> --root <gh-pages-checkout> --base-url <url>
 *   node dist/scripts/publish.js --tarball-url <url> --root <gh-pages-checkout> --base-url <url>
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import {
  tarballDirFor,
  packumentPathFor,
} from "./registry-layout.js";
import { rebuildPackuments, type RebuildOptions } from "./rebuild-packuments.js";

export type { RebuildOptions };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PublishOptions {
  /** Absolute path to the registry root (gh-pages checkout or local fixture). */
  root: string;
  /** Local path to the .tgz to publish. Mutually exclusive with tarballUrl. */
  tarballPath?: string;
  /** URL to download the .tgz from. Mutually exclusive with tarballPath. */
  tarballUrl?: string;
  /** Registry base URL, e.g. "https://concavetrillion.github.io/pdomain-index-npm/" */
  baseUrl: string;
}

export interface PublishResult {
  packageName: string;
  version: string;
  packumentPath: string;
  tarballRestingPath: string;
}

export class PublishConflictError extends Error {
  constructor(packageName: string, version: string) {
    super(
      `Version ${version} of ${packageName} is already published with different content. ` +
        `npm versions are immutable. To fix a release, publish a new version.`,
    );
    this.name = "PublishConflictError";
  }
}

// ---------------------------------------------------------------------------
// Minimal tar parser (no deps)
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
// Download helper
// ---------------------------------------------------------------------------

async function downloadUrl(url: string): Promise<Buffer> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${resp.status}`);
  }
  const ab = await resp.arrayBuffer();
  return Buffer.from(ab);
}

// ---------------------------------------------------------------------------
// Core publish logic
// ---------------------------------------------------------------------------

export async function publish(opts: PublishOptions): Promise<PublishResult> {
  const { root, baseUrl } = opts;

  if (!opts.tarballPath && !opts.tarballUrl) {
    throw new Error("Either tarballPath or tarballUrl must be provided");
  }

  // Step 1: Get tarball bytes
  let tgzBuffer: Buffer;
  if (opts.tarballPath) {
    tgzBuffer = await readFile(opts.tarballPath);
  } else {
    tgzBuffer = await downloadUrl(opts.tarballUrl!);
  }

  // Step 2: Parse package.json from tarball
  const pkgJson = await extractPackageJson(tgzBuffer);
  const packageName = String(pkgJson["name"] ?? "");
  const version = String(pkgJson["version"] ?? "");
  if (!packageName || !version) {
    throw new Error(
      "Tarball's package.json is missing 'name' or 'version' fields",
    );
  }

  // Step 3: Compute hashes
  const shasum = createHash("sha1").update(tgzBuffer).digest("hex");

  // Step 4: Check existing packument for version conflict
  // Packument is at <root>/@scope/name/index.html
  const packumentAbsPath = join(root, packumentPathFor(packageName));
  try {
    const existing = JSON.parse(
      await readFile(packumentAbsPath, "utf8"),
    ) as {
      versions?: Record<string, { dist?: { shasum?: string } }>;
    };
    const existingVersion = existing.versions?.[version];
    if (existingVersion) {
      const existingShasum = existingVersion.dist?.shasum;
      if (existingShasum && existingShasum !== shasum) {
        throw new PublishConflictError(packageName, version);
      }
      // Idempotent re-publish of the same bytes: return early
      if (existingShasum === shasum) {
        const shortName = packageName.includes("/")
          ? packageName.split("/")[1]
          : packageName;
        const tarballRestingPath = join(
          root,
          tarballDirFor(packageName),
          `${shortName}-${version}.tgz`,
        );
        return {
          packageName,
          version,
          packumentPath: packumentAbsPath,
          tarballRestingPath,
        };
      }
    }
  } catch (err) {
    if (err instanceof PublishConflictError) throw err;
    // No existing packument — proceed
  }

  // Step 5: Write the tarball to its resting place
  const shortName = packageName.includes("/")
    ? packageName.split("/")[1]
    : packageName;
  const tarballDir = join(root, tarballDirFor(packageName));
  await mkdir(tarballDir, { recursive: true });
  const tarballFileName = `${shortName}-${version}.tgz`;
  const tarballRestingPath = join(tarballDir, tarballFileName);
  await writeFile(tarballRestingPath, tgzBuffer);

  // Step 6: Refresh the packument for this package
  await rebuildPackuments({ root, baseUrl, packageName });

  return {
    packageName,
    version,
    packumentPath: packumentAbsPath,
    tarballRestingPath,
  };
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
      : "https://concavetrillion.github.io/pdomain-index-npm/";
  const tarballPath =
    idx("--tarball") >= 0 ? args[idx("--tarball") + 1] : undefined;
  const tarballUrl =
    idx("--tarball-url") >= 0 ? args[idx("--tarball-url") + 1] : undefined;

  if (!tarballPath && !tarballUrl) {
    console.error(
      "Usage: publish.js --tarball <path> | --tarball-url <url> [--root <dir>] [--base-url <url>]",
    );
    process.exit(1);
  }

  publish({ root, tarballPath, tarballUrl, baseUrl })
    .then((result) => {
      console.log(
        `Published ${result.packageName}@${result.version}\n` +
          `  Tarball: ${result.tarballRestingPath}\n` +
          `  Packument: ${result.packumentPath}`,
      );
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}

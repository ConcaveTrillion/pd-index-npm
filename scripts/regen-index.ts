import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import {
  packumentPathFor,
  type Packument,
  type PackumentVersion,
} from "./registry-layout.js";

export const DEFAULT_REPOS = ["pdomain/pdomain-ui"] as const;
export const DEFAULT_EXPECTED_PACKAGES: Record<string, string> = {
  "pdomain/pdomain-ui": "@pdomain/pdomain-ui",
};
export const GITHUB_RELEASES_PER_PAGE = 100;
export const MAX_GITHUB_RELEASES = 1000;
export const DEFAULT_MAX_TARBALL_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_DECOMPRESSED_BYTES = 128 * 1024 * 1024;
export const DEFAULT_MAX_PACKAGE_JSON_BYTES = 1024 * 1024;

export interface RegenIndexOptions {
  root: string;
  githubApiBaseUrl?: string;
  repos?: string[];
  token?: string;
  maxTarballBytes?: number;
  maxDecompressedBytes?: number;
  maxPackageJsonBytes?: number;
  allowNonGithubAssetHostsForTests?: boolean;
}

export interface RegenIndexResult {
  scannedRepos: string[];
  generated: string[];
  published: string[];
  skipped: string[];
}

interface GithubReleaseAsset {
  name?: unknown;
  browser_download_url?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
}

interface GithubRelease {
  assets?: GithubReleaseAsset[];
}

interface TarballAsset {
  repo: string;
  url: string;
  time?: string;
}

interface TarEntry {
  name: string;
  size: number;
  data: Buffer;
}

interface IndexedVersion {
  packageName: string;
  version: string;
  time: string;
  meta: PackumentVersion;
}

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

function maxBytesError(label: string, maxBytes: number): Error {
  return new Error(`${label} exceeds maximum size of ${maxBytes} bytes`);
}

async function bufferReadableWithLimit(
  stream: AsyncIterable<Buffer | Uint8Array | string>,
  maxBytes: number,
  label: string,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > maxBytes) throw maxBytesError(label, maxBytes);
    chunks.push(buf);
  }
  return Buffer.concat(chunks, total);
}

async function bufferWebStreamWithLimit(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  label: string,
): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const buf = Buffer.from(value);
      total += buf.byteLength;
      if (total > maxBytes) throw maxBytesError(label, maxBytes);
      chunks.push(buf);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function downloadUrl(url: string, maxBytes: number): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    throw maxBytesError("Tarball", maxBytes);
  }
  if (!response.body) {
    throw new Error(`Failed to download ${url}: response body is empty`);
  }
  return bufferWebStreamWithLimit(response.body, maxBytes, "Tarball");
}

function parseTarEntries(buf: Buffer, maxPackageJsonBytes: number): TarEntry[] {
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
      if (
        (name === "package/package.json" || name.endsWith("/package.json")) &&
        size > maxPackageJsonBytes
      ) {
        throw maxBytesError("Tarball package.json", maxPackageJsonBytes);
      }
      entries.push({ name, size, data: buf.subarray(offset, offset + size) });
    }
    offset += Math.ceil(size / 512) * 512;
  }
  return entries;
}

async function extractPackageJson(
  tgzBuffer: Buffer,
  maxDecompressedBytes: number,
  maxPackageJsonBytes: number,
): Promise<Record<string, unknown>> {
  const gunzipped = await bufferReadableWithLimit(
    Readable.from(tgzBuffer).pipe(createGunzip()),
    maxDecompressedBytes,
    "Tarball decompressed data",
  );
  const entry = parseTarEntries(gunzipped, maxPackageJsonBytes).find(
    (e) =>
      e.name === "package/package.json" || e.name.endsWith("/package.json"),
  );
  if (!entry) throw new Error("No package/package.json found in tarball");
  return JSON.parse(entry.data.toString("utf8")) as Record<string, unknown>;
}

function pickInstallMetadata(
  pkgJson: Record<string, unknown>,
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of INSTALL_METADATA_KEYS) {
    if (pkgJson[key] !== undefined) picked[key] = pkgJson[key];
  }
  return picked;
}

function stringField(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function validTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

function parseVersion(v: string): {
  major: number;
  minor: number;
  patch: number;
  prerelease: string;
  prereleaseTag: string;
} {
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

async function listReleases(
  githubApiBaseUrl: string,
  repo: string,
  token?: string,
): Promise<GithubRelease[]> {
  const apiBase = githubApiBaseUrl.replace(/\/$/, "");
  const releases: GithubRelease[] = [];
  const maxPages = MAX_GITHUB_RELEASES / GITHUB_RELEASES_PER_PAGE;

  for (let page = 1; page <= maxPages; page++) {
    const response = await fetch(
      `${apiBase}/repos/${repo}/releases?per_page=${GITHUB_RELEASES_PER_PAGE}&page=${page}`,
      {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      },
    );
    if (!response.ok) {
      throw new Error(
        `Failed to list releases for ${repo}: HTTP ${response.status}`,
      );
    }
    const pageReleases = (await response.json()) as GithubRelease[];
    releases.push(...pageReleases);
    if (pageReleases.length < GITHUB_RELEASES_PER_PAGE) break;
  }

  return releases;
}

function isAllowedAssetUrl(
  url: string,
  allowNonGithubAssetHostsForTests: boolean,
): boolean {
  if (allowNonGithubAssetHostsForTests) return true;
  const parsed = new URL(url);
  return (
    parsed.protocol === "https:" &&
    (parsed.hostname === "github.com" ||
      parsed.hostname === "objects.githubusercontent.com")
  );
}

function releaseTarballAssets(
  repo: string,
  releases: GithubRelease[],
  allowNonGithubAssetHostsForTests: boolean,
): TarballAsset[] {
  const assets: TarballAsset[] = [];
  for (const release of releases) {
    for (const asset of release.assets ?? []) {
      const name = typeof asset.name === "string" ? asset.name : "";
      const url =
        typeof asset.browser_download_url === "string"
          ? asset.browser_download_url
          : "";
      if (!name.endsWith(".tgz") || !url) continue;
      if (!isAllowedAssetUrl(url, allowNonGithubAssetHostsForTests)) continue;
      assets.push({
        repo,
        url,
        time:
          validTimestamp(asset.updated_at) ?? validTimestamp(asset.created_at),
      });
    }
  }
  return assets;
}

async function indexTarballAsset(
  asset: TarballAsset,
  opts: Required<
    Pick<
      RegenIndexOptions,
      "maxTarballBytes" | "maxDecompressedBytes" | "maxPackageJsonBytes"
    >
  >,
): Promise<IndexedVersion> {
  const tgzBuffer = await downloadUrl(asset.url, opts.maxTarballBytes);
  const pkgJson = await extractPackageJson(
    tgzBuffer,
    opts.maxDecompressedBytes,
    opts.maxPackageJsonBytes,
  );
  const packageName = stringField(pkgJson["name"]);
  const version = stringField(pkgJson["version"]);
  if (!packageName || !version) {
    throw new Error(
      "Tarball's package.json is missing 'name' or 'version' fields",
    );
  }
  const shasum = createHash("sha1").update(tgzBuffer).digest("hex");
  const sha512 = createHash("sha512").update(tgzBuffer).digest("base64");

  return {
    packageName,
    version,
    time: asset.time ?? new Date().toISOString(),
    meta: {
      name: packageName,
      version,
      description: stringField(pkgJson["description"]),
      main: stringField(pkgJson["main"], "index.js"),
      ...pickInstallMetadata(pkgJson),
      dist: {
        tarball: asset.url,
        shasum,
        integrity: `sha512-${sha512}`,
      },
    },
  };
}

function buildPackument(
  packageName: string,
  indexedVersions: IndexedVersion[],
): Packument {
  const sortedVersions = indexedVersions
    .map((indexed) => indexed.version)
    .sort(semverCompare);
  const byVersion = new Map(
    indexedVersions.map((indexed) => [indexed.version, indexed]),
  );
  const stableVersions = sortedVersions.filter(
    (v) => !parseVersion(v).prerelease,
  );
  const distTags: Record<string, string> = {
    latest:
      stableVersions.length > 0
        ? stableVersions[stableVersions.length - 1]
        : sortedVersions[sortedVersions.length - 1],
  };
  const prereleasesByTag: Record<string, string[]> = {};
  for (const version of sortedVersions) {
    const parsed = parseVersion(version);
    if (!parsed.prerelease) continue;
    const tag = parsed.prereleaseTag || "prerelease";
    if (!prereleasesByTag[tag]) prereleasesByTag[tag] = [];
    prereleasesByTag[tag].push(version);
  }
  for (const [tag, versions] of Object.entries(prereleasesByTag)) {
    distTags[tag] = versions[versions.length - 1];
  }

  const now = new Date().toISOString();
  const versions: Record<string, PackumentVersion> = {};
  const versionTimes: Record<string, string> = {};
  for (const version of sortedVersions) {
    const indexed = byVersion.get(version);
    if (!indexed) continue;
    versions[version] = indexed.meta;
    versionTimes[version] = indexed.time;
  }

  return {
    name: packageName,
    "dist-tags": distTags,
    versions,
    time: {
      created: versionTimes[sortedVersions[0]] ?? now,
      modified: now,
      ...versionTimes,
    },
  };
}

export async function regenIndex(
  opts: RegenIndexOptions,
): Promise<RegenIndexResult> {
  const githubApiBaseUrl = opts.githubApiBaseUrl ?? "https://api.github.com";
  const repos = opts.repos ?? [...DEFAULT_REPOS];
  const maxTarballBytes = opts.maxTarballBytes ?? DEFAULT_MAX_TARBALL_BYTES;
  const maxDecompressedBytes =
    opts.maxDecompressedBytes ?? DEFAULT_MAX_DECOMPRESSED_BYTES;
  const maxPackageJsonBytes =
    opts.maxPackageJsonBytes ?? DEFAULT_MAX_PACKAGE_JSON_BYTES;
  const allowNonGithubAssetHostsForTests =
    opts.allowNonGithubAssetHostsForTests ?? false;
  const published: string[] = [];
  const skipped: string[] = [];
  const byPackage = new Map<string, IndexedVersion[]>();

  await rm(opts.root, { recursive: true, force: true });

  for (const repo of repos) {
    const releases = await listReleases(githubApiBaseUrl, repo, opts.token);
    const expectedPackageName = DEFAULT_EXPECTED_PACKAGES[repo];
    for (const asset of releaseTarballAssets(
      repo,
      releases,
      allowNonGithubAssetHostsForTests,
    )) {
      const indexed = await indexTarballAsset(asset, {
        maxTarballBytes,
        maxDecompressedBytes,
        maxPackageJsonBytes,
      });
      if (expectedPackageName && indexed.packageName !== expectedPackageName) {
        skipped.push(
          `${asset.url} (${indexed.packageName}; expected ${expectedPackageName})`,
        );
        continue;
      }
      const versions = byPackage.get(indexed.packageName) ?? [];
      versions.push(indexed);
      byPackage.set(indexed.packageName, versions);
      published.push(`${indexed.packageName}@${indexed.version}`);
    }
  }

  const generated = Array.from(byPackage.keys()).sort();
  for (const packageName of generated) {
    const versions = byPackage.get(packageName) ?? [];
    const packument = buildPackument(packageName, versions);
    const packumentAbsPath = join(opts.root, packumentPathFor(packageName));
    await mkdir(dirname(packumentAbsPath), { recursive: true });
    await writeFile(
      packumentAbsPath,
      JSON.stringify(packument, null, 2),
      "utf8",
    );
  }

  return { scannedRepos: repos, generated, published, skipped };
}

function repeatedArgs(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1]) values.push(args[i + 1]);
  }
  return values;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const idx = (flag: string) => args.indexOf(flag);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      "Usage: regen-index.js [--root <dir>] [--github-api-base-url <url>] [--repo <owner/repo>]...",
    );
    process.exit(0);
  }

  const root = idx("--root") >= 0 ? args[idx("--root") + 1] : "_site";
  const githubApiBaseUrl =
    idx("--github-api-base-url") >= 0
      ? args[idx("--github-api-base-url") + 1]
      : "https://api.github.com";
  const repos = repeatedArgs(args, "--repo");
  const token = process.env["GH_TOKEN"] ?? process.env["GITHUB_TOKEN"];

  regenIndex({
    root,
    githubApiBaseUrl,
    repos: repos.length > 0 ? repos : undefined,
    token,
  })
    .then((result) => {
      console.log(`Scanned repos: ${result.scannedRepos.join(", ")}`);
      if (result.published.length === 0) {
        console.log("No npm release tarballs found.");
      } else {
        console.log(`Indexed packages: ${result.published.join(", ")}`);
      }
      console.log(`Skipped release assets: ${result.skipped.length}`);
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}

/**
 * registry-layout.ts
 *
 * Types and constants describing the static on-disk layout of the pd-index-npm
 * registry (the shape the gh-pages branch must have for `npm install` to work).
 *
 * The layout uses actual slash-based directory structure (NOT %2f-encoded names):
 *
 *   @concavetrillion/test-package/                         <- directory
 *   @concavetrillion/test-package/index.html               <- packument JSON
 *   @concavetrillion/test-package/-/test-package-0.0.1.tgz <- tarball bytes
 *
 * When npm GETs `/@concavetrillion%2ftest-package`, GitHub Pages decodes the
 * %2f to a real slash and serves the directory. GitHub Pages then serves
 * `index.html` from that directory. npm parses the body as JSON regardless of
 * Content-Type. This is the standard approach for GitHub Pages-hosted static
 * npm registries (used by skypack, esm.sh, etc.).
 *
 * Tarball URLs in the packument also use the decoded slash form so that GitHub
 * Pages can serve them directly: `.../pd-index-npm/@concavetrillion/test-package/-/test-package-0.0.1.tgz`
 */

/**
 * Returns the package directory name for the on-disk layout.
 * "@concavetrillion/pd-ui" -> "@concavetrillion/pd-ui"
 * (We use the actual slash — GitHub Pages decodes %2f, so we match that.)
 */
export function packageDirFor(name: string): string {
  return name; // e.g. "@concavetrillion/pd-ui"
}

/** Returns the tarball directory path relative to the registry root.
 *  "@concavetrillion/pd-ui" -> "@concavetrillion/pd-ui/-"
 */
export function tarballDirFor(name: string): string {
  return `${name}/-`;
}

/**
 * Returns the packument file path relative to the registry root.
 * Packuments are stored as index.html so GitHub Pages serves them
 * when npm follows the redirect from /pkg to /pkg/.
 *
 * "@concavetrillion/pd-ui" -> "@concavetrillion/pd-ui/index.html"
 */
export function packumentPathFor(name: string): string {
  return `${name}/index.html`;
}

/**
 * Constructs the absolute tarball URL for a given package + version.
 * Uses the decoded slash form so GitHub Pages can serve it directly.
 *
 * baseUrl = "https://concavetrillion.github.io/pd-index-npm/"
 * name    = "@concavetrillion/pd-ui"
 * version = "0.1.0-alpha"
 * -> "https://concavetrillion.github.io/pd-index-npm/@concavetrillion/pd-ui/-/pd-ui-0.1.0-alpha.tgz"
 */
export function tarballUrlFor(
  baseUrl: string,
  name: string,
  version: string,
): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const shortName = name.includes("/") ? name.split("/")[1] : name;
  return `${base}${name}/-/${shortName}-${version}.tgz`;
}

/**
 * For compatibility: encode a scoped package name for URL usage.
 * The on-disk layout uses real slashes, but the URL the packument
 * exposes in dist.tarball uses the real slash form too.
 */
export function encodeScopedName(name: string): string {
  // Keep for backward compat / documentation; on disk we use real slashes
  return name.replace("/", "%2f");
}

/** Decode a path-encoded package name back to the canonical npm name. */
export function decodeScopedName(encoded: string): string {
  return encoded.replace(/%2f/i, "/");
}

/** Packument document shape (subset of the full npm registry packument). */
export interface PackumentVersion {
  name: string;
  version: string;
  description?: string;
  main?: string;
  dist: {
    tarball: string;
    shasum: string;
    integrity: string;
  };
  [key: string]: unknown;
}

export interface Packument {
  name: string;
  "dist-tags": Record<string, string>;
  versions: Record<string, PackumentVersion>;
  time: Record<string, string>;
}

/**
 * registry-layout.ts
 *
 * Types and constants describing the static on-disk layout of the pd-index-npm
 * registry (the shape the gh-pages branch must have for `npm install` to work).
 *
 * The layout mirrors what Verdaccio writes to disk under storage/:
 *
 *   @concavetrillion%2fpd-ui/                             <- directory
 *   @concavetrillion%2fpd-ui/index.html                   <- packument JSON
 *                                                            (GitHub Pages serves this when
 *                                                             npm GETs /@concavetrillion%2fpd-ui
 *                                                             via 301 -> trailing slash -> index.html)
 *   @concavetrillion%2fpd-ui/-/pd-ui-0.1.0.tgz           <- tarball bytes
 *
 * Note: the packument is stored as index.html so that GitHub Pages serves it
 * automatically when npm follows the redirect from /pkg to /pkg/. npm parses
 * the body as JSON regardless of Content-Type.
 */

/** Encode a scoped npm package name for use as a URL/filesystem path segment.
 *  "@concavetrillion/pd-ui" -> "@concavetrillion%2fpd-ui"
 *  The %2f (lowercase) is what npm CLI sends; we normalise it here.
 */
export function encodeScopedName(name: string): string {
  // Replace the "/" between scope and package name with %2f
  return name.replace("/", "%2f");
}

/** Decode a path-encoded package name back to the canonical npm name.
 *  "@concavetrillion%2fpd-ui" -> "@concavetrillion/pd-ui"
 */
export function decodeScopedName(encoded: string): string {
  return encoded.replace(/%2f/i, "/");
}

/** Returns the tarball directory path relative to the registry root.
 *  e.g.  "@concavetrillion/pd-ui" -> "@concavetrillion%2fpd-ui/-"
 */
export function tarballDirFor(name: string): string {
  return `${encodeScopedName(name)}/-`;
}

/**
 * Returns the packument FILE path relative to the registry root.
 * The packument is stored as index.html inside the package directory.
 * GitHub Pages serves it when npm GETs /@scope%2fname (redirected to /@scope%2fname/).
 *
 * e.g.  "@concavetrillion/pd-ui" -> "@concavetrillion%2fpd-ui/index.html"
 */
export function packumentPathFor(name: string): string {
  return `${encodeScopedName(name)}/index.html`;
}

/** Constructs the absolute tarball URL for a given package + version.
 *  e.g.  baseUrl = "https://concavetrillion.github.io/pd-index-npm/"
 *        name    = "@concavetrillion/pd-ui"
 *        version = "0.1.0-alpha"
 *        -> "https://concavetrillion.github.io/pd-index-npm/@concavetrillion%2fpd-ui/-/pd-ui-0.1.0-alpha.tgz"
 */
export function tarballUrlFor(
  baseUrl: string,
  name: string,
  version: string,
): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  // Unscoped package name (part after the /)
  const shortName = name.includes("/") ? name.split("/")[1] : name;
  const encoded = encodeScopedName(name);
  return `${base}${encoded}/-/${shortName}-${version}.tgz`;
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

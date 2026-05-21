/**
 * tests/_tar.ts
 *
 * Minimal tar-write helper for tests. Creates a valid npm-shaped .tgz
 * (one top-level "package/" directory containing "package.json") from
 * a plain JS object. Uses only Node.js stdlib (zlib + Buffer manipulation).
 *
 * The output is the same shape as what `npm pack` produces.
 */

import { gzip } from "node:zlib";
import { promisify } from "node:util";

const gzipAsync = promisify(gzip);

/**
 * Create a minimal tar entry header block (512 bytes).
 * Only supports regular files (typeflag '0').
 */
function makeTarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512, 0);

  // Name (100 bytes)
  header.write(name, 0, 100, "ascii");

  // Mode (8 bytes) — 0644 in octal
  header.write("0000644\0", 100, 8, "ascii");

  // UID, GID (8 bytes each) — 0
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");

  // Size (12 bytes) — octal
  header.write(size.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");

  // Modification time (12 bytes) — current time in octal
  const mtime = Math.floor(Date.now() / 1000);
  header.write(mtime.toString(8).padStart(11, "0") + "\0", 136, 12, "ascii");

  // Typeflag: '0' = regular file
  header[156] = 48; // '0'

  // Compute checksum (place 8 spaces at offset 148, then sum)
  header.fill(32, 148, 156); // checksum field = spaces
  let checksum = 0;
  for (let i = 0; i < 512; i++) checksum += header[i];
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");

  return header;
}

/** Pad a buffer to the nearest 512-byte boundary. */
function padTo512(buf: Buffer): Buffer {
  const remainder = buf.length % 512;
  if (remainder === 0) return buf;
  const padding = Buffer.alloc(512 - remainder, 0);
  return Buffer.concat([buf, padding]);
}

/** Build a minimal .tgz with the given package.json content. */
export async function buildMinimalTarball(pkg: {
  name: string;
  version: string;
  description?: string;
  main?: string;
  [key: string]: unknown;
}): Promise<Buffer> {
  const pkgJson = JSON.stringify({
    ...pkg,
    name: pkg.name,
    version: pkg.version,
    description: pkg.description ?? "Smoke test fixture",
    main: pkg.main ?? "index.js",
  });
  const pkgJsonBuf = Buffer.from(pkgJson, "utf8");

  // index.js content
  const indexJs = `module.exports = 'pd-index-npm smoke ok';`;
  const indexJsBuf = Buffer.from(indexJs, "utf8");

  // Build tar: two files — package/package.json and package/index.js
  const parts: Buffer[] = [];

  // package/package.json
  parts.push(makeTarHeader("package/package.json", pkgJsonBuf.length));
  parts.push(padTo512(pkgJsonBuf));

  // package/index.js
  parts.push(makeTarHeader("package/index.js", indexJsBuf.length));
  parts.push(padTo512(indexJsBuf));

  // End-of-archive: two zero blocks
  parts.push(Buffer.alloc(1024, 0));

  const tarBuf = Buffer.concat(parts);
  const tgzBuf = await gzipAsync(tarBuf);
  return tgzBuf;
}

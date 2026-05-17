import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { publish, PublishConflictError } from "../scripts/publish.js";
import { buildMinimalTarball } from "./_tar.js";

async function makeRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pd-index-npm-pub-"));
}

/** Start a tiny HTTP server serving static bytes from a map of path->Buffer. */
function startFileServer(
  files: Record<string, Buffer>,
): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const buf = files[req.url ?? ""];
      if (buf) {
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        res.end(buf);
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

test("publish drops the tarball into the right encoded path", async () => {
  const root = await makeRoot();
  const tarballBytes = await buildMinimalTarball({
    name: "@concavetrillion/pd-ui",
    version: "0.1.0-alpha",
  });
  const localTarball = join(root, "_input", "pd-ui-0.1.0-alpha.tgz");
  await mkdir(join(root, "_input"), { recursive: true });
  await writeFile(localTarball, tarballBytes);

  const result = await publish({
    root,
    tarballPath: localTarball,
    baseUrl: "https://concavetrillion.github.io/pd-index-npm/",
  });

  assert.equal(result.packageName, "@concavetrillion/pd-ui");
  assert.equal(result.version, "0.1.0-alpha");

  // Tarball at rest
  const tgzAtRest = await readFile(
    join(root, "@concavetrillion%2fpd-ui", "-", "pd-ui-0.1.0-alpha.tgz"),
  );
  assert.equal(tgzAtRest.byteLength, tarballBytes.byteLength);

  // Packument written
  const packument = JSON.parse(
    await readFile(
      join(root, "@concavetrillion%2fpd-ui", "index.html"),
      "utf8",
    ),
  ) as {
    "dist-tags": Record<string, string>;
    versions: Record<string, unknown>;
  };
  // Only version, so it's both latest and alpha
  assert.equal(packument["dist-tags"].latest, "0.1.0-alpha");
  assert.equal(packument["dist-tags"].alpha, "0.1.0-alpha");
});

test("publish refuses to overwrite an existing version with different bytes", async () => {
  const root = await makeRoot();

  // Publish 0.1.0 the first time
  const tarball1 = await buildMinimalTarball({
    name: "@concavetrillion/pd-ui",
    version: "0.1.0",
    description: "original",
  });
  const f1 = join(root, "_input1", "pd-ui-0.1.0.tgz");
  await mkdir(join(root, "_input1"), { recursive: true });
  await writeFile(f1, tarball1);
  await publish({
    root,
    tarballPath: f1,
    baseUrl: "https://concavetrillion.github.io/pd-index-npm/",
  });

  // Now try to publish a DIFFERENT 0.1.0 tarball
  const tarball2 = await buildMinimalTarball({
    name: "@concavetrillion/pd-ui",
    version: "0.1.0",
    description: "different content",
  });
  const f2 = join(root, "_input2", "pd-ui-0.1.0.tgz");
  await mkdir(join(root, "_input2"), { recursive: true });
  await writeFile(f2, tarball2);

  await assert.rejects(
    () =>
      publish({
        root,
        tarballPath: f2,
        baseUrl: "https://concavetrillion.github.io/pd-index-npm/",
      }),
    (err: unknown) => {
      assert.ok(err instanceof PublishConflictError);
      assert.match((err as Error).message, /0\.1\.0/);
      return true;
    },
  );
});

test("publish accepts a URL for the tarball, downloads it, then publishes", async () => {
  const root = await makeRoot();
  const tarballBytes = await buildMinimalTarball({
    name: "@concavetrillion/test-package",
    version: "0.0.1",
  });

  const { server, baseUrl } = await startFileServer({
    "/test-package-0.0.1.tgz": tarballBytes,
  });

  try {
    const result = await publish({
      root,
      tarballUrl: `${baseUrl}/test-package-0.0.1.tgz`,
      baseUrl: "https://concavetrillion.github.io/pd-index-npm/",
    });

    assert.equal(result.packageName, "@concavetrillion/test-package");
    assert.equal(result.version, "0.0.1");

    const tgzAtRest = await readFile(
      join(
        root,
        "@concavetrillion%2ftest-package",
        "-",
        "test-package-0.0.1.tgz",
      ),
    );
    assert.equal(tgzAtRest.byteLength, tarballBytes.byteLength);
  } finally {
    server.close();
  }
});

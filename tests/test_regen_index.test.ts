import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { regenIndex } from "../scripts/regen-index.js";
import { buildMinimalTarball } from "./_tar.js";

type GithubFixtureReleases = unknown[] | ((page: number) => unknown[]);

async function makeRoot(): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(join(tmpdir(), "pdomain-index-npm-regen-"));
}

function startGithubFixture(
  releases: GithubFixtureReleases,
  files: Record<string, Buffer>,
  repo = "pdomain/pdomain-ui",
): Promise<{
  server: Server;
  baseUrl: string;
  releasePageRequests: string[];
  seenAuthHeaders: string[];
  assetRequests: string[];
}> {
  const releasePageRequests: string[] = [];
  const seenAuthHeaders: string[] = [];
  const assetRequests: string[] = [];

  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = req.url ?? "";
      const auth = req.headers["authorization"];
      if (typeof auth === "string") seenAuthHeaders.push(auth);

      if (url.startsWith(`/repos/${repo}/releases?`)) {
        releasePageRequests.push(url);
        const parsedUrl = new URL(url, "http://fixture.test");
        const page = Number(parsedUrl.searchParams.get("page") ?? "1");
        const responseReleases =
          typeof releases === "function" ? releases(page) : releases;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(responseReleases));
        return;
      }

      const file = files[url];
      if (file) {
        assetRequests.push(url);
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(file.byteLength),
        });
        res.end(file);
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${addr.port}`,
        releasePageRequests,
        seenAuthHeaders,
        assetRequests,
      });
    });
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

test("regenIndex writes packuments that preserve GitHub release asset tarball URLs", async () => {
  const root = await makeRoot();
  const tarball = await buildMinimalTarball({
    name: "@pdomain/pdomain-ui",
    version: "0.3.0",
    dependencies: { "@pdomain/runtime": "^1.0.0" },
    peerDependencies: { react: "^19.0.0" },
    type: "module",
    exports: { ".": "./index.js" },
  });

  const releases: unknown[] = [];
  const { server, baseUrl, releasePageRequests, seenAuthHeaders } =
    await startGithubFixture(releases, {
      "/assets/pdomain-ui-0.3.0.tgz": tarball,
    });
  const assetUrl = `${baseUrl}/assets/pdomain-ui-0.3.0.tgz`;
  releases.push({
    tag_name: "v0.3.0",
    assets: [
      {
        name: "pdomain-ui-0.3.0.tgz",
        browser_download_url: assetUrl,
        updated_at: "2026-05-29T12:00:00.000Z",
      },
    ],
  });

  try {
    const result = await regenIndex({
      root,
      githubApiBaseUrl: baseUrl,
      repos: ["pdomain/pdomain-ui"],
      token: "test-token",
      allowNonGithubAssetHostsForTests: true,
    });

    assert.deepEqual(result.scannedRepos, ["pdomain/pdomain-ui"]);
    assert.deepEqual(result.generated, ["@pdomain/pdomain-ui"]);
    assert.deepEqual(result.published, ["@pdomain/pdomain-ui@0.3.0"]);
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(releasePageRequests, [
      "/repos/pdomain/pdomain-ui/releases?per_page=100&page=1",
    ]);
    assert.deepEqual(seenAuthHeaders, ["Bearer test-token"]);

    const packumentPath = join(root, "@pdomain", "pdomain-ui", "index.html");
    assert.equal(await pathExists(packumentPath), true);
    const packument = JSON.parse(await readFile(packumentPath, "utf8")) as {
      versions: Record<
        string,
        {
          dependencies?: unknown;
          peerDependencies?: unknown;
          type?: unknown;
          exports?: unknown;
          dist: { tarball: string; shasum: string; integrity: string };
        }
      >;
      time: Record<string, string>;
    };
    const version = packument.versions["0.3.0"];
    assert.equal(version.dist.tarball, assetUrl);
    assert.match(version.dist.shasum, /^[0-9a-f]{40}$/);
    assert.match(version.dist.integrity, /^sha512-/);
    assert.deepEqual(version.dependencies, { "@pdomain/runtime": "^1.0.0" });
    assert.deepEqual(version.peerDependencies, { react: "^19.0.0" });
    assert.equal(version.type, "module");
    assert.deepEqual(version.exports, { ".": "./index.js" });
    assert.equal(packument.time["0.3.0"], "2026-05-29T12:00:00.000Z");
    assert.equal(
      await pathExists(join(root, "@pdomain", "pdomain-ui", "-")),
      false,
    );
  } finally {
    server.close();
  }
});

test("regenIndex clears stale output before writing fresh packuments", async () => {
  const root = await makeRoot();
  await mkdir(join(root, "@pdomain", "pdomain-ui", "-"), { recursive: true });
  await writeFile(join(root, "@pdomain", "pdomain-ui", "-", "stale.tgz"), "");
  await mkdir(join(root, "@pdomain", "legacy"), { recursive: true });
  const tarball = await buildMinimalTarball({
    name: "@pdomain/pdomain-ui",
    version: "0.3.1",
  });

  const releases: unknown[] = [];
  const { server, baseUrl } = await startGithubFixture(releases, {
    "/assets/pdomain-ui-0.3.1.tgz": tarball,
  });
  releases.push({
    tag_name: "v0.3.1",
    assets: [
      {
        name: "pdomain-ui-0.3.1.tgz",
        browser_download_url: `${baseUrl}/assets/pdomain-ui-0.3.1.tgz`,
        updated_at: "2026-05-29T12:00:00.000Z",
      },
    ],
  });

  try {
    const result = await regenIndex({
      root,
      githubApiBaseUrl: baseUrl,
      repos: ["pdomain/pdomain-ui"],
      allowNonGithubAssetHostsForTests: true,
    });

    assert.deepEqual(result.generated, ["@pdomain/pdomain-ui"]);
    assert.equal(
      await pathExists(join(root, "@pdomain", "pdomain-ui", "-")),
      false,
    );
    assert.deepEqual(await readdir(join(root, "@pdomain")), ["pdomain-ui"]);
  } finally {
    server.close();
  }
});

test("regenIndex rejects repos without an expected package mapping before fetching assets", async () => {
  const root = await makeRoot();
  const tarball = await buildMinimalTarball({
    name: "../unsafe",
    version: "0.3.0",
  });
  const releases: unknown[] = [];
  const { server, baseUrl, assetRequests } = await startGithubFixture(
    releases,
    {
      "/assets/unsafe-0.3.0.tgz": tarball,
    },
    "example/unsafe",
  );
  releases.push({
    tag_name: "v0.3.0",
    assets: [
      {
        name: "unsafe-0.3.0.tgz",
        browser_download_url: `${baseUrl}/assets/unsafe-0.3.0.tgz`,
        updated_at: "2026-05-29T12:00:00.000Z",
      },
    ],
  });

  try {
    await assert.rejects(
      regenIndex({
        root,
        githubApiBaseUrl: baseUrl,
        repos: ["example/unsafe"],
        allowNonGithubAssetHostsForTests: true,
      }),
      /No expected package configured for example\/unsafe/,
    );
    assert.deepEqual(assetRequests, []);
  } finally {
    server.close();
  }
});

test("regenIndex skips release assets with the wrong package name", async () => {
  const root = await makeRoot();
  const goodTarball = await buildMinimalTarball({
    name: "@pdomain/pdomain-ui",
    version: "0.4.0",
  });
  const legacyTarball = await buildMinimalTarball({
    name: "@concavetrillion/pd-ui",
    version: "0.4.0",
  });

  const releases: unknown[] = [];
  const { server, baseUrl } = await startGithubFixture(releases, {
    "/assets/pdomain-ui-0.4.0.tgz": goodTarball,
    "/assets/pd-ui-0.4.0.tgz": legacyTarball,
  });
  releases.push({
    tag_name: "v0.4.0",
    assets: [
      {
        name: "pdomain-ui-0.4.0.tgz",
        browser_download_url: `${baseUrl}/assets/pdomain-ui-0.4.0.tgz`,
        updated_at: "2026-05-29T12:00:00.000Z",
      },
      {
        name: "pd-ui-0.4.0.tgz",
        browser_download_url: `${baseUrl}/assets/pd-ui-0.4.0.tgz`,
        updated_at: "2026-05-29T12:00:00.000Z",
      },
    ],
  });

  try {
    const result = await regenIndex({
      root,
      githubApiBaseUrl: baseUrl,
      repos: ["pdomain/pdomain-ui"],
      allowNonGithubAssetHostsForTests: true,
    });

    assert.deepEqual(result.published, ["@pdomain/pdomain-ui@0.4.0"]);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0], /@concavetrillion\/pd-ui/);
  } finally {
    server.close();
  }
});

test("regenIndex skips production release asset URLs from a different GitHub repo", async () => {
  const root = await makeRoot();
  const tarball = await buildMinimalTarball({
    name: "@pdomain/pdomain-ui",
    version: "0.4.1",
  });
  const wrongRepoUrl =
    "https://github.com/evil/pdomain-ui/releases/download/v0.4.1/pdomain-ui-0.4.1.tgz";
  const originalFetch = globalThis.fetch;
  const fetchedUrls: string[] = [];

  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    fetchedUrls.push(url);
    if (
      url ===
      "https://fixture.test/repos/pdomain/pdomain-ui/releases?per_page=100&page=1"
    ) {
      return new Response(
        JSON.stringify([
          {
            tag_name: "v0.4.1",
            assets: [
              {
                name: "pdomain-ui-0.4.1.tgz",
                browser_download_url: wrongRepoUrl,
                updated_at: "2026-05-29T12:00:00.000Z",
              },
            ],
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url === wrongRepoUrl) {
      return new Response(new Uint8Array(tarball), {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      });
    }
    return originalFetch(input, init);
  };

  try {
    const result = await regenIndex({
      root,
      githubApiBaseUrl: "https://fixture.test",
      repos: ["pdomain/pdomain-ui"],
    });

    assert.deepEqual(result.generated, []);
    assert.deepEqual(result.published, []);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0], /wrong GitHub release asset repo/);
    assert.match(result.skipped[0], /evil\/pdomain-ui/);
    assert.equal(fetchedUrls.includes(wrongRepoUrl), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("regenIndex fetches release pages until the cap when every page is full", async () => {
  const root = await makeRoot();
  const { server, baseUrl, releasePageRequests } = await startGithubFixture(
    () =>
      Array.from({ length: 100 }, (_, i) => ({
        tag_name: `v0.0.${i}`,
        assets: [],
      })),
    {},
  );

  try {
    const result = await regenIndex({
      root,
      githubApiBaseUrl: baseUrl,
      repos: ["pdomain/pdomain-ui"],
      allowNonGithubAssetHostsForTests: true,
    });

    assert.deepEqual(result.published, []);
    assert.equal(releasePageRequests.length, 10);
    assert.equal(
      releasePageRequests[releasePageRequests.length - 1],
      "/repos/pdomain/pdomain-ui/releases?per_page=100&page=10",
    );
  } finally {
    server.close();
  }
});

test("regenIndex selects stable latest and prerelease dist-tags", async () => {
  const root = await makeRoot();
  const alpha1 = await buildMinimalTarball({
    name: "@pdomain/pdomain-ui",
    version: "0.5.0-alpha.1",
  });
  const alpha2 = await buildMinimalTarball({
    name: "@pdomain/pdomain-ui",
    version: "0.5.0-alpha.2",
  });
  const stable = await buildMinimalTarball({
    name: "@pdomain/pdomain-ui",
    version: "0.5.0",
  });

  const releases: unknown[] = [];
  const { server, baseUrl } = await startGithubFixture(releases, {
    "/assets/pdomain-ui-0.5.0-alpha.1.tgz": alpha1,
    "/assets/pdomain-ui-0.5.0-alpha.2.tgz": alpha2,
    "/assets/pdomain-ui-0.5.0.tgz": stable,
  });
  releases.push({
    tag_name: "v0.5.0",
    assets: [
      {
        name: "pdomain-ui-0.5.0-alpha.1.tgz",
        browser_download_url: `${baseUrl}/assets/pdomain-ui-0.5.0-alpha.1.tgz`,
      },
      {
        name: "pdomain-ui-0.5.0-alpha.2.tgz",
        browser_download_url: `${baseUrl}/assets/pdomain-ui-0.5.0-alpha.2.tgz`,
      },
      {
        name: "pdomain-ui-0.5.0.tgz",
        browser_download_url: `${baseUrl}/assets/pdomain-ui-0.5.0.tgz`,
      },
    ],
  });

  try {
    await regenIndex({
      root,
      githubApiBaseUrl: baseUrl,
      repos: ["pdomain/pdomain-ui"],
      allowNonGithubAssetHostsForTests: true,
    });

    const packument = JSON.parse(
      await readFile(
        join(root, "@pdomain", "pdomain-ui", "index.html"),
        "utf8",
      ),
    ) as { "dist-tags": Record<string, string> };
    assert.equal(packument["dist-tags"].latest, "0.5.0");
    assert.equal(packument["dist-tags"].alpha, "0.5.0-alpha.2");
  } finally {
    server.close();
  }
});

test("regenIndex fails when a downloaded tarball exceeds configured maxTarballBytes", async () => {
  const root = await makeRoot();
  const tarball = await buildMinimalTarball({
    name: "@pdomain/pdomain-ui",
    version: "0.6.0",
  });

  const releases: unknown[] = [];
  const { server, baseUrl } = await startGithubFixture(releases, {
    "/assets/pdomain-ui-0.6.0.tgz": tarball,
  });
  releases.push({
    tag_name: "v0.6.0",
    assets: [
      {
        name: "pdomain-ui-0.6.0.tgz",
        browser_download_url: `${baseUrl}/assets/pdomain-ui-0.6.0.tgz`,
      },
    ],
  });

  try {
    await assert.rejects(
      regenIndex({
        root,
        githubApiBaseUrl: baseUrl,
        repos: ["pdomain/pdomain-ui"],
        maxTarballBytes: tarball.byteLength - 1,
        allowNonGithubAssetHostsForTests: true,
      }),
      /Tarball exceeds maximum size/,
    );
  } finally {
    server.close();
  }
});

test("regenIndex fails when decompressed tarball data exceeds configured maxDecompressedBytes", async () => {
  const root = await makeRoot();
  const tarball = await buildMinimalTarball({
    name: "@pdomain/pdomain-ui",
    version: "0.6.1",
  });

  const releases: unknown[] = [];
  const { server, baseUrl } = await startGithubFixture(releases, {
    "/assets/pdomain-ui-0.6.1.tgz": tarball,
  });
  releases.push({
    tag_name: "v0.6.1",
    assets: [
      {
        name: "pdomain-ui-0.6.1.tgz",
        browser_download_url: `${baseUrl}/assets/pdomain-ui-0.6.1.tgz`,
      },
    ],
  });

  try {
    await assert.rejects(
      regenIndex({
        root,
        githubApiBaseUrl: baseUrl,
        repos: ["pdomain/pdomain-ui"],
        maxDecompressedBytes: 1,
        allowNonGithubAssetHostsForTests: true,
      }),
      /Tarball decompressed data exceeds maximum size/,
    );
  } finally {
    server.close();
  }
});

test("regenIndex fails when package.json exceeds configured maxPackageJsonBytes", async () => {
  const root = await makeRoot();
  const tarball = await buildMinimalTarball({
    name: "@pdomain/pdomain-ui",
    version: "0.6.2",
  });

  const releases: unknown[] = [];
  const { server, baseUrl } = await startGithubFixture(releases, {
    "/assets/pdomain-ui-0.6.2.tgz": tarball,
  });
  releases.push({
    tag_name: "v0.6.2",
    assets: [
      {
        name: "pdomain-ui-0.6.2.tgz",
        browser_download_url: `${baseUrl}/assets/pdomain-ui-0.6.2.tgz`,
      },
    ],
  });

  try {
    await assert.rejects(
      regenIndex({
        root,
        githubApiBaseUrl: baseUrl,
        repos: ["pdomain/pdomain-ui"],
        maxPackageJsonBytes: 1,
        allowNonGithubAssetHostsForTests: true,
      }),
      /Tarball package\.json exceeds maximum size/,
    );
  } finally {
    server.close();
  }
});

test("regenIndex rejects duplicate versions with different shasums", async () => {
  const root = await makeRoot();
  const first = await buildMinimalTarball({
    name: "@pdomain/pdomain-ui",
    version: "0.7.0",
    description: "first build",
  });
  const second = await buildMinimalTarball({
    name: "@pdomain/pdomain-ui",
    version: "0.7.0",
    description: "second build",
  });

  const releases: unknown[] = [];
  const { server, baseUrl } = await startGithubFixture(releases, {
    "/assets/pdomain-ui-0.7.0-a.tgz": first,
    "/assets/pdomain-ui-0.7.0-b.tgz": second,
  });
  releases.push({
    tag_name: "v0.7.0",
    assets: [
      {
        name: "pdomain-ui-0.7.0-a.tgz",
        browser_download_url: `${baseUrl}/assets/pdomain-ui-0.7.0-a.tgz`,
      },
      {
        name: "pdomain-ui-0.7.0-b.tgz",
        browser_download_url: `${baseUrl}/assets/pdomain-ui-0.7.0-b.tgz`,
      },
    ],
  });

  try {
    await assert.rejects(
      regenIndex({
        root,
        githubApiBaseUrl: baseUrl,
        repos: ["pdomain/pdomain-ui"],
        allowNonGithubAssetHostsForTests: true,
      }),
      /already appeared with different content/,
    );
  } finally {
    server.close();
  }
});

test("regenIndex treats duplicate versions with identical shasums as idempotent", async () => {
  const root = await makeRoot();
  const tarball = await buildMinimalTarball({
    name: "@pdomain/pdomain-ui",
    version: "0.7.1",
  });

  const releases: unknown[] = [];
  const { server, baseUrl } = await startGithubFixture(releases, {
    "/assets/pdomain-ui-0.7.1-a.tgz": tarball,
    "/assets/pdomain-ui-0.7.1-b.tgz": tarball,
  });
  releases.push({
    tag_name: "v0.7.1",
    assets: [
      {
        name: "pdomain-ui-0.7.1-a.tgz",
        browser_download_url: `${baseUrl}/assets/pdomain-ui-0.7.1-a.tgz`,
      },
      {
        name: "pdomain-ui-0.7.1-b.tgz",
        browser_download_url: `${baseUrl}/assets/pdomain-ui-0.7.1-b.tgz`,
      },
    ],
  });

  try {
    const result = await regenIndex({
      root,
      githubApiBaseUrl: baseUrl,
      repos: ["pdomain/pdomain-ui"],
      allowNonGithubAssetHostsForTests: true,
    });

    assert.deepEqual(result.published, ["@pdomain/pdomain-ui@0.7.1"]);
    const packument = JSON.parse(
      await readFile(
        join(root, "@pdomain", "pdomain-ui", "index.html"),
        "utf8",
      ),
    ) as { versions: Record<string, unknown> };
    assert.deepEqual(Object.keys(packument.versions), ["0.7.1"]);
  } finally {
    server.close();
  }
});

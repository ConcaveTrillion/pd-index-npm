# npm Release Asset Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Regenerate the static npm registry from allowlisted GitHub Release tarball assets, host only packuments on Pages, and deploy through the official Pages artifact flow.

**Architecture:** Add a new full-regeneration script, `scripts/regen-index.ts`, that treats GitHub Releases as the package byte source and writes `_site/` packuments from scratch. Keep the old publish/rebuild scripts untouched until the generator is covered by tests, then switch workflows, smoke, and docs to the new model.

**Tech Stack:** TypeScript on Node 24, Node test runner, GitHub Actions, GitHub Pages artifact actions.

---

## File Structure

- Create `scripts/regen-index.ts`: full-regeneration CLI and exported `regenIndex()` API. Owns release listing, asset URL validation, tarball download, package metadata extraction, hash computation, dist-tag selection, and `_site/` writing.
- Modify `package.json`: add `regen-index` npm script.
- Modify `Makefile`: add `regen-index` target and include it in `.PHONY`.
- Create `tests/test_regen_index.test.ts`: generator behavior tests with local HTTP fixtures.
- Modify `tests/smoke/run.sh`: require GitHub Release asset URLs in packuments.
- Modify `.github/workflows/sync-releases.yml`: turn it into the artifact-based regeneration deploy workflow.
- Delete `.github/workflows/publish.yml`: remove the gh-pages mutation publish path.
- Modify `README.md`: document release-asset tarballs and artifact deployment.
- Modify `docs/REGISTRY_FORMAT.md`: document packument-only Pages output.
- Modify `docs/conventions/ignored-surfaces.md`: document `_site/` if absent.
- Keep `scripts/publish.ts`, `scripts/rebuild-packuments.ts`, and their old tests unless a later cleanup issue removes them. They stop being workflow entry points in this change.

## Task 1: Add Failing Generator Happy-Path Tests

**Files:**

- Create: `tests/test_regen_index.test.ts`
- Read: `tests/test_sync_releases.test.ts`
- Read: `tests/_tar.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/test_regen_index.test.ts` with this starter content:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { regenIndex } from "../scripts/regen-index.js";
import { buildMinimalTarball } from "./_tar.js";

async function makeRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pdomain-index-npm-regen-"));
}

function startGithubFixture(
  releases: unknown[] | Record<number, unknown[]>,
  files: Record<string, Buffer>,
): Promise<{
  server: Server;
  baseUrl: string;
  releasePageRequests: string[];
  seenAuthHeaders: string[];
}> {
  const releasePages = Array.isArray(releases) ? { 1: releases } : releases;
  const releasePageRequests: string[] = [];
  const seenAuthHeaders: string[] = [];

  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = req.url ?? "";
      const auth = req.headers["authorization"];
      if (typeof auth === "string") seenAuthHeaders.push(auth);

      if (url.startsWith("/repos/pdomain/pdomain-ui/releases?")) {
        releasePageRequests.push(url);
        const requestUrl = new URL(url, "http://fixture.test");
        const page = Number(requestUrl.searchParams.get("page") ?? "1");
        const pageReleases = releasePages[page];
        if (pageReleases === undefined) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(pageReleases));
        return;
      }

      const file = files[url];
      if (file) {
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
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
      });
    });
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

test("regenIndex writes packuments that preserve GitHub release asset tarball URLs", async () => {
  const root = await makeRoot();
  const tarball = await buildMinimalTarball({
    name: "@pdomain/pdomain-ui",
    version: "0.3.0",
    dependencies: { clsx: "^2.0.0" },
    peerDependencies: { react: "^18.0.0" },
    type: "module",
    exports: { ".": "./dist/index.js" },
  });
  const releases: unknown[] = [];
  const { server, baseUrl, releasePageRequests, seenAuthHeaders } =
    await startGithubFixture(releases, {
      "/assets/pdomain-ui-0.3.0.tgz": tarball,
    });
  const tarballUrl = `${baseUrl}/assets/pdomain-ui-0.3.0.tgz`;
  releases.push({
    tag_name: "v0.3.0",
    published_at: "2026-05-29T12:00:00.000Z",
    assets: [
      {
        name: "pdomain-ui-0.3.0.tgz",
        browser_download_url: tarballUrl,
        created_at: "2026-05-29T12:00:00.000Z",
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

    const packument = JSON.parse(
      await readFile(
        join(root, "@pdomain", "pdomain-ui", "index.html"),
        "utf8",
      ),
    ) as {
      name: string;
      "dist-tags": Record<string, string>;
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
    assert.equal(packument.name, "@pdomain/pdomain-ui");
    assert.equal(packument["dist-tags"].latest, "0.3.0");
    assert.equal(version.dist.tarball, tarballUrl);
    assert.match(version.dist.shasum, /^[0-9a-f]{40}$/);
    assert.match(version.dist.integrity, /^sha512-/);
    assert.deepEqual(version.dependencies, { clsx: "^2.0.0" });
    assert.deepEqual(version.peerDependencies, { react: "^18.0.0" });
    assert.equal(version.type, "module");
    assert.deepEqual(version.exports, { ".": "./dist/index.js" });
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
  const staleDir = join(root, "@pdomain", "pdomain-ui", "-");
  await mkdir(staleDir, { recursive: true });
  await writeFile(join(staleDir, "stale.tgz"), "stale");

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
    published_at: "2026-05-30T12:00:00.000Z",
    assets: [
      {
        name: "pdomain-ui-0.3.1.tgz",
        browser_download_url: `${baseUrl}/assets/pdomain-ui-0.3.1.tgz`,
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

    assert.deepEqual(await readdir(join(root, "@pdomain")), ["pdomain-ui"]);
    assert.equal(
      await pathExists(join(root, "@pdomain", "pdomain-ui", "-")),
      false,
    );
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: Run the tests and verify the expected failure**

Run:

```bash
npm test -- --test-name-pattern 'regenIndex'
```

Expected: FAIL during build with a missing module error for
`../scripts/regen-index.js`. If the command runs all tests because the npm
script ignores extra args, the build failure is still the expected RED state.

## Task 2: Implement the First Working Generator Slice

**Files:**

- Create: `scripts/regen-index.ts`
- Modify: `package.json`
- Modify: `Makefile`
- Test: `tests/test_regen_index.test.ts`

- [ ] **Step 1: Add script wiring**

In `package.json`, add this entry next to `sync-releases`:

```json
"regen-index": "npm run build --silent && node dist/scripts/regen-index.js"
```

In `Makefile`, add `regen-index` to `.PHONY` and add this target after
`sync-releases`:

```make
regen-index: ## Regenerate the static registry into ROOT without copying tarballs
	npm run regen-index -- --root "$(ROOT)"
```

- [ ] **Step 2: Write minimal implementation**

Create `scripts/regen-index.ts`. The implementation must include these public
types and constants:

```ts
const DEFAULT_REPOS = ["pdomain/pdomain-ui"] as const;
const DEFAULT_EXPECTED_PACKAGES: Record<string, string> = {
  "pdomain/pdomain-ui": "@pdomain/pdomain-ui",
};
const GITHUB_RELEASES_PER_PAGE = 100;
const MAX_GITHUB_RELEASES = 1000;
const DEFAULT_MAX_TARBALL_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_DECOMPRESSED_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_PACKAGE_JSON_BYTES = 1024 * 1024;

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
```

The minimal implementation must:

- call `rm(root, { recursive: true, force: true })` before writing.
- list release pages exactly as `sync-releases.ts` does today.
- download `.tgz` assets with the compressed-size cap.
- parse `package/package.json` from the tarball.
- compute SHA-1 and SHA-512.
- preserve install metadata keys from `rebuild-packuments.ts`.
- write `@pdomain/pdomain-ui/index.html`.
- never write `@pdomain/pdomain-ui/-/*.tgz`.

Use this exact CLI contract:

```ts
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
      if (result.skipped.length > 0) {
        console.log(`Skipped release assets: ${result.skipped.length}`);
      }
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
```

- [ ] **Step 3: Run the focused tests**

Run:

```bash
npm test -- --test-name-pattern 'regenIndex'
```

Expected: the two `regenIndex` tests pass. Existing tests may also run and
should continue to pass.

- [ ] **Step 4: Commit the first slice**

Run:

```bash
git add scripts/regen-index.ts tests/test_regen_index.test.ts package.json Makefile
git commit -m "feat: add release-asset npm index generator"
```

## Task 3: Add Generator Edge-Case Tests

**Files:**

- Modify: `tests/test_regen_index.test.ts`
- Modify: `scripts/regen-index.ts`

- [ ] **Step 1: Add wrong-package and pagination tests**

Append these tests:

```ts
test("regenIndex skips release assets with the wrong package name", async () => {
  const root = await makeRoot();
  const good = await buildMinimalTarball({
    name: "@pdomain/pdomain-ui",
    version: "0.4.0",
  });
  const legacy = await buildMinimalTarball({
    name: "@concavetrillion/pd-ui",
    version: "0.4.0",
  });
  const releases: unknown[] = [];
  const { server, baseUrl } = await startGithubFixture(releases, {
    "/assets/pdomain-ui-0.4.0.tgz": good,
    "/assets/pd-ui-0.4.0.tgz": legacy,
  });
  releases.push({
    tag_name: "v0.4.0",
    assets: [
      {
        name: "pd-ui-0.4.0.tgz",
        browser_download_url: `${baseUrl}/assets/pd-ui-0.4.0.tgz`,
      },
      {
        name: "pdomain-ui-0.4.0.tgz",
        browser_download_url: `${baseUrl}/assets/pdomain-ui-0.4.0.tgz`,
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

test("regenIndex fetches release pages until a short page and stops at the cap", async () => {
  const root = await makeRoot();
  const fullPage = Array.from({ length: 100 }, (_, index) => ({
    tag_name: `v0.${index}.0`,
    assets: [],
  }));
  const releasesByPage: Record<number, unknown[]> = {};
  for (let page = 1; page <= 10; page++) {
    releasesByPage[page] = fullPage;
  }
  const { server, baseUrl, releasePageRequests } = await startGithubFixture(
    releasesByPage,
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
      releasePageRequests[9],
      "/repos/pdomain/pdomain-ui/releases?per_page=100&page=10",
    );
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: Add dist-tag, size-limit, and duplicate-conflict tests**

Append:

```ts
test("regenIndex selects stable latest and prerelease dist-tags", async () => {
  const root = await makeRoot();
  const versions = ["0.5.0-alpha.1", "0.5.0-alpha.2", "0.5.0"];
  const files: Record<string, Buffer> = {};
  const releases: unknown[] = [];
  const { server, baseUrl } = await startGithubFixture(releases, files);

  for (const version of versions) {
    files[`/assets/pdomain-ui-${version}.tgz`] = await buildMinimalTarball({
      name: "@pdomain/pdomain-ui",
      version,
    });
    releases.push({
      tag_name: `v${version}`,
      assets: [
        {
          name: `pdomain-ui-${version}.tgz`,
          browser_download_url: `${baseUrl}/assets/pdomain-ui-${version}.tgz`,
        },
      ],
    });
  }

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

test("regenIndex fails when a downloaded tarball exceeds the configured cap", async () => {
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
      () =>
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

test("regenIndex rejects duplicate versions with different shasums", async () => {
  const root = await makeRoot();
  const one = await buildMinimalTarball({
    name: "@pdomain/pdomain-ui",
    version: "0.7.0",
    description: "one",
  });
  const two = await buildMinimalTarball({
    name: "@pdomain/pdomain-ui",
    version: "0.7.0",
    description: "two",
  });
  const releases: unknown[] = [];
  const { server, baseUrl } = await startGithubFixture(releases, {
    "/assets/pdomain-ui-0.7.0-one.tgz": one,
    "/assets/pdomain-ui-0.7.0-two.tgz": two,
  });
  releases.push({
    tag_name: "v0.7.0",
    assets: [
      {
        name: "pdomain-ui-0.7.0-one.tgz",
        browser_download_url: `${baseUrl}/assets/pdomain-ui-0.7.0-one.tgz`,
      },
      {
        name: "pdomain-ui-0.7.0-two.tgz",
        browser_download_url: `${baseUrl}/assets/pdomain-ui-0.7.0-two.tgz`,
      },
    ],
  });

  try {
    await assert.rejects(
      () =>
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
```

- [ ] **Step 3: Run tests and verify the expected failures**

Run:

```bash
npm test -- --test-name-pattern 'regenIndex'
```

Expected: at least one new test fails because the generator has not yet handled
all edge cases.

- [ ] **Step 4: Complete the generator behavior**

Update `scripts/regen-index.ts` so it:

- skips wrong package names by recording
  `${asset.browser_download_url} (${actual}; expected ${expected})`.
- fetches exactly ten pages when every page has 100 releases.
- sorts versions with the same `semverCompare()` behavior in
  `rebuild-packuments.ts`.
- computes prerelease dist-tags with the same `prereleaseTag` logic in
  `rebuild-packuments.ts`.
- checks `content-length` before reading a tarball body.
- throws on duplicate `name@version` with different shasums.
- treats duplicate `name@version` with identical shasums as idempotent.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
npm test -- --test-name-pattern 'regenIndex'
npm test
```

Expected: all tests pass.

Commit:

```bash
git add scripts/regen-index.ts tests/test_regen_index.test.ts
git commit -m "test: cover npm index regeneration edge cases"
```

## Task 4: Switch Workflow Deployment to Pages Artifacts

**Files:**

- Modify: `.github/workflows/sync-releases.yml`
- Delete: `.github/workflows/publish.yml`
- Test: `scripts/actionlint.mjs`

- [ ] **Step 1: Replace `sync-releases.yml`**

Replace `.github/workflows/sync-releases.yml` with this shape:

```yaml
name: Regenerate npm index

on:
  schedule:
    - cron: "17 3 * * *"
  workflow_dispatch:
  repository_dispatch:
    types: [pd-npm-publish]

concurrency:
  group: pdomain-index-npm-pages
  cancel-in-progress: false

permissions:
  contents: read

env:
  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: "true"

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout tooling
        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
        with:
          persist-credentials: false

      - name: Setup Node
        uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0
        with:
          node-version: "24"
          cache: "npm"

      - name: Install dependencies
        run: make setup

      - name: Run CI
        run: make ci

      - name: Regenerate index
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: make regen-index ROOT="${{ github.workspace }}/_site"

      - name: Configure Pages
        uses: actions/configure-pages@45bfe0192ca1faeb007ade9deae92b16b8254a0d # v6.0.0

      - name: Upload Pages artifact
        uses: actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9 # v5.0.0
        with:
          path: _site

  deploy:
    needs: build
    runs-on: ubuntu-latest
    permissions:
      pages: write
      id-token: write
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - name: Deploy Pages
        id: deployment
        uses: actions/deploy-pages@cd2ce8fcbc39b97be8ca5fce6e763baed58fa128 # v5.0.0
```

- [ ] **Step 2: Delete `publish.yml`**

Run:

```bash
git rm .github/workflows/publish.yml
```

- [ ] **Step 3: Verify workflow linting**

Run:

```bash
npm run actionlint
```

Expected: no actionlint diagnostics.

- [ ] **Step 4: Confirm no gh-pages push remains**

Run:

```bash
rg -n "gh-pages|git push|contents: write" .github/workflows
```

Expected: no matches for `git push` or `contents: write`. A comment-free
workflow should have no `gh-pages` matches.

- [ ] **Step 5: Commit workflow switch**

Run:

```bash
git add .github/workflows/sync-releases.yml
git commit -m "ci: deploy npm index through pages artifacts"
```

## Task 5: Update Smoke Test for Release Asset Tarballs

**Files:**

- Modify: `tests/smoke/run.sh`

- [ ] **Step 1: Change tarball URL validation**

Replace the existing packument tarball URL assertion:

```bash
echo "$PACKUMENT" | jq -e --arg version "$VERSION" '.versions[$version].dist.tarball | test("^https?://")' >/dev/null
```

with:

```bash
echo "$PACKUMENT" | jq -e --arg version "$VERSION" '.versions[$version].dist.tarball | test("^https://github[.]com/pdomain/pdomain-ui/releases/download/.+[.]tgz$")' >/dev/null
```

Keep the existing fetch, tar listing, and clean `npm install` checks.

- [ ] **Step 2: Run shell and format checks**

Run:

```bash
npm run shell:check
```

Expected: shell syntax passes.

- [ ] **Step 3: Commit smoke update**

Run:

```bash
git add tests/smoke/run.sh
git commit -m "test: require release asset tarballs in npm smoke"
```

## Task 6: Update Documentation and Ignored Surfaces

**Files:**

- Modify: `README.md`
- Modify: `docs/REGISTRY_FORMAT.md`
- Modify: `docs/conventions/ignored-surfaces.md`

- [ ] **Step 1: Update README publishing section**

Replace the paragraph that says the publish workflow writes tarballs to
`gh-pages` with:

```md
Publisher repos create `.tgz` files as GitHub Release assets. The
`pdomain-index-npm` deploy workflow scans allowlisted publisher releases,
validates each package tarball, computes integrity metadata, and regenerates
the static packuments served by GitHub Pages.

GitHub Pages hosts packuments only. New package tarballs are fetched directly
from the publisher repository's GitHub Release assets. Historical Pages-hosted
tarball URLs are not a compatibility promise.
```

- [ ] **Step 2: Update registry layout doc**

Change the directory layout in `docs/REGISTRY_FORMAT.md` so package directories
contain `index.html` only. Add this paragraph under the layout:

```md
Tarball bytes are not stored in the Pages artifact for new versions. The
packument's `dist.tarball` field points at the publisher repository's GitHub
Release asset URL, and npm downloads the tarball from GitHub Releases.
```

Update the example `dist.tarball` value to:

```json
"tarball": "https://github.com/pdomain/pdomain-ui/releases/download/v0.1.0-alpha/pdomain-ui-0.1.0-alpha.tgz"
```

- [ ] **Step 3: Document `_site/` if needed**

If `docs/conventions/ignored-surfaces.md` does not mention `_site/`, add:

```md
- `_site/` is generated by `make regen-index` and uploaded as the GitHub Pages
  artifact. Do not hand-edit it or commit it.
```

- [ ] **Step 4: Run documentation format check**

Run:

```bash
npx prettier --check README.md docs/REGISTRY_FORMAT.md docs/conventions/ignored-surfaces.md
```

Expected: all three files use Prettier formatting.

- [ ] **Step 5: Commit docs**

Run:

```bash
git add README.md docs/REGISTRY_FORMAT.md docs/conventions/ignored-surfaces.md
git commit -m "docs: describe release-asset npm registry format"
```

## Task 7: Full Static Verification

**Files:**

- Read: `package.json`
- Read: `.github/workflows/sync-releases.yml`
- Generated only: temporary output directory from `mktemp -d`

- [ ] **Step 1: Run full CI**

Run:

```bash
make ci
```

Expected: static checks and all tests pass.

- [ ] **Step 2: Regenerate locally**

Run:

```bash
OUT="$(mktemp -d)"
make regen-index ROOT="$OUT"
find "$OUT" -maxdepth 5 -type f | sort
find "$OUT" -name '*.tgz' -print
node -e 'const fs=require("fs"); const p=process.argv[1]; const doc=JSON.parse(fs.readFileSync(p, "utf8")); console.log(doc.name); console.log(doc["dist-tags"]); console.log(Object.keys(doc.versions).slice(-3)); console.log(doc.versions[Object.keys(doc.versions).at(-1)].dist.tarball)' "$OUT/@pdomain/pdomain-ui/index.html"
```

Expected:

- file listing includes `@pdomain/pdomain-ui/index.html`.
- `.tgz` search prints nothing.
- node inspection prints `@pdomain/pdomain-ui`.
- inspected `dist.tarball` starts with
  `https://github.com/pdomain/pdomain-ui/releases/download/`.

- [ ] **Step 3: Confirm workflow permissions and no gh-pages mutation**

Run:

```bash
rg -n "contents: write|git push|gh-pages" .github/workflows || true
rg -n "pages: write|id-token: write" .github/workflows/sync-releases.yml
```

Expected:

- first command prints no matches.
- second command prints the deploy job permissions.

- [ ] **Step 4: Commit any verification-only fixes**

If verification required fixes, commit them with the narrowest matching message:

```bash
git status --short
git add <fixed files>
git commit -m "fix: complete npm release asset registry switch"
```

If no fixes were needed, do not create a commit.

## Task 8: Post-Deploy Live Smoke

**Files:**

- Read: `tests/smoke/run.sh`

- [ ] **Step 1: Run live smoke after the Pages deployment completes**

Run:

```bash
make smoke
```

Expected:

- packument fetch succeeds from `https://pdomain.github.io/pdomain-index-npm/`.
- `dist.tarball` is a GitHub Release asset URL.
- tarball fetch succeeds.
- clean `npm install @pdomain/pdomain-ui@<version>` succeeds.

- [ ] **Step 2: Record outcome in final summary**

In the final handoff, include:

- local `make ci` result.
- local regeneration output path used for inspection.
- whether `.tgz` files were absent from generated output.
- whether live smoke ran, and the result.
- confirmation that no workflow pushes `gh-pages`.

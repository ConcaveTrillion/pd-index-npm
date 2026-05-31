# npm Release Asset Registry Design

> Archived historical design. The implemented registry format is maintained in
> [`docs/REGISTRY_FORMAT.md`](../../REGISTRY_FORMAT.md). Legacy publish,
> rebuild, and sync scripts referenced by the migration were removed after the
> release-asset registry shipped.

## Context

`pdomain-index-npm` is a static npm registry for the `@pdomain/*` scope. It
currently copies package tarballs into the `gh-pages` branch and writes
packuments whose `dist.tarball` fields point back at GitHub Pages.

That makes the Pages branch both a generated registry index and a tarball store.
The new model keeps GitHub Pages as the packument host only. Package tarballs
come directly from allowlisted GitHub Release assets.

Historical `https://pdomain.github.io/pdomain-index-npm/.../*.tgz` tarball URLs
do not need to keep working. The migration may stop publishing those bytes and
may remove them from newly generated Pages artifacts.

## Goals

- Generate the complete static registry output deterministically into `_site/`.
- Keep packument JSON hosted on GitHub Pages.
- Point every new `dist.tarball` value at the original GitHub Release asset URL.
- Stop copying `.tgz` bytes into generated registry output.
- Deploy Pages through the official artifact flow rather than mutating
  `gh-pages`.
- Keep the first implementation simple: every trigger runs full regeneration.
- Preserve the current release-source allowlist, initially
  `pdomain/pdomain-ui` -> `@pdomain/pdomain-ui`.

## Non-Goals

- Preserve old lockfile tarball URLs under the Pages domain.
- Add incremental regeneration for a single touched repository.
- Add more publisher repositories in this change.
- Implement a writable npm registry or npm publish endpoint.

## Registry Model

GitHub Releases are the source of package bytes. For each allowlisted publisher
repository, the generator lists release assets, downloads each `.tgz`, validates
its package metadata, computes npm integrity metadata, and writes the package
packument into `_site/`.

The generated Pages artifact contains:

```text
_site/
  @pdomain/
    pdomain-ui/
      index.html
```

It does not contain:

```text
_site/
  @pdomain/
    pdomain-ui/
      -/
        pdomain-ui-<version>.tgz
```

Packument version objects keep the install-relevant fields copied from the
tarball's `package/package.json`, including dependency, peer dependency,
engine, export, type, binary, platform, funding, and install-script metadata.

Each version's `dist` object uses hashes computed from the downloaded tarball
bytes:

```json
{
  "dist": {
    "tarball": "https://github.com/pdomain/pdomain-ui/releases/download/v0.3.0/pdomain-ui-0.3.0.tgz",
    "shasum": "<sha1 hex>",
    "integrity": "sha512-<base64>"
  }
}
```

The `tarball` field preserves the GitHub Release asset URL from the release API.

## Generator

Replace the append-style publish/sync behavior with a full-regeneration script,
exposed as `regen-index`.

The generator accepts:

- `--root <dir>`: output directory, defaulting to `_site`.
- `--github-api-base-url <url>`: test seam for GitHub API fixtures.
- repeated `--repo <owner/repo>`: optional override for allowlisted repos.
- `GH_TOKEN` or `GITHUB_TOKEN`: optional API token for GitHub release listing.

Default configuration:

```ts
const DEFAULT_REPOS = ["pdomain/pdomain-ui"] as const;
const DEFAULT_EXPECTED_PACKAGES = {
  "pdomain/pdomain-ui": "@pdomain/pdomain-ui",
};
```

For each repository, the generator:

1. Lists releases through `GET /repos/{owner}/{repo}/releases` with
   `per_page=100`.
2. Stops after a short page or after 1000 releases.
3. Reads only assets whose names end in `.tgz`.
4. Requires each asset URL to be a GitHub Release asset URL for the same
   allowlisted repo.
5. Downloads each tarball with the existing compressed, decompressed, and
   package-json size limits.
6. Extracts `package/package.json`.
7. Requires `name` to match the configured expected package for the repo.
8. Requires a non-empty `version`.
9. Computes `shasum` and `integrity`.
10. Adds the version to the in-memory package model.
11. Skips wrong-package legacy assets and records them in the result.

If the same `name@version` appears more than once:

- identical shasums are idempotent and collapse to one version entry.
- differing shasums fail regeneration because npm versions are immutable.

The script writes output from scratch into the selected root. It should remove
or recreate the root before writing so stale packuments and tarball directories
cannot survive from older runs.

## Packument Semantics

Version ordering keeps the existing no-dependency semver comparator.

Dist-tags keep the existing conventions:

- `latest`: highest non-prerelease version.
- `latest` fallback: highest prerelease when no stable version exists.
- prerelease tag names such as `alpha`: highest version whose prerelease
  identifier starts with that tag.

`time.created` and per-version `time[version]` can be derived from release or
asset metadata when the GitHub API provides it. If a fixture or asset omits a
usable timestamp, the generator may use the current run time. Tests should not
depend on exact wall-clock values except for shape and parseability.

## Workflow Changes

Replace gh-pages mutation with Pages artifact deployment.

The deploy workflow keeps these triggers:

- daily cron
- `workflow_dispatch`
- publisher `repository_dispatch`

The recommended first pass is one workflow that runs full regeneration for all
triggers. `repository_dispatch` may still validate a supplied
`client_payload.tarball_url`, but it should not publish that single tarball
directly. It exists as a fast signal to regenerate immediately.

Workflow permissions:

- build/test/regeneration jobs use `contents: read`.
- deploy job uses only `pages: write` and `id-token: write`.
- no job needs `contents: write` for registry deployment.

The workflow uses pinned full action SHAs with the existing version comments for:

- `actions/checkout`
- `actions/setup-node`
- `actions/configure-pages`
- `actions/upload-pages-artifact`
- `actions/deploy-pages`

The old `publish.yml` branch-push path should be removed or changed so no
workflow commits or pushes to `gh-pages`.

## Smoke Test

The smoke test remains live against
`https://pdomain.github.io/pdomain-index-npm/`.

It validates:

- the packument exists on Pages.
- the requested package/version exists in the packument.
- `dist.tarball` is a GitHub Release asset URL under the allowlisted publisher
  repository.
- the tarball URL is fetchable and contains `package/package.json`.
- a clean `npm install @pdomain/pdomain-ui@<version>` works through the static
  registry.

## Static Tests

Add or update tests for:

- generated packument shape.
- preservation of GitHub Release asset URLs in `dist.tarball`.
- package-name allowlist enforcement.
- legacy or wrong package assets being skipped.
- release pagination through the 1000-release cap.
- dist-tag selection for stable and prerelease versions.
- compressed tarball size-limit failure.
- decompressed tarball size-limit failure.
- package-json size-limit failure.
- duplicate same-version conflict on different shasums.
- absence of generated `@scope/name/-/*.tgz` files.

Narrow or remove tests whose only assertion is that tarballs are written under
`@scope/name/-/`.

## Documentation

Update `README.md` and `docs/REGISTRY_FORMAT.md` to state:

- Pages hosts packuments.
- GitHub Releases host tarballs.
- new generated output does not contain tarball bytes.
- historical Pages tarball URLs are not a compatibility promise.

Update ignored/generated-surface docs if `_site/` is not already covered.

## Verification

Before merging implementation:

1. Run `make ci`.
2. Run regeneration into a temporary output directory.
3. Inspect the generated `@pdomain/pdomain-ui/index.html` packument.
4. Confirm no generated `.tgz` files exist in the output directory.
5. Confirm no workflow pushes `gh-pages`.
6. Confirm Actions permissions are minimal.
7. After deployment, run the live smoke test.

## Commit Shape

Use two implementation commits:

1. Add the release-asset generator and tests while old workflows remain in
   place.
2. Switch workflows, docs, smoke, and generated-output assumptions to Pages
   artifact deployment.

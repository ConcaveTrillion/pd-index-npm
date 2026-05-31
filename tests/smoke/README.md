# Smoke Test

The `run.sh` script is the end-to-end integration test for `pdomain-index-npm`. It
proves that `npm install` can resolve a `@pdomain/*` package from the
static registry exactly as it would from npmjs.org.

## What the smoke proves

1. The packument JSON is live at the expected URL and has the correct shape
   (`name`, `dist-tags`, `versions[].dist.tarball`).
2. The tarball the packument points at is a valid gzipped tar containing
   `package/package.json` — i.e., the npm wire format.
3. A fresh directory with only the `.npmrc` registry override can `npm install`
   the package, and the installed `package.json` has the expected name/version.

This is the only test that exercises the full round-trip (GitHub Pages HTTP
→ npm CLI → installed package metadata).

## Preconditions

The package under test must have at least one version published to the index.
By default, the smoke checks `@pdomain/pdomain-ui@latest`.

## How to run locally

```sh
bash tests/smoke/run.sh
```

Expected output ends with `SMOKE PASSED`. Exit code is 0 on success, non-zero
on any step failure.

You can override the registry URL for local testing against a different
deployment:

```sh
REGISTRY=http://localhost:8000/ bash tests/smoke/run.sh
```

You can also pin the version to check a specific `@pdomain/pdomain-ui` release
asset:

```sh
VERSION=0.2.2 bash tests/smoke/run.sh
```

## Troubleshooting

| Symptom                            | Likely cause                                                                | Fix                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `curl` 404 on packument URL        | Pages artifact deployment has not served the regenerated index yet          | Check the index regeneration workflow and Pages deployment status    |
| `curl` 404 on tarball URL          | GitHub Release asset is missing or private                                  | Check the publisher repository release assets                        |
| `npm install` fails with 404       | Packument's `dist.tarball` URL is not the expected GitHub Release asset URL | Regenerate the index from the publisher repository releases          |
| Installed package metadata differs | Packument points at the wrong release asset or stale content                | Regenerate the index and verify the publisher release asset contents |
| Smoke flakes in CI                 | Pages lag exceeded the polling window                                       | Increase the poll attempts/backoff in the smoke job                  |

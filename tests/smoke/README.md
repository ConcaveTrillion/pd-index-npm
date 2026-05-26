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
   the package, and `require()`-ing the result returns the expected value.

This is the only test that exercises the full round-trip (GitHub Pages HTTP
→ npm CLI → Node.js `require()`).

## Preconditions

The `@pdomain/test-package@0.0.1` package must already be published to
the index. This happens automatically when the `publish.yml` workflow runs with
the smoke-test fixture tarball (the Task 5 manual trigger), and subsequently in
CI after every publish.

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

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `curl` 404 on packument URL | Pages not yet serving the package | Wait 60-120s after a publish; check `gh-pages` branch has the files |
| `curl` 404 on tarball URL | Tarball missing from `gh-pages` | Re-run the publish workflow |
| `npm install` fails with 404 | Packument's `dist.tarball` URL wrong | Check `baseUrl` in the publish workflow env var |
| `require()` returns wrong string | `index.js` in the test package was changed | Rebuild and re-publish the smoke fixture |
| Smoke flakes in CI | Pages lag > 90s | Increase the `sleep` in `publish.yml`'s smoke job |

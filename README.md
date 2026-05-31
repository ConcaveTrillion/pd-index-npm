# pdomain-index-npm

Self-hosted [npm registry](https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md)
for the `@pdomain/*` scope, served as a static site from GitHub
Pages. The npm sibling of the existing [`pdomain-index-pip`](https://github.com/pdomain/pdomain-index-pip)
Python package index.

## URL

```
https://pdomain.github.io/pdomain-index-npm/
```

## How consumers use it

Add to your project's `.npmrc`:

```
@pdomain:registry=https://pdomain.github.io/pdomain-index-npm/
```

Then:

```sh
npm install @pdomain/pdomain-ui
```

Resolves through the static registry. Every other package continues to
resolve from npmjs.org. The registry is **read-only and unauthenticated**
— no token, no `npm login` required.

## How publishers push to it

Publisher repos create `.tgz` files as GitHub Release assets. The
`pdomain-index-npm` deploy workflow scans allowlisted publisher releases,
validates each package tarball, computes integrity metadata, and regenerates
the static packuments served by GitHub Pages.

GitHub Pages hosts packuments only. New package tarballs are fetched directly
from the publisher repository's GitHub Release assets. Historical Pages-hosted
tarball URLs are not a compatibility promise.

Publisher repos can trigger a `repository_dispatch` of type `pd-npm-publish`
after creating a release asset to signal immediate regeneration:

```sh
gh api repos/pdomain/pdomain-index-npm/dispatches \
  -f event_type=pd-npm-publish \
  -f client_payload[tarball_url]="https://github.com/pdomain/pdomain-ui/releases/download/v0.1.0-alpha/pdomain-ui-0.1.0-alpha.tgz"
```

The dispatch path is the fast path. A daily GitHub Actions sync also scans
publisher GitHub Releases for `.tgz` assets and regenerates the registry
idempotently, so the registry catches up if a publisher dispatch is missed.

## Versioning conventions

- Semver throughout.
- Pre-1.0 incubation: `0.X.Y-alpha[.N]`. The `alpha` dist-tag tracks the
  latest prerelease; `latest` only advances when a non-prerelease is
  published.
- Versions are immutable. Republishing the same `name@version` with
  different tarball bytes is rejected by `scripts/publish.ts`.

## Layout

See [docs/REGISTRY_FORMAT.md](docs/REGISTRY_FORMAT.md) for the on-disk
shape and the parts of the npm registry HTTP API we serve.

## Why not just publish to npmjs.org?

Same answer as the pip side. The index speaks the same wire protocol
npmjs does, so migration later is `npm publish` + dropping the `.npmrc`
line. No package-shape changes required.

The `@pdomain/*` packages already follow habits to keep that door
open:

- Plain semver version strings (no npm-specific metadata in the version).
- Release versions are immutable (same `name@version` with different bytes
  is rejected).
- Tarball names follow the `<name>-<version>.tgz` convention npm itself uses.

# Registry Format

This document describes the on-disk layout of the `pd-index-npm` static registry
(the shape of the `gh-pages` branch) and the parts of the npm registry HTTP API
we serve.

## Directory layout

```
/                                          # GitHub Pages root
  index.html                               # Human-readable landing page
  @concavetrillion%2fpd-ui/               # Package directory (scope + name, URL-encoded)
    index.html                             # Packument JSON (served at /@concavetrillion%2fpd-ui)
    -/                                     # Tarball directory
      pd-ui-0.1.0-alpha.tgz
      pd-ui-0.1.1-alpha.tgz
  @concavetrillion%2ftest-package/
    index.html                             # Packument JSON
    -/
      test-package-0.0.1.tgz
```

### URL encoding

Scoped package names (`@scope/name`) encode the `/` as `%2f` (lowercase). This
matches what the npm CLI sends in its GET requests. The `encodeScopedName()`
function in `scripts/registry-layout.ts` enforces this encoding.

### Packument files

The packument (the JSON document npm GETs when resolving a package) is stored as
`index.html` inside each package directory. GitHub Pages redirects `GET
/@concavetrillion%2fpd-ui` to `/@concavetrillion%2fpd-ui/` and then serves the
`index.html`. The npm CLI follows the redirect and parses the body as JSON
(Content-Type is not checked).

## Packument JSON shape

```json
{
  "name": "@concavetrillion/pd-ui",
  "dist-tags": {
    "latest": "0.1.1-alpha",
    "alpha": "0.1.1-alpha"
  },
  "versions": {
    "0.1.0-alpha": {
      "name": "@concavetrillion/pd-ui",
      "version": "0.1.0-alpha",
      "description": "...",
      "main": "dist/index.js",
      "dist": {
        "tarball": "https://concavetrillion.github.io/pd-index-npm/@concavetrillion%2fpd-ui/-/pd-ui-0.1.0-alpha.tgz",
        "shasum": "<sha1 hex, 40 chars>",
        "integrity": "sha512-<base64>"
      }
    },
    "0.1.1-alpha": { "...": "..." }
  },
  "time": {
    "created":  "2026-05-17T00:00:00.000Z",
    "modified": "2026-05-18T00:00:00.000Z",
    "0.1.0-alpha": "2026-05-17T00:00:00.000Z",
    "0.1.1-alpha": "2026-05-18T00:00:00.000Z"
  }
}
```

The `dist.tarball` URL is **absolute** so `npm install` doesn't have to know the
registry's base path twice.

## Upstream references

- [npm registry HTTP API spec](https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md)
- [Verdaccio static-publish](https://verdaccio.org/docs/configuration/#static-publish)
  is the closest existing reference implementation; our layout mirrors Verdaccio's
  `storage/` directory shape.

## Intentional simplifications

- **No `_attachments`**: Tarballs are served as static files (not embedded as base64
  in the packument). This is the standard for static registries.
- **No `_rev`**: We don't implement npm's revision-tracking; the publish workflow
  owns all mutations to `gh-pages`.
- **No PUT semantics**: The registry is read-only from the consumer's perspective.
  Publishers trigger the `publish.yml` workflow which is the only writer.
- **No `npm login`**: The registry is unauthenticated. All packages are public.

## Trust model

Tarballs are submitted to the publish workflow as URLs. The `scripts/publish.ts`
script downloads the tarball, computes SHA-1 (`shasum`) and SHA-512 (`integrity`)
hashes, and writes both into the packument. Publishers never compute hashes
themselves — the publish script is the single source of truth for integrity data.

## dist-tags conventions

- `latest`: the highest semver non-prerelease version. Falls back to the highest
  prerelease if no stable versions exist yet.
- Per-prerelease-tag (e.g. `alpha`): the highest version whose prerelease identifier
  starts with that tag (e.g. `0.1.0-alpha.2` for tag `alpha`).

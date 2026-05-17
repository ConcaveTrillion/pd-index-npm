# Registry Format

This document describes the on-disk layout of the `pd-index-npm` static registry
(the shape of the `gh-pages` branch) and the parts of the npm registry HTTP API
we serve.

## Directory layout

```
/                                          # GitHub Pages root
  index.html                               # Human-readable landing page
  @concavetrillion/                        # Scope directory
    pd-ui/                                 # Package directory
      index.html                           # Packument JSON
      -/                                   # Tarball directory
        pd-ui-0.1.0-alpha.tgz
        pd-ui-0.1.1-alpha.tgz
    test-package/
      index.html                           # Packument JSON
      -/
        test-package-0.0.1.tgz
```

### Why real slashes (not `%2f`)

The npm protocol uses URL-encoded scoped names: `GET /@concavetrillion%2fpd-ui`.
GitHub Pages decodes `%2f` to a real `/` when matching paths, so a request for
`/@concavetrillion%2fpd-ui/` is served from the directory
`@concavetrillion/pd-ui/` on the `gh-pages` branch. This is the standard
approach for GitHub Pages-hosted static npm registries.

### Packument files

The packument (the JSON document npm GETs when resolving a package) is stored as
`index.html` inside each package directory. GitHub Pages redirects `GET
/@concavetrillion%2fpd-ui` → `/@concavetrillion/pd-ui/` and serves
`@concavetrillion/pd-ui/index.html`. npm follows the redirect and parses the
body as JSON (Content-Type is not checked against the body).

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
        "tarball": "https://concavetrillion.github.io/pd-index-npm/@concavetrillion/pd-ui/-/pd-ui-0.1.0-alpha.tgz",
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

The `dist.tarball` URL uses the real slash form (not `%2f`) since GitHub Pages
serves files by their actual on-disk path.

## Upstream references

- [npm registry HTTP API spec](https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md)
- [Verdaccio static-publish](https://verdaccio.org/docs/configuration/#static-publish)
  is the closest existing reference implementation.

## Intentional simplifications

- **No `_attachments`**: Tarballs are served as static files (not embedded as base64
  in the packument).
- **No `_rev`**: The publish workflow owns all mutations to `gh-pages`.
- **No PUT semantics**: The registry is read-only from the consumer's perspective.
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

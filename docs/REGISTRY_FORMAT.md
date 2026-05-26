# Registry Format

This document describes the on-disk layout of the `pdomain-index-npm` static registry
(the shape of the `gh-pages` branch) and the parts of the npm registry HTTP API
we serve.

## Directory layout

```
/                                          # GitHub Pages root
  index.html                               # Human-readable landing page
  @pdomain/                        # Scope directory
    pdomain-ui/                                 # Package directory
      index.html                           # Packument JSON
      -/                                   # Tarball directory
        pdomain-ui-0.1.0-alpha.tgz
        pdomain-ui-0.1.1-alpha.tgz
    test-package/
      index.html                           # Packument JSON
      -/
        test-package-0.0.1.tgz
```

### Why real slashes (not `%2f`)

The npm protocol uses URL-encoded scoped names: `GET /@concavetrillion%2fpdomain-ui`.
GitHub Pages decodes `%2f` to a real `/` when matching paths, so a request for
`/@concavetrillion%2fpdomain-ui/` is served from the directory
`@pdomain/pdomain-ui/` on the `gh-pages` branch. This is the standard
approach for GitHub Pages-hosted static npm registries.

### Packument files

The packument (the JSON document npm GETs when resolving a package) is stored as
`index.html` inside each package directory. GitHub Pages redirects `GET
/@concavetrillion%2fpdomain-ui` → `/@pdomain/pdomain-ui/` and serves
`@pdomain/pdomain-ui/index.html`. npm follows the redirect and parses the
body as JSON (Content-Type is not checked against the body).

## Packument JSON shape

```json
{
  "name": "@pdomain/pdomain-ui",
  "dist-tags": {
    "latest": "0.1.1-alpha",
    "alpha": "0.1.1-alpha"
  },
  "versions": {
    "0.1.0-alpha": {
      "name": "@pdomain/pdomain-ui",
      "version": "0.1.0-alpha",
      "description": "...",
      "main": "dist/index.js",
      "dependencies": { "konva": "^9.0.0", "...": "..." },
      "peerDependencies": { "react": "^18.0.0", "react-dom": "^18.0.0" },
      "engines": { "node": ">=20" },
      "type": "module",
      "exports": { ".": { "...": "..." } },
      "dist": {
        "tarball": "https://concavetrillion.github.io/pdomain-index-npm/@pdomain/pdomain-ui/-/pdomain-ui-0.1.0-alpha.tgz",
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

Each version object also carries the install-relevant fields copied verbatim
from the tarball's `package.json` — `dependencies`, `peerDependencies`,
`peerDependenciesMeta`, `optionalDependencies`, `bundleDependencies`,
`engines`, `exports`, `imports`, `type`, `bin`, `os`, `cpu`, `sideEffects`,
`funding`, `deprecated`, `hasInstallScript`. Without these, a package manager
reading the packument cannot resolve the transitive dependency tree.

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

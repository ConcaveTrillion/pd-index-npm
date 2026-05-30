import { publish, UnexpectedPackageNameError } from "./publish.js";

const DEFAULT_REPOS = ["pdomain/pdomain-ui"] as const;
const DEFAULT_EXPECTED_PACKAGES: Record<string, string> = {
  "pdomain/pdomain-ui": "@pdomain/pdomain-ui",
};

interface GithubReleaseAsset {
  name?: unknown;
  browser_download_url?: unknown;
}

interface GithubRelease {
  assets?: GithubReleaseAsset[];
}

export interface SyncPublishedReleasesOptions {
  root: string;
  baseUrl: string;
  githubApiBaseUrl?: string;
  repos?: string[];
  token?: string;
}

export interface SyncPublishedReleasesResult {
  scannedRepos: string[];
  published: string[];
  skipped: string[];
}

async function listReleases(
  githubApiBaseUrl: string,
  repo: string,
  token?: string,
): Promise<GithubRelease[]> {
  const apiBase = githubApiBaseUrl.replace(/\/$/, "");
  const response = await fetch(
    `${apiBase}/repos/${repo}/releases?per_page=100`,
    {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    },
  );

  if (!response.ok) {
    throw new Error(
      `Failed to list releases for ${repo}: HTTP ${response.status}`,
    );
  }

  return (await response.json()) as GithubRelease[];
}

function releaseTarballUrls(releases: GithubRelease[]): string[] {
  const urls: string[] = [];
  for (const release of releases) {
    for (const asset of release.assets ?? []) {
      const name = typeof asset.name === "string" ? asset.name : "";
      const url =
        typeof asset.browser_download_url === "string"
          ? asset.browser_download_url
          : "";
      if (name.endsWith(".tgz") && url) urls.push(url);
    }
  }
  return urls;
}

export async function syncPublishedReleases(
  opts: SyncPublishedReleasesOptions,
): Promise<SyncPublishedReleasesResult> {
  const githubApiBaseUrl = opts.githubApiBaseUrl ?? "https://api.github.com";
  const repos = opts.repos ?? [...DEFAULT_REPOS];
  const published: string[] = [];
  const skipped: string[] = [];

  for (const repo of repos) {
    const releases = await listReleases(githubApiBaseUrl, repo, opts.token);
    for (const tarballUrl of releaseTarballUrls(releases)) {
      try {
        const result = await publish({
          root: opts.root,
          baseUrl: opts.baseUrl,
          tarballUrl,
          expectedPackageName: DEFAULT_EXPECTED_PACKAGES[repo],
        });
        published.push(`${result.packageName}@${result.version}`);
      } catch (err) {
        if (err instanceof UnexpectedPackageNameError) {
          const message = `${tarballUrl} (${err.actualPackageName}; expected ${err.expectedPackageName})`;
          skipped.push(message);
          console.warn(
            `Skipping release asset with unexpected package name: ${message}`,
          );
          continue;
        }
        throw err;
      }
    }
  }

  return { scannedRepos: repos, published, skipped };
}

function repeatedArgs(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1]) values.push(args[i + 1]);
  }
  return values;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const idx = (flag: string) => args.indexOf(flag);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      "Usage: sync-releases.js [--root <dir>] [--base-url <url>] " +
        "[--github-api-base-url <url>] [--repo <owner/repo>]...",
    );
    process.exit(0);
  }

  const root = idx("--root") >= 0 ? args[idx("--root") + 1] : process.cwd();
  const baseUrl =
    idx("--base-url") >= 0
      ? args[idx("--base-url") + 1]
      : "https://pdomain.github.io/pdomain-index-npm/";
  const githubApiBaseUrl =
    idx("--github-api-base-url") >= 0
      ? args[idx("--github-api-base-url") + 1]
      : "https://api.github.com";
  const repos = repeatedArgs(args, "--repo");
  const token = process.env["GH_TOKEN"] ?? process.env["GITHUB_TOKEN"];

  syncPublishedReleases({
    root,
    baseUrl,
    githubApiBaseUrl,
    repos: repos.length > 0 ? repos : undefined,
    token,
  })
    .then((result) => {
      console.log(`Scanned repos: ${result.scannedRepos.join(", ")}`);
      if (result.published.length === 0) {
        console.log("No npm release tarballs found.");
      } else {
        console.log(`Synced packages: ${result.published.join(", ")}`);
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

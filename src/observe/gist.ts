/**
 * Publish observed.md to a secret GitHub gist.
 *
 * Secret gists are unlisted, not private: anyone with the raw URL can read.
 * Acceptable tradeoff for an unguessable URL; revoke by deleting the gist.
 *
 * Auth: GITHUB_TOKEN or GH_TOKEN env var with the "gist" scope.
 */

const API = "https://api.github.com";
const FILENAME = "observed.md";

export interface GistResult {
  id: string;
  htmlUrl: string;
  rawUrl: string;
  created: boolean;
}

function ghToken(): string {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) {
    throw new Error(
      "GITHUB_TOKEN (or GH_TOKEN) is not set. Create a token with the 'gist' scope at " +
        "https://github.com/settings/tokens and export it."
    );
  }
  return token;
}

async function gh(method: string, path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${ghToken()}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`GitHub API ${res.status} on ${method} ${path}: ${detail.slice(0, 300)}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

function extractRawUrl(gist: Record<string, unknown>): string {
  const files = gist.files as Record<string, { raw_url?: string }> | undefined;
  return files?.[FILENAME]?.raw_url ?? "";
}

/** Update the gist if id given; otherwise create a new secret gist. */
export async function publishGist(content: string, gistId?: string): Promise<GistResult> {
  if (gistId) {
    const gist = await gh("PATCH", `/gists/${gistId}`, {
      files: { [FILENAME]: { content } },
    });
    return {
      id: gistId,
      htmlUrl: String(gist.html_url ?? ""),
      rawUrl: extractRawUrl(gist),
      created: false,
    };
  }
  const gist = await gh("POST", "/gists", {
    description: "ynab-agent observed.md (auto-generated)",
    public: false,
    files: { [FILENAME]: { content } },
  });
  return {
    id: String(gist.id ?? ""),
    htmlUrl: String(gist.html_url ?? ""),
    rawUrl: extractRawUrl(gist),
    created: true,
  };
}

/**
 * Stable raw URL (without commit SHA) — always serves the latest revision:
 * https://gist.githubusercontent.com/<user>/<id>/raw/observed.md
 */
export function stableRawUrl(htmlUrl: string): string {
  // htmlUrl: https://gist.github.com/<user>/<id>
  const m = htmlUrl.match(/gist\.github\.com\/([^/]+)\/([a-f0-9]+)/);
  if (!m) return "";
  return `https://gist.githubusercontent.com/${m[1]}/${m[2]}/raw/${FILENAME}`;
}

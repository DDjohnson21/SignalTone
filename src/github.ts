/**
 * GitHub REST API integration.
 * Creates repos, branches, files, issues, and pull requests.
 * Requires GITHUB_TOKEN in env.
 */

const BASE = "https://api.github.com";

function headers(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
    "User-Agent": "SignalTone/1.0",
  };
}

export function hasGitHubToken(): boolean {
  return Boolean(process.env.GITHUB_TOKEN);
}

async function ghFetch(path: string, options: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, { ...options, headers: headers() });
  if (res.status === 204) return null;
  const body = await res.text();
  if (!res.ok) throw new Error(`GitHub ${res.status} on ${path}: ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GitHubRepo {
  html_url: string;
  full_name: string;
  default_branch: string;
}

// ─── Repository ───────────────────────────────────────────────────────────────

export async function createRepository(
  name: string,
  description: string,
  isPrivate = false
): Promise<GitHubRepo> {
  return ghFetch("/user/repos", {
    method: "POST",
    body: JSON.stringify({
      name,
      description,
      private: isPrivate,
      auto_init: false,
      has_issues: true,
    }),
  }) as Promise<GitHubRepo>;
}

/** Adds a .gitkeep commit to establish the default branch on an empty repo. */
export async function initializeRepo(fullName: string): Promise<void> {
  await ghFetch(`/repos/${fullName}/contents/.gitkeep`, {
    method: "PUT",
    body: JSON.stringify({
      message: "chore: initialize repository",
      content: Buffer.from("").toString("base64"),
    }),
  });
}

// ─── Branches ─────────────────────────────────────────────────────────────────

export async function getDefaultBranchSha(
  fullName: string,
  branch: string
): Promise<string> {
  const data = (await ghFetch(
    `/repos/${fullName}/git/ref/heads/${branch}`
  )) as { object: { sha: string } };
  return data.object.sha;
}

export async function createBranch(
  fullName: string,
  branchName: string,
  fromSha: string
): Promise<void> {
  await ghFetch(`/repos/${fullName}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: fromSha }),
  });
}

// ─── Files ───────────────────────────────────────────────────────────────────

export async function createOrUpdateFile(
  fullName: string,
  filePath: string,
  message: string,
  content: string,
  branch: string
): Promise<void> {
  const payload: Record<string, unknown> = {
    message,
    content: Buffer.from(content).toString("base64"),
    branch,
  };

  // If the file already exists, its SHA is required to update it.
  try {
    const existing = (await ghFetch(
      `/repos/${fullName}/contents/${filePath}?ref=${branch}`
    )) as { sha: string };
    payload.sha = existing.sha;
  } catch {
    // File doesn't exist yet — creating fresh, no sha needed.
  }

  await ghFetch(`/repos/${fullName}/contents/${filePath}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

// ─── Issues ───────────────────────────────────────────────────────────────────

export async function createIssue(
  fullName: string,
  title: string,
  body: string,
  labels: string[] = []
): Promise<{ number: number; html_url: string }> {
  return ghFetch(`/repos/${fullName}/issues`, {
    method: "POST",
    body: JSON.stringify({ title, body, labels }),
  }) as Promise<{ number: number; html_url: string }>;
}

// ─── Pull Requests ────────────────────────────────────────────────────────────

export async function createPullRequest(
  fullName: string,
  title: string,
  body: string,
  head: string,
  base: string,
  draft = true
): Promise<{ number: number; html_url: string }> {
  return ghFetch(`/repos/${fullName}/pulls`, {
    method: "POST",
    body: JSON.stringify({ title, body, head, base, draft }),
  }) as Promise<{ number: number; html_url: string }>;
}

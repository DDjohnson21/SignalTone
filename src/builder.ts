/**
 * Build orchestrator.
 * Takes a CommitteeOutput and turns it into a real GitHub repo:
 *   - creates the repo
 *   - generates starter files via LLM
 *   - commits files to a scaffold branch
 *   - seeds GitHub issues
 *   - opens a draft PR
 */

import { callChat } from "./llm.js";
import type { CommitteeOutput } from "./committee.js";
import {
  createRepository,
  initializeRepo,
  getDefaultBranchSha,
  createBranch,
  createOrUpdateFile,
  createIssue,
  createPullRequest,
} from "./github.js";
import { saveRepository, saveBuildRun } from "./db.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BuildResult {
  repoUrl: string;
  repoFullName: string;
  prUrl: string | null;
  issueCount: number;
}

interface ScaffoldFiles {
  readme: string;
  entry_path: string;
  entry_file: string;
  package_json: string;
  gitignore: string;
  issues: Array<{ title: string; body: string }>;
}

// ─── Scaffold generation ──────────────────────────────────────────────────────

const SCAFFOLD_SYSTEM = `You are a senior TypeScript engineer scaffolding a minimal, useful open-source project.
Output ONLY a valid JSON object — no markdown fences, no commentary before or after.

{
  "readme": "full README.md content in markdown",
  "entry_path": "src/index.ts",
  "entry_file": "// TypeScript — real skeleton with imports, stubs, and TODO comments",
  "package_json": "{ complete valid package.json as a string }",
  "gitignore": "node_modules/\\ndist/\\n.env\\n",
  "issues": [
    { "title": "...", "body": "..." }
  ]
}

Rules:
- README: # project name, one-liner tagline, ## Install, ## Usage, ## Contributing
- entry_file: real TypeScript — not hello world. Imports, typed interfaces, main function skeleton, TODOs
- package_json: name matches repo name, bun start/dev/test scripts, realistic devDependencies
- issues: exactly 4 — core feature implementation, add tests, set up CI, improve documentation
- This is a scaffold, not a finished product — keep it tight and directional`;

async function generateScaffold(o: CommitteeOutput): Promise<ScaffoldFiles | null> {
  const prompt = `Repo: ${o.first_repo.name}
Goal: ${o.first_repo.goal}
Description: ${o.first_repo.description}
Stack: ${o.first_repo.tech_stack.join(", ")}
Type: ${o.project_type}
Context: ${o.signal} — ${o.best_use_case}

Generate the scaffold JSON.`;

  try {
    const raw = await callChat(SCAFFOLD_SYSTEM, prompt, 4096);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in scaffold response");
    return JSON.parse(jsonMatch[0]) as ScaffoldFiles;
  } catch (err) {
    console.error("[Builder] Scaffold generation error:", err);
    return null;
  }
}

function sanitizeRepoName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100);
}

// ─── Main export ─────────────────────────────────────────────────────────────

export async function buildOpportunity(
  phoneId: string,
  opportunity: CommitteeOutput,
  opportunityDbId: number | null = null
): Promise<BuildResult> {
  const repoName = sanitizeRepoName(opportunity.first_repo.name);
  const scaffoldBranch = "feature/initial-scaffold";

  // 1. Create the GitHub repo (uninitialized)
  const repo = await createRepository(repoName, opportunity.first_repo.description);
  console.log(`[Builder] Created repo: ${repo.full_name}`);

  // 2. Add a first commit to establish the default branch
  await initializeRepo(repo.full_name);

  // 3. Get the default branch SHA so we can branch from it
  const mainSha = await getDefaultBranchSha(repo.full_name, repo.default_branch);

  // 4. Create the scaffold branch
  await createBranch(repo.full_name, scaffoldBranch, mainSha);
  console.log(`[Builder] Created branch: ${scaffoldBranch}`);

  // 5. Generate file contents via LLM
  const scaffold = await generateScaffold(opportunity);
  let prUrl: string | null = null;
  let issueCount = 0;

  if (scaffold) {
    const filesToCommit = [
      { path: "README.md",          content: scaffold.readme,       message: "docs: add README" },
      { path: scaffold.entry_path,  content: scaffold.entry_file,   message: "feat: add entry file skeleton" },
      { path: "package.json",       content: scaffold.package_json, message: "chore: add package.json" },
      { path: ".gitignore",         content: scaffold.gitignore,    message: "chore: add .gitignore" },
    ];

    for (const file of filesToCommit) {
      try {
        await createOrUpdateFile(
          repo.full_name,
          file.path,
          file.message,
          file.content,
          scaffoldBranch
        );
      } catch (err) {
        console.error(`[Builder] Failed to commit ${file.path}:`, err);
      }
    }
    console.log(`[Builder] Committed scaffold files to ${scaffoldBranch}`);

    // 6. Seed issues
    for (const issue of (scaffold.issues ?? []).slice(0, 5)) {
      try {
        await createIssue(repo.full_name, issue.title, issue.body);
        issueCount++;
      } catch (err) {
        console.error("[Builder] Failed to create issue:", err);
      }
    }
    console.log(`[Builder] Seeded ${issueCount} issues`);

    // 7. Open draft PR
    try {
      const pr = await createPullRequest(
        repo.full_name,
        `feat: initial scaffold — ${opportunity.first_repo.goal}`,
        [
          `## What`,
          opportunity.first_repo.description,
          ``,
          `## Signal`,
          opportunity.signal,
          ``,
          `## Why now`,
          opportunity.why_now,
          ``,
          `## Risk`,
          opportunity.risk,
          ``,
          `*Generated by [SignalTone](https://github.com/DDjohnson21/SignalTone)*`,
        ].join("\n"),
        scaffoldBranch,
        repo.default_branch
      );
      prUrl = pr.html_url;
      console.log(`[Builder] Draft PR: ${prUrl}`);
    } catch (err) {
      console.error("[Builder] PR creation failed:", err);
    }
  }

  // 8. Persist to DB
  const dbRepoId = saveRepository(
    phoneId,
    opportunityDbId,
    repoName,
    repo.html_url,
    repo.full_name
  );

  saveBuildRun(
    dbRepoId,
    "initial_scaffold",
    `${repoName} — ${issueCount} issues seeded`,
    undefined,
    prUrl ?? undefined,
    scaffold ? "complete" : "partial"
  );

  return {
    repoUrl: repo.html_url,
    repoFullName: repo.full_name,
    prUrl,
    issueCount,
  };
}

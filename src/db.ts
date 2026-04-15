import { Database } from "bun:sqlite";
import path from "path";

const DB_PATH = path.join(import.meta.dir, "..", "signaltone.db");

const db = new Database(DB_PATH);

// WAL mode for better read/write concurrency
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA foreign_keys = ON");

// Initialize schema per Section 9.1
db.run(`
  CREATE TABLE IF NOT EXISTS users (
    phone_id       TEXT PRIMARY KEY,
    topics         TEXT DEFAULT '[]',
    skill_level    TEXT DEFAULT 'intermediate',
    response_style TEXT DEFAULT 'brief',
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_active    DATETIME
  )
`);
db.run(`
  CREATE TABLE IF NOT EXISTS conversations (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    phone_id       TEXT REFERENCES users(phone_id),
    role           TEXT,
    content        TEXT,
    intent         TEXT,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);
db.run(`
  CREATE TABLE IF NOT EXISTS saved_ideas (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    phone_id       TEXT REFERENCES users(phone_id),
    idea_text      TEXT,
    source_update  TEXT,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);
db.run(`
  CREATE TABLE IF NOT EXISTS sent_updates (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    phone_id       TEXT REFERENCES users(phone_id),
    source_url     TEXT,
    topic          TEXT,
    sent_at        DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

try {
  db.run("ALTER TABLE users ADD COLUMN topic_affinity TEXT DEFAULT '{}'");
} catch {
  // Column already exists — ignore
}

try {
  db.run("ALTER TABLE users ADD COLUMN build_preferences TEXT DEFAULT NULL");
} catch {
  // Column already exists — ignore
}

db.run(`
  CREATE TABLE IF NOT EXISTS briefing_log (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    phone_id       TEXT REFERENCES users(phone_id),
    briefing_type  TEXT,
    sent_at        DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS opportunities (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    phone_id          TEXT REFERENCES users(phone_id),
    signal            TEXT,
    why_now           TEXT,
    best_use_case     TEXT,
    project_type      TEXT,
    verdict           TEXT,
    risk              TEXT,
    repo_name         TEXT,
    repo_goal         TEXT,
    editor_reply      TEXT,
    status            TEXT DEFAULT 'identified',
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS repositories (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    phone_id        TEXT REFERENCES users(phone_id),
    opportunity_id  INTEGER REFERENCES opportunities(id),
    repo_name       TEXT,
    repo_url        TEXT,
    full_name       TEXT,
    default_branch  TEXT DEFAULT 'main',
    status          TEXT DEFAULT 'draft',
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS build_runs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    repository_id INTEGER REFERENCES repositories(id),
    run_type      TEXT,
    summary       TEXT,
    commit_sha    TEXT,
    pr_url        TEXT,
    status        TEXT,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UserProfile {
  phone_id: string;
  topics: string[];
  skill_level: string;
  response_style: string;
  created_at: string;
  last_active: string | null;
}

export interface ConversationTurn {
  id: number;
  phone_id: string;
  role: string;
  content: string;
  intent: string | null;
  created_at: string;
}

export interface SavedIdea {
  id: number;
  phone_id: string;
  idea_text: string;
  source_update: string | null;
  created_at: string;
}

export interface Opportunity {
  id: number;
  phone_id: string;
  signal: string;
  why_now: string;
  best_use_case: string;
  project_type: string;
  verdict: string;
  risk: string;
  repo_name: string | null;
  repo_goal: string | null;
  editor_reply: string;
  status: string;
  created_at: string;
}

export interface Repository {
  id: number;
  phone_id: string;
  opportunity_id: number | null;
  repo_name: string;
  repo_url: string;
  full_name: string;
  default_branch: string;
  status: string;
  created_at: string;
}

export interface BuildRun {
  id: number;
  repository_id: number;
  run_type: string;
  summary: string;
  commit_sha: string | null;
  pr_url: string | null;
  status: string;
  created_at: string;
}

// ─── Row shape from SQLite (topics stored as JSON string) ─────────────────────

interface UserRow {
  phone_id: string;
  topics: string;
  skill_level: string;
  response_style: string;
  created_at: string;
  last_active: string | null;
}

function rowToProfile(row: UserRow): UserProfile {
  return {
    ...row,
    topics: (() => {
      try {
        return JSON.parse(row.topics) as string[];
      } catch {
        return [];
      }
    })(),
  };
}

// ─── Prepared statements ──────────────────────────────────────────────────────

const stmts = {
  getUser:               db.prepare("SELECT * FROM users WHERE phone_id = $phoneId"),
  insertUser:            db.prepare("INSERT OR IGNORE INTO users (phone_id) VALUES ($phoneId)"),
  updateLastActive:      db.prepare("UPDATE users SET last_active = CURRENT_TIMESTAMP WHERE phone_id = $phoneId"),
  updateTopics:          db.prepare("UPDATE users SET topics = $topics WHERE phone_id = $phoneId"),
  updateSkillLevel:      db.prepare("UPDATE users SET skill_level = $val WHERE phone_id = $phoneId"),
  updateResponseStyle:   db.prepare("UPDATE users SET response_style = $val WHERE phone_id = $phoneId"),
  insertConversation:    db.prepare("INSERT INTO conversations (phone_id, role, content, intent) VALUES ($phoneId, $role, $content, $intent)"),
  getRecentConvo:        db.prepare("SELECT * FROM conversations WHERE phone_id = $phoneId ORDER BY created_at DESC LIMIT $limit"),
  insertSavedIdea:       db.prepare("INSERT INTO saved_ideas (phone_id, idea_text, source_update) VALUES ($phoneId, $ideaText, $sourceUpdate)"),
  getSavedIdeas:         db.prepare("SELECT * FROM saved_ideas WHERE phone_id = $phoneId ORDER BY created_at DESC"),
  logSentUpdate:         db.prepare("INSERT INTO sent_updates (phone_id, source_url, topic) VALUES ($phoneId, $sourceUrl, $topic)"),
  getRecentSentUrlsStmt: db.prepare("SELECT source_url FROM sent_updates WHERE phone_id = $phoneId AND sent_at > datetime('now', $interval)"),
  getAllUserIdsStmt:      db.prepare("SELECT phone_id FROM users"),
  getTopicAffinityStmt:  db.prepare("SELECT topic_affinity FROM users WHERE phone_id = $phoneId"),
  bumpTopicAffinityStmt: db.prepare("UPDATE users SET topic_affinity = $aff WHERE phone_id = $phoneId"),
  alreadySentTodayStmt:  db.prepare("SELECT 1 FROM briefing_log WHERE phone_id = $phoneId AND briefing_type = $type AND date(sent_at) = date('now')"),
  recordBriefingStmt:    db.prepare("INSERT INTO briefing_log (phone_id, briefing_type) VALUES ($phoneId, $type)"),

  // Opportunities
  insertOpportunity:     db.prepare(`
    INSERT INTO opportunities (phone_id, signal, why_now, best_use_case, project_type, verdict, risk, repo_name, repo_goal, editor_reply)
    VALUES ($phoneId, $signal, $whyNow, $bestUseCase, $projectType, $verdict, $risk, $repoName, $repoGoal, $editorReply)
  `),
  getLastOpportunity:    db.prepare("SELECT * FROM opportunities WHERE phone_id = $phoneId ORDER BY created_at DESC LIMIT 1"),
  getOpportunities:      db.prepare("SELECT * FROM opportunities WHERE phone_id = $phoneId ORDER BY created_at DESC LIMIT $limit"),

  // Repositories
  insertRepository:      db.prepare(`
    INSERT INTO repositories (phone_id, opportunity_id, repo_name, repo_url, full_name)
    VALUES ($phoneId, $opportunityId, $repoName, $repoUrl, $fullName)
  `),
  getRepositories:       db.prepare("SELECT * FROM repositories WHERE phone_id = $phoneId ORDER BY created_at DESC"),

  // Build runs
  insertBuildRun:        db.prepare(`
    INSERT INTO build_runs (repository_id, run_type, summary, commit_sha, pr_url, status)
    VALUES ($repositoryId, $runType, $summary, $commitSha, $prUrl, $status)
  `),
};

// ─── API ─────────────────────────────────────────────────────────────────────

export function getOrCreateUser(phoneId: string): UserProfile {
  stmts.insertUser.run({ $phoneId: phoneId });
  const row = stmts.getUser.get({ $phoneId: phoneId }) as UserRow | null;
  if (!row) throw new Error(`Failed to get/create user: ${phoneId}`);
  return rowToProfile(row);
}

/** Check if this is a new user (no conversation history yet). */
export function isNewUser(phoneId: string): boolean {
  const row = stmts.getRecentConvo.get({ $phoneId: phoneId, $limit: 1 }) as ConversationTurn | null;
  return row === null;
}

export function updateUserLastActive(phoneId: string): void {
  stmts.updateLastActive.run({ $phoneId: phoneId });
}

export interface UserProfileUpdates {
  topics?: string[];
  skill_level?: string;
  response_style?: string;
}

export function updateUserProfile(phoneId: string, updates: UserProfileUpdates): void {
  if (updates.topics !== undefined) {
    stmts.updateTopics.run({ $topics: JSON.stringify(updates.topics), $phoneId: phoneId });
  }
  if (updates.skill_level !== undefined) {
    stmts.updateSkillLevel.run({ $val: updates.skill_level, $phoneId: phoneId });
  }
  if (updates.response_style !== undefined) {
    stmts.updateResponseStyle.run({ $val: updates.response_style, $phoneId: phoneId });
  }
}

export function addConversationTurn(
  phoneId: string,
  role: "user" | "agent",
  content: string,
  intent?: string
): void {
  stmts.insertConversation.run({ $phoneId: phoneId, $role: role, $content: content, $intent: intent ?? null });
}

export function getRecentConversation(phoneId: string, limit = 5): ConversationTurn[] {
  const rows = stmts.getRecentConvo.all({ $phoneId: phoneId, $limit: limit }) as ConversationTurn[];
  return rows.reverse();
}

export function saveIdea(phoneId: string, ideaText: string, sourceUpdate?: string): void {
  stmts.insertSavedIdea.run({ $phoneId: phoneId, $ideaText: ideaText, $sourceUpdate: sourceUpdate ?? null });
}

export function getSavedIdeas(phoneId: string): SavedIdea[] {
  return stmts.getSavedIdeas.all({ $phoneId: phoneId }) as SavedIdea[];
}

export function logSentUpdate(phoneId: string, sourceUrl: string, topic?: string): void {
  stmts.logSentUpdate.run({ $phoneId: phoneId, $sourceUrl: sourceUrl, $topic: topic ?? null });
}

export function getRecentSentUrls(phoneId: string, hours = 48): Set<string> {
  const interval = `-${hours} hours`;
  const rows = stmts.getRecentSentUrlsStmt.all({ $phoneId: phoneId, $interval: interval }) as Array<{ source_url: string }>;
  return new Set(rows.map((r) => r.source_url));
}

export function getRecentSentTopics(phoneId: string, hours = 48): Map<string, number> {
  const interval = `-${hours} hours`;
  const rows = stmts.getRecentSentUrlsStmt.all({ $phoneId: phoneId, $interval: interval }) as Array<{ source_url: string; topic: string | null }>;
  const topicCounts = new Map<string, number>();
  for (const row of rows) {
    if (row.topic) {
      const key = row.topic.toLowerCase();
      topicCounts.set(key, (topicCounts.get(key) ?? 0) + 1);
    }
  }
  return topicCounts;
}

export function getAllUserIds(): string[] {
  const rows = stmts.getAllUserIdsStmt.all() as Array<{ phone_id: string }>;
  return rows.map((r) => r.phone_id);
}

export function getTopicAffinity(phoneId: string): Record<string, number> {
  const row = stmts.getTopicAffinityStmt.get({ $phoneId: phoneId }) as { topic_affinity: string } | null;
  if (!row) return {};
  try {
    return JSON.parse(row.topic_affinity) as Record<string, number>;
  } catch {
    return {};
  }
}

export function bumpTopicAffinity(phoneId: string, topic: string): void {
  const current = getTopicAffinity(phoneId);
  const key = topic.toLowerCase();
  current[key] = (current[key] ?? 0) + 1;
  stmts.bumpTopicAffinityStmt.run({ $aff: JSON.stringify(current), $phoneId: phoneId });
}

export function alreadySentToday(phoneId: string, type: "morning" | "evening"): boolean {
  const row = stmts.alreadySentTodayStmt.get({ $phoneId: phoneId, $type: type });
  return row !== null && row !== undefined;
}

export function recordBriefingLog(phoneId: string, type: "morning" | "evening"): void {
  stmts.recordBriefingStmt.run({ $phoneId: phoneId, $type: type });
}

// ─── Opportunities ────────────────────────────────────────────────────────────

export function saveOpportunity(
  phoneId: string,
  o: Pick<Opportunity, "signal" | "why_now" | "best_use_case" | "project_type" | "verdict" | "risk" | "repo_name" | "repo_goal" | "editor_reply">
): number {
  const res = stmts.insertOpportunity.run({
    $phoneId: phoneId,
    $signal: o.signal,
    $whyNow: o.why_now,
    $bestUseCase: o.best_use_case,
    $projectType: o.project_type,
    $verdict: o.verdict,
    $risk: o.risk,
    $repoName: o.repo_name ?? null,
    $repoGoal: o.repo_goal ?? null,
    $editorReply: o.editor_reply,
  });
  return res.lastInsertRowid as number;
}

export function getLastOpportunity(phoneId: string): Opportunity | null {
  return stmts.getLastOpportunity.get({ $phoneId: phoneId }) as Opportunity | null;
}

export function getOpportunities(phoneId: string, limit = 10): Opportunity[] {
  return stmts.getOpportunities.all({ $phoneId: phoneId, $limit: limit }) as Opportunity[];
}

// ─── Repositories ─────────────────────────────────────────────────────────────

export function saveRepository(
  phoneId: string,
  opportunityId: number | null,
  repoName: string,
  repoUrl: string,
  fullName: string
): number {
  const res = stmts.insertRepository.run({
    $phoneId: phoneId,
    $opportunityId: opportunityId,
    $repoName: repoName,
    $repoUrl: repoUrl,
    $fullName: fullName,
  });
  return res.lastInsertRowid as number;
}

export function getRepositories(phoneId: string): Repository[] {
  return stmts.getRepositories.all({ $phoneId: phoneId }) as Repository[];
}

// ─── Build runs ───────────────────────────────────────────────────────────────

export function saveBuildRun(
  repositoryId: number,
  runType: string,
  summary: string,
  commitSha?: string,
  prUrl?: string,
  status = "complete"
): void {
  stmts.insertBuildRun.run({
    $repositoryId: repositoryId,
    $runType: runType,
    $summary: summary,
    $commitSha: commitSha ?? null,
    $prUrl: prUrl ?? null,
    $status: status,
  });
}

export { db };

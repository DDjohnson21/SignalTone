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
  getUser:             db.prepare("SELECT * FROM users WHERE phone_id = $phoneId"),
  insertUser:          db.prepare("INSERT OR IGNORE INTO users (phone_id) VALUES ($phoneId)"),
  updateLastActive:    db.prepare("UPDATE users SET last_active = CURRENT_TIMESTAMP WHERE phone_id = $phoneId"),
  updateTopics:        db.prepare("UPDATE users SET topics = $topics WHERE phone_id = $phoneId"),
  updateSkillLevel:    db.prepare("UPDATE users SET skill_level = $val WHERE phone_id = $phoneId"),
  updateResponseStyle: db.prepare("UPDATE users SET response_style = $val WHERE phone_id = $phoneId"),
  insertConversation:  db.prepare("INSERT INTO conversations (phone_id, role, content, intent) VALUES ($phoneId, $role, $content, $intent)"),
  getRecentConvo:      db.prepare("SELECT * FROM conversations WHERE phone_id = $phoneId ORDER BY created_at DESC LIMIT $limit"),
  insertSavedIdea:     db.prepare("INSERT INTO saved_ideas (phone_id, idea_text, source_update) VALUES ($phoneId, $ideaText, $sourceUpdate)"),
  getSavedIdeas:       db.prepare("SELECT * FROM saved_ideas WHERE phone_id = $phoneId ORDER BY created_at DESC"),
  logSentUpdate:       db.prepare("INSERT INTO sent_updates (phone_id, source_url, topic) VALUES ($phoneId, $sourceUrl, $topic)"),
};

// ─── API ─────────────────────────────────────────────────────────────────────

export function getOrCreateUser(phoneId: string): UserProfile {
  stmts.insertUser.run({ $phoneId: phoneId });
  const row = stmts.getUser.get({ $phoneId: phoneId }) as UserRow | null;
  if (!row) throw new Error(`Failed to get/create user: ${phoneId}`);
  return rowToProfile(row);
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

export { db };

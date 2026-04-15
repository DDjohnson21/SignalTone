# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun install          # install dependencies
bun start            # run the agent (production)
bun dev              # run with auto-reload on file changes
```

There is no build step — Bun runs TypeScript directly. There is no test suite.

**PRs:** Always use the GitHub CLI (`gh pr create`). Commit first if needed.

## Environment

Copy `.env.example` to `.env` and fill in keys before running:

- `ANTHROPIC_API_KEY` — required if `LLM_PROVIDER=anthropic` (default)
- `OPENAI_API_KEY` — required if `LLM_PROVIDER=openai`
- `GITHUB_TOKEN` — optional; raises GitHub API rate limit from 60 → 5000 req/hr
- `DEBUG=true` — verbose SDK and watcher logs
- `LLM_PROVIDER` — `"anthropic"` (default) or `"openai"`
- `ANTHROPIC_MODEL` — default `claude-opus-4-6`
- `OPENAI_MODEL` — default `gpt-4o`

**macOS requirement:** The Photon SDK needs Full Disk Access granted to the terminal app. Messages must be sent from a different Apple ID/device than the Mac running the agent — the agent filters out its own outgoing messages.

## Architecture

SignalTone is a single-process macOS daemon. The data flow is:

```
iMessage (Photon SDK) → Intent Classification → Source Fetching + Re-ranking
                                                          ↓
                                               LLM Response Generation
                                                          ↓
                                           iMessage reply + SQLite persistence
```

### Key modules

| File | Responsibility |
|------|---------------|
| `src/index.ts` | Entry point. Starts the Photon watcher, runs the per-message pipeline, manages concurrency guards and self-echo filtering. Also boots the scheduler. |
| `src/intent.ts` | Classifies each incoming message into one of 14 intents via a structured LLM call. Falls back to keyword heuristics if the LLM call fails. |
| `src/committee.ts` | Opportunity Committee — multi-step reasoning pipeline (Scout → Skeptic → Builder → Market → Coder → Editor). Returns a `CommitteeOutput` with verdict, repo spec, and iMessage reply. |
| `src/github.ts` | GitHub REST API integration. Creates repos, branches, files (base64), issues, and draft PRs. Requires `GITHUB_TOKEN`. |
| `src/builder.ts` | Build orchestrator. Takes a `CommitteeOutput`, creates the GitHub repo, generates scaffold files via LLM, seeds issues, opens a draft PR, and persists to DB. |
| `src/sources.ts` | Fetches from HN, GitHub Trending, ArXiv, RSS feeds, and Product Hunt. 30-minute in-memory cache shared across all users. Scores and re-ranks items by recency decay + user topic affinity. |
| `src/response.ts` | Builds per-intent system/user prompts and calls `callChat()`. Exports `stripUrls()` used across the codebase. |
| `src/llm.ts` | Provider abstraction over Anthropic and OpenAI. Exposes `callStructured()` (JSON schema output, used for intent) and `callChat()` (streaming, used for responses). |
| `src/db.ts` | All SQLite logic. Tables: `users`, `conversations`, `saved_ideas`, `sent_updates`, `briefing_log`, `opportunities`, `repositories`, `build_runs`. |
| `src/scheduler.ts` | Polls every 60 seconds. Sends morning briefings at 8:00am and evening summaries at 9:00pm to every known user. Uses `briefing_log` to prevent double-sends across restarts. |

### Concurrency and state

- `/tmp/signaltone.lock` — single-process guard; process exits if lock is held
- `inProgress` Set — per-sender mutex to prevent overlapping message handling
- `processedMessages` Set — deduplicates by `(timestamp + text)`, 5-minute TTL
- `agentSent` Set — filters the agent's own outgoing messages, 30-second TTL

### Intent types

`daily_briefing`, `evening_summary`, `topic_query`, `build_idea`, `follow_up`, `preference_update`, `save`, `recall`, `reminder`, `onboarding`, `opportunity_query`, `build_this`, `refine_build`, `repo_status`

The `opportunity_query` → `build_this` pair is the core build flow: the committee runs on `opportunity_query` and saves a DB record; `build_this` reuses that record (if < 30 min old) and kicks off an async build without blocking the response.

The structured JSON schema for intent classification is defined in `src/intent.ts`. All fields are required but nullable.

### SQLite schema (`signaltone.db`)

- `users` — phone ID, topics (JSON array), skill_level, response_style, topic_affinity (JSON object), build_preferences
- `conversations` — full turn-by-turn history tagged with intent
- `saved_ideas` — bookmarked agent responses (first 600 chars)
- `sent_updates` — per-user URL dedup window (48 hours)
- `briefing_log` — prevents same-day duplicate morning/evening sends
- `opportunities` — committee output per user (verdict, repo spec, editor reply)
- `repositories` — GitHub repos created, with `repo_url` and `full_name`
- `build_runs` — per-repo build activity (commit SHA, PR URL, status)

Schema is created on startup via `CREATE TABLE IF NOT EXISTS`. New columns are added via `ALTER TABLE ... ADD COLUMN` inside try/catch blocks. No migrations file.

### Source ranking

Each item is scored by:
1. **Recency decay** — exponential with 12-hour half-life
2. **Novelty penalty** — URLs seen by this user in the last 48h lose 15% per prior occurrence (capped at 80%)
3. **Source score** — HN native score, GitHub star count, ArXiv fixed 120, RSS fixed 70, Product Hunt vote count

Topic filtering uses a `TOPIC_KEYWORDS` map with alias expansion (e.g. `"llm"` → `ai`, `"swift"` → `mobile`).

### Response generation rules

- No URLs or bare domains in the response text (iMessage link previews are separate bubbles)
- Plain text only — no Markdown, no bullet headers
- Max ~200 words unless the user requests depth
- Sources are referenced by name ("Hacker News", "GitHub"), never by URL

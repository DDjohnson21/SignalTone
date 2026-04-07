# SignalTone — Technical PRD

## 1. Overview

SignalTone is an iMessage-native agent built on Photon's [@photon-ai/imessage-kit](https://github.com/photon-hq/imessage-kit) that delivers opinionated, builder-focused tech briefings and converts emerging technology into actionable project and startup ideas. The entire experience lives inside iMessage with no external UI.

The agent runs as a single TypeScript process on macOS. It uses imessage-kit's real-time watcher to listen for incoming messages, classifies user intent via LLM, fetches high-signal tech updates from curated sources, generates opinionated responses, and replies directly through iMessage using `sdk.send()`.

## 2. Goals

- Deliver high-signal tech updates via iMessage with zero friction
- Convert every update into a concrete build idea, startup concept, or experiment
- Maintain persistent user context across conversations (topics, skill level, preferences)
- Support natural multi-turn follow-ups
- Feel like texting a well-informed friend, not querying a search engine

## 3. Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   macOS Host Machine                     │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │              SignalTone Agent (TypeScript)          │  │
│  │                                                    │  │
│  │  ┌────────────┐  ┌────────────┐  ┌─────────────┐  │  │
│  │  │  Intent     │  │  Source     │  │  Response    │  │  │
│  │  │  Router     │  │  Engine     │  │  Generator   │  │  │
│  │  └────────────┘  └────────────┘  └─────────────┘  │  │
│  │                                                    │  │
│  │  ┌────────────┐  ┌────────────┐  ┌─────────────┐  │  │
│  │  │  User       │  │  Message    │  │  Plugin      │  │  │
│  │  │  Memory     │  │  Scheduler  │  │  System      │  │  │
│  │  │  (SQLite)   │  │  (built-in) │  │  (sdk.use)   │  │  │
│  │  └────────────┘  └────────────┘  └─────────────┘  │  │
│  └───────────────────────┬───────────────────────────┘  │
│                          │                               │
│  ┌───────────────────────▼───────────────────────────┐  │
│  │         @photon-ai/imessage-kit SDK                │  │
│  │   sdk.startWatching()  |  sdk.send()  |  sdk.use() │  │
│  └───────────────────────┬───────────────────────────┘  │
│                          │                               │
│  ┌───────────────────────▼───────────────────────────┐  │
│  │        macOS iMessage Database (chat.db)           │  │
│  │              (Full Disk Access required)            │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
              ▲                           │
              │     iMessage / SMS / RCS  │
              ▼                           ▼
        ┌───────────┐              ┌───────────┐
        │   User A   │              │   User B   │
        └───────────┘              └───────────┘
```

### 3.1 Components

**@photon-ai/imessage-kit SDK**
Local macOS SDK that reads the iMessage database directly (chat.db). Provides real-time message watching via `sdk.startWatching()`, message sending via `sdk.send()`, built-in scheduling via `MessageScheduler` and `Reminders`, a message chain API for pattern matching (`sdk.message()`), and a plugin system (`sdk.use()`). Zero external dependencies on Bun; requires `better-sqlite3` on Node.js.

**Intent Router**
Classifies each inbound message into a request type and extracts parameters. Powered by a single LLM call with structured JSON output.

**Source Engine**
Fetches and ranks high-signal tech updates from curated APIs. Caches results with a 30-minute TTL to avoid redundant fetches.

**Response Generator**
Builds an LLM prompt from user context, source data, and conversation history. Returns opinionated, structured responses.

**User Memory (SQLite)**
Persistent store for user preferences, conversation history, topic affinity, and saved ideas. SQLite is the natural choice since imessage-kit already depends on SQLite for chat.db access.

**Message Scheduler (built-in)**
imessage-kit's `MessageScheduler` and `Reminders` classes handle proactive morning/evening briefings without external cron dependencies. Supports recurring schedules, persistence via `export()`/`import()`, and natural language timing.

**Plugin System**
imessage-kit's `sdk.use()` allows registering hooks for logging, analytics, rate limiting, and custom middleware on every send/receive cycle.

## 4. Core Message Loop

The agent's entry point is a single long-running TypeScript file:

```typescript
import {
  IMessageSDK,
  MessageScheduler,
  Reminders,
} from "@photon-ai/imessage-kit";

const sdk = new IMessageSDK({ debug: true });
const scheduler = new MessageScheduler(sdk);

// Real-time message handling
await sdk.startWatching({
  onDirectMessage: async (msg) => {
    // Skip reactions and own messages
    await sdk
      .message(msg)
      .ifFromOthers()
      .ifNotReaction()
      .when(async (m) => {
        const intent = await classifyIntent(m.text, m.sender);
        const response = await generateResponse(intent, m.sender);
        await sdk.send(m.sender, response);
        await logConversation(m.sender, m.text, response, intent);
      })
      .execute();
  },
  onError: (error) => {
    console.error("Watcher error:", error);
  },
});
```

### 4.1 Message Flow (End to End)

```
1. User sends iMessage
       │
2. sdk.startWatching() detects new message via chat.db polling
       │
3. onDirectMessage fires, sdk.message() chain filters out reactions/own messages
       │
4. classifyIntent() sends user text to LLM, returns structured intent JSON
       │
5. If intent requires source data:
   └── Source Engine fetches/caches updates, filters by user profile
       │
6. generateResponse() builds LLM prompt with user context + source data + intent
       │
7. LLM returns response text
       │
8. sdk.send(msg.sender, response) delivers reply via iMessage
       │
9. logConversation() persists the turn to SQLite
```

## 5. Intent Classification

Each inbound message is classified into one of the following intents:

| Intent              | Trigger Examples                                               | Behavior                                      |
| ------------------- | -------------------------------------------------------------- | --------------------------------------------- |
| `daily_briefing`    | "good morning," "what should I know today?"                    | Return top 1-3 updates with build ideas       |
| `evening_summary`   | "good night," "wrap up today"                                  | Executive summary of the day's notable shifts |
| `topic_query`       | "anything new in AI?," "what's happening in crypto?"           | Filtered update for a specific domain         |
| `build_idea`        | "what should I build this weekend?," "give me 3 startup ideas" | Generate ideas from recent trends             |
| `follow_up`         | "make that more technical," "turn that into a startup idea"    | Refine or expand the previous response        |
| `preference_update` | "I'm mostly interested in devtools," "keep it brief"           | Update user memory, confirm the change        |
| `save`              | "save this," "bookmark that idea"                              | Persist the last idea to user's saved list    |
| `recall`            | "what did I save?," "show me my ideas"                         | Return saved ideas                            |

Intent detection uses a single LLM call returning structured JSON:

```json
{
  "intent": "topic_query",
  "topic": "AI",
  "modifiers": ["technical", "brief"],
  "references_previous": false
}
```

## 6. Source Engine

### 6.1 Data Sources

Priority-ordered list of sources:

1. **Hacker News API** (top/best stories, filtered by score threshold)
2. **GitHub Trending** (daily, filtered by language and star velocity)
3. **ArXiv API** (cs.AI, cs.CL, cs.SE, filtered by recency)
4. **RSS feeds** from curated blogs (OpenAI, Anthropic, major devtools blogs)
5. **Product Hunt API** (daily top launches)

### 6.2 Ranking and Filtering

Raw items are scored by:

- Recency (exponential decay, half-life of 12 hours)
- Source authority (weighted by source tier)
- Topic relevance (cosine similarity to user's topic preferences)
- Novelty (penalize topics already sent to this user in the last 48 hours)

### 6.3 Caching

Source results are cached per-fetch with a 30-minute TTL. User-specific filtering happens post-cache so the raw fetch is shared across all users.

## 7. Response Generation

All responses are generated via the Claude API.

### 7.1 System Prompt Template

```
You are SignalTone, a tech scout for builders. You are opinionated, concise,
and action-oriented. Every response should make the reader want to build something.

User profile:
- Topics: {user.topics}
- Skill level: {user.skill_level}
- Preference: {user.response_style} (brief / detailed)
- Recent conversation context: {last_3_messages}

Rules:
- No fluff. Lead with the signal.
- Every update must include: what happened, why it matters, use cases, and a build idea.
- Have a point of view. Say what most people are missing.
- Keep responses under 200 words unless the user asks for more.
- Use plain conversational language, not bullet headers.
- This is iMessage. Keep it tight. No one reads essays in a text thread.
```

### 7.2 Response Format by Intent

**daily_briefing / topic_query:** One to three updates, each with the four-part structure (what happened, why it matters, use cases, build idea).

**evening_summary:** Three to five sentence recap of the day's most notable shifts. No build ideas unless requested.

**build_idea:** One to three concrete ideas with a one-paragraph MVP description each.

**follow_up:** Contextual expansion of the previous response, anchored to the same update.

## 8. Proactive Scheduling

imessage-kit provides built-in scheduling, so no external cron or task queue is needed.

### 8.1 Recurring Daily Briefings

```typescript
import { MessageScheduler } from "@photon-ai/imessage-kit";

const scheduler = new MessageScheduler(
  sdk,
  { debug: true },
  {
    onSent: (msg, result) => console.log(`Briefing sent: ${msg.id}`),
    onError: (msg, error) => console.error(`Send failed: ${error.message}`),
  },
);

// Morning briefing at 8 AM daily
scheduler.scheduleRecurring({
  to: userPhoneNumber,
  content: await generateMorningBriefing(userPhoneNumber),
  startAt: new Date("2026-01-01T08:00:00"),
  interval: "daily",
});

// Persist schedule across restarts
const data = scheduler.export();
// ... save to disk, restore with scheduler.import(data)
```

### 8.2 User-Controlled Reminders

```typescript
import { Reminders } from "@photon-ai/imessage-kit";

const reminders = new Reminders(sdk);

// User texts: "remind me about this in 2 hours"
reminders.in("2 hours", msg.sender, savedIdeaSummary);

// User texts: "send me a recap at 9pm"
reminders.at("9pm", msg.sender, await generateEveningSummary(msg.sender));
```

## 9. User Memory

### 9.1 Schema

```sql
CREATE TABLE users (
    phone_id       TEXT PRIMARY KEY,   -- msg.sender from imessage-kit
    topics         TEXT,               -- JSON array of preferred topics
    skill_level    TEXT DEFAULT 'intermediate',
    response_style TEXT DEFAULT 'brief',
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_active    DATETIME
);

CREATE TABLE conversations (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    phone_id       TEXT REFERENCES users(phone_id),
    role           TEXT,               -- 'user' or 'agent'
    content        TEXT,
    intent         TEXT,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE saved_ideas (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    phone_id       TEXT REFERENCES users(phone_id),
    idea_text      TEXT,
    source_update  TEXT,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sent_updates (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    phone_id       TEXT REFERENCES users(phone_id),
    source_url     TEXT,
    topic          TEXT,
    sent_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 9.2 Context Window Management

Each LLM call includes:

- User profile (topics, skill level, style)
- Last 5 conversation turns (trimmed to ~1,000 tokens)
- Current source material (trimmed to ~2,000 tokens)

Total prompt budget per request: ~4,000 tokens input, ~500 tokens output.

## 10. Plugin Integration

imessage-kit's plugin system is used for cross-cutting concerns:

```typescript
// Logging plugin (built-in)
sdk.use(loggerPlugin({ level: "info", colored: true }));

// Custom analytics plugin
sdk.use({
  name: "signaltone-analytics",
  onBeforeSend: async (to, content) => {
    trackOutboundMessage(to, content);
    return { to, content };
  },
  onAfterSend: async (result) => {
    trackDeliverySuccess(result);
  },
});

// Rate limiting plugin
sdk.use({
  name: "rate-limiter",
  onBeforeSend: async (to, content) => {
    await enforceRateLimit(to);
    return { to, content };
  },
});
```

## 11. Tech Stack

| Layer              | Technology                                                   |
| ------------------ | ------------------------------------------------------------ |
| iMessage transport | @photon-ai/imessage-kit v2.1.x                               |
| Runtime            | Bun (preferred, zero deps) or Node.js >= 18 + better-sqlite3 |
| Language           | TypeScript                                                   |
| LLM                | Claude API (claude-sonnet-4-20250514)                        |
| User database      | SQLite (via better-sqlite3 or Bun's built-in SQLite)         |
| Source fetching    | Native fetch with per-source adapter modules                 |
| Caching            | In-memory Map with TTL (MVP), Redis (scale)                  |
| Scheduling         | imessage-kit MessageScheduler + Reminders (built-in)         |
| Host               | macOS machine with Full Disk Access enabled                  |

## 12. Environment and Permissions

Since imessage-kit reads the local iMessage database (chat.db) and sends messages via AppleScript, the agent must run on a macOS machine with:

- **Full Disk Access** granted to the runtime (Bun, Node, or the terminal/IDE running the process)
- An active iMessage account signed in on the host
- The process running continuously (via launchd, pm2, or a simple nohup)

For development, the agent runs in a terminal. For production, wrap it as a launchd daemon to survive reboots.

## 13. MVP Scope (Week 1)

**In scope:**

- Single-file TypeScript agent using `sdk.startWatching()` and `sdk.send()`
- Intent classification for: daily_briefing, topic_query, build_idea, follow_up
- Source engine pulling from Hacker News API and GitHub Trending
- LLM-powered response generation with the four-part structure
- Basic user memory in SQLite (topics, last 5 turns)
- Message chain filtering (skip reactions, own messages via `ifFromOthers()` and `ifNotReaction()`)
- Conversational multi-turn follow-ups

**Out of scope for MVP:**

- Proactive scheduled briefings (MessageScheduler integration)
- Save/recall functionality
- GitHub activity watching
- ArXiv, Product Hunt, RSS integrations
- User onboarding flow
- Plugin-based analytics
- Multi-user isolation

## 14. Post-MVP Roadmap

**Phase 2 (Week 2-3):**

- Proactive morning/evening briefings using `scheduler.scheduleRecurring()`
- Save/recall ideas via "save this" / "what did I save?" intents
- Add ArXiv, Product Hunt, and RSS source adapters
- Topic affinity learning (auto-adjust weights based on follow-up engagement)
- Reminders integration ("remind me about this in 2 hours")

**Phase 3 (Week 4+):**

- GitHub activity integration: watch user repos, proactively text when relevant tools drop
- Weekly digest of saved ideas (scheduled via MessageScheduler)
- Deep dive mode ("tell me everything about X")
- Group chat support via `sdk.listChats()` and `onGroupMessage`
- Custom plugin for exporting ideas to Notion or a GitHub repo

## 15. Risks and Mitigations

| Risk                                         | Mitigation                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Source data is stale or low quality          | Score and filter aggressively. Prefer fewer, higher-signal updates over volume.                  |
| LLM generates hallucinated updates           | Always ground responses in fetched source data. Include source URLs in the LLM prompt.           |
| User context grows too large                 | Cap conversation history at 5 turns. Summarize older context into a profile blob.                |
| iMessage rate limits or AppleScript timeouts | Use sdk.maxConcurrent config (default 5). Queue outbound messages. Respect scriptTimeout.        |
| Cold start (new user, no preferences)        | Default to a broad "top tech" briefing. Ask one preference question after the first interaction. |
| macOS host goes offline                      | Use launchd for auto-restart. scheduler.export() persists pending jobs to disk.                  |
| Full Disk Access revoked                     | Catch DatabaseError from imessage-kit, log alert, and notify admin.                              |

## 16. Success Metrics

- **Retention:** % of users who text the agent 3+ days in a week
- **Follow-up rate:** % of briefings that generate a follow-up message (indicates engagement)
- **Save rate:** % of ideas saved (indicates perceived value)
- **Response latency:** Target under 5 seconds end-to-end (watcher poll interval + LLM call)
- **Response quality:** Manual review of 20 responses per week for accuracy, relevance, and actionability

---

## 17. Build Notes

> Added after the Week 1 MVP build. Documents what was implemented, deviations from spec, deferred items, and open issues.

### What Was Implemented

| File              | Description                                                                                                                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`    | Entry point. Boots `IMessageSDK`, runs `startWatching()` loop with `ifFromOthers()` + `ifNotReaction()` chain filtering, wires all modules together.                                                                                                    |
| `src/intent.ts`   | Intent router. Single Claude API call using `output_config.format` (JSON schema structured output) returning one of 8 intent types. Includes a heuristic keyword fallback if the API call fails.                                                        |
| `src/sources.ts`  | Source engine. Hacker News Firebase API + GitHub Search API proxy for trending. 30-minute in-memory `Map` cache with recency scoring (exponential decay, 12-hour half-life). Topic keyword expansion for AI, crypto, devtools, cloud, security, mobile. |
| `src/response.ts` | Response generator. Streaming Claude API call (`messages.stream()` + `finalMessage()`) using the system prompt template from Section 7.1. Per-intent user turn construction.                                                                            |
| `src/db.ts`       | SQLite memory layer. Full Section 9.1 schema (`users`, `conversations`, `saved_ideas`, `sent_updates`). `better-sqlite3` with WAL mode, prepared statements, typed getters.                                                                             |
| `package.json`    | Bun project. Dependencies: `@photon-ai/imessage-kit`, `@anthropic-ai/sdk`, `better-sqlite3`.                                                                                                                                                            |
| `tsconfig.json`   | TypeScript config targeting ES2022, `moduleResolution: bundler` (Bun-compatible).                                                                                                                                                                       |
| `.env.example`    | Documents `ANTHROPIC_API_KEY`, optional `GITHUB_TOKEN`, optional `DEBUG`.                                                                                                                                                                               |

**MVP intent coverage:** All 8 intents are handled — including `save` and `recall` which were listed as out-of-scope in Section 13 but were straightforward to wire in.

### Deviations from Spec

| Spec                                                             | Actual                                                              | Reason                                                                                                                                                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Section 11: `claude-sonnet-4-20250514`                           | `claude-opus-4-6`                                                   | That model ID doesn't exist. Used the current Opus 4.6 (most capable, as recommended by claude-api skill defaults). Can be changed to `claude-sonnet-4-6` for cost reduction. |
| Section 13: MVP intent set (4 intents)                           | All 8 intents implemented                                           | `save` and `recall` were trivial to add given the DB schema was already built. `preference_update` and `evening_summary` required no extra complexity.                        |
| Section 6.2: Novelty penalization (dedup against `sent_updates`) | Not implemented                                                     | Would require per-user query on every source fetch. Deferred — the `sent_updates` table is in place for Phase 2.                                                              |
| GitHub Trending API                                              | GitHub Search API (`/search/repositories?created:>DATE&sort=stars`) | No official GitHub Trending API exists. The search proxy is a reliable approximation. Documented in `sources.ts`.                                                             |
| Section 10: Plugin system (`sdk.use()`)                          | Not used                                                            | The PRD's analytics/rate-limiting plugins were listed as out-of-scope for MVP. `console.log` handles basic observability.                                                     |
| Section 8: `MessageScheduler` / `Reminders`                      | Not implemented                                                     | Explicitly out of scope for Week 1.                                                                                                                                           |
| Section 4 code example: `msg.text`                               | `m.text ?? ""`                                                      | Defensive null handling in case `text` is undefined on a non-text iMessage (stickers, audio, etc.).                                                                           |

### Architectural Decisions

- **`claude-opus-4-6` for both intent classification and response generation.** Two separate API calls per message turn: one small structured call (~256 tokens out) for classification and one streaming call (~1024 tokens out) for the response. Could be optimized to a single call with a combined prompt if latency becomes an issue.
- **`output_config.format` (JSON schema) for intent classification**, not tool use. Structured outputs guarantee parseable JSON and eliminate the tool-use loop overhead for a single-turn classification call.
- **Streaming for response generation** (`messages.stream()` + `finalMessage()`). Prevents HTTP timeout on longer responses and is required for `max_tokens` > 8192 on Opus 4.6.
- **better-sqlite3 over `bun:sqlite`**. The PRD explicitly requested `better-sqlite3`. Both would work; `bun:sqlite` would reduce dependencies but would require changing the import.
- **Heuristic intent fallback.** If the API call fails (network, rate limit, etc.), `fallback()` in `intent.ts` uses keyword matching to make a best-effort guess so the agent doesn't go silent.

### Open Issues

1. **`@photon-ai/imessage-kit` API surface assumed from PRD.** The exact method signatures of `sdk.message(msg).ifFromOthers().ifNotReaction().when().execute()` and `sdk.send()` are taken directly from the PRD's code examples. If the published package differs, `src/index.ts` will need adjustments.
2. **GitHub rate limiting.** Without `GITHUB_TOKEN`, the GitHub Search API allows 60 unauthenticated requests/hour. With 30-min caching this is fine for a single user; multi-user deployment needs a token.
3. **No onboarding flow.** New users get a cold-start briefing with default preferences (intermediate, brief, general tech). The PRD's "ask one preference question after first interaction" (Section 15) is not implemented.
4. **`save` intent relies on conversation log.** When the user says "save this", the code looks up the last agent turn in the DB. If the user says "save" before any prior exchange, nothing is saved. A more robust approach would track the "last response" in memory during the session.
5. **No deduplication.** The `sent_updates` table is populated but not yet queried to filter out topics already sent in the past 48 hours (Section 6.2 novelty scoring).
6. **Error reply on `sdk.send()` failure.** If the error reply itself fails to send, it's swallowed with a `console.error`. This is acceptable for MVP but should be alertable in production.

### Deferred (Phase 2)

- `MessageScheduler` proactive morning/evening briefings
- ArXiv, Product Hunt, RSS feed adapters
- Novelty deduplication against `sent_updates`
- Topic affinity learning from follow-up engagement
- Onboarding flow for new users
- Rate-limiting and analytics plugins via `sdk.use()`

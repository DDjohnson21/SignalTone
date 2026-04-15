# SignalTone - Technical PRD

> **Implementation status** — updated 2026-04-15
>
> | Section | Status |
> |---------|--------|
> | §5 Architecture | ✅ Implemented |
> | §6 Primary User Flows | ✅ 6.1 Reactive Discovery, 6.2 Proactive Alerts, 6.3 Build Flow implemented |
> | §7 Core Loops | ✅ 7.1 Inbound loop, 7.2 Flow, 7.3 Radar scheduler implemented |
> | §8 Opportunity Committee | ✅ Implemented (`src/committee.ts`) |
> | §9 Source Engine | ✅ Implemented (`src/sources.ts`) — 5 sources, 30-min cache |
> | §10 GitHub & Build System | ✅ Implemented (`src/github.ts`, `src/builder.ts`) |
> | §11 Intents | ✅ All 12 intents implemented (`src/intent.ts`) |
> | §12 Response Generation | ✅ Implemented (`src/response.ts`) |
> | §13 User Memory & Persistence | ✅ Implemented (`src/db.ts`) — full PRD schema |
> | §14 Scheduling | ✅ Implemented (`src/scheduler.ts`) — 8am/9pm briefings |
> | §17.1 MVP Scope | ✅ Complete |
> | §17.2 Out of Scope | ⏳ Post-MVP |

## 1. Overview

SignalTone is an iMessage-first builder agent built on Photon's `@photon-ai/imessage-kit`. It watches for breakout technical signals, such as new AI models, repositories, frameworks, APIs, and developer tools, decides whether there is a real use case worth building, and turns the strongest opportunities into open-source starter projects in GitHub.

iMessage is the control surface. GitHub is the execution surface.

A user can text SignalTone things like:

- "Anything interesting today?"
- "What new model is actually worth building on?"
- "Take the best one and build something useful with it"
- "Turn that into an open-source project"
- "What did you ship for me this week?"

SignalTone does not just summarize news. It runs an internal opportunity committee, ranks practical use cases, scaffolds a repo or branch, creates starter code and issues, and reports back in iMessage with what it found or built.

The system is centered on Photon for iMessage transport and delivery, with an orchestration layer that manages multi-step analysis and build workflows.

## 2. Product Thesis

Builders are overloaded with signals and under-supported on execution.

Most products stop at "here is what launched." SignalTone goes further:

1. Detect a new signal
2. Judge whether it matters
3. Find the best complementary use case
4. Build the first version of it
5. Notify the user in iMessage

The core value is not raw news. It is turning new technology into shipped open-source bets.

## 3. Goals

- Detect high-signal new projects, models, frameworks, and APIs quickly
- Convert each major signal into one or more concrete build opportunities
- Rank opportunities by usefulness, buildability, and likely adoption
- Let users trigger builds directly from iMessage
- Scaffold open-source repos, starter apps, integrations, or utilities in GitHub
- Maintain persistent user context, including topics, past builds, saved ideas, and build preferences
- Support natural follow-ups, such as refining a use case or iterating on a repo
- Keep the interaction lightweight and conversational in iMessage

## 4. Non-Goals

- Fully autonomous publishing to production
- Auto-merging code to `main` without user approval
- Replacing the user's full IDE workflow
- Providing a complete project management UI in MVP
- Building every trending project without a scoring threshold

## 5. Architecture

```text
┌──────────────────────────────────────────────────────────────────────┐
│                           macOS Host Machine                         │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │                     Photon iMessage Edge                        │  │
│  │                                                                │  │
│  │  startWatching()  |  send()  |  scheduler/reminders  |  use()  │  │
│  └───────────────────────────────┬────────────────────────────────┘  │
│                                  │                                   │
│  ┌───────────────────────────────▼────────────────────────────────┐  │
│  │                     SignalTone App (TypeScript)                 │  │
│  │                                                                │  │
│  │  ┌──────────────┐  ┌────────────────┐  ┌────────────────────┐  │  │
│  │  │ Intent Router │  │ Signal Radar   │  │ Response Generator │  │  │
│  │  └──────────────┘  └────────────────┘  └────────────────────┘  │  │
│  │                                                                │  │
│  │  ┌────────────────────┐  ┌───────────────────────────────────┐ │  │
│  │  │ User / Repo Memory  │  │ Scheduler + Alert Thresholds      │ │  │
│  │  │ SQLite              │  │                                   │ │  │
│  │  └────────────────────┘  └───────────────────────────────────┘ │  │
│  └───────────────────────────────┬────────────────────────────────┘  │
│                                  │                                   │
└──────────────────────────────────┼───────────────────────────────────┘
                                   │
                     ┌─────────────▼─────────────┐
                     │   Orchestration Layer     │
                     │   Opportunity Committee   │
                     │   Build Workspaces        │
                     │   Iteration Workflows     │
                     └─────────────┬─────────────┘
                                   │
          ┌────────────────────────┼────────────────────────┐
          │                        │                        │
┌─────────▼────────┐     ┌────────▼─────────┐     ┌────────▼────────┐
│ Source Connectors │     │ GitHub Integration│     │ Build Workspace │
│ HN, GitHub, RSS,  │     │ repo, branch, PR, │     │ codegen, tests, │
│ arXiv, Product    │     │ issues, commits    │     │ lint, artifacts │
│ Hunt, model feeds │     └───────────────────┘     └────────────────┘
└──────────────────┘
```

### 5.1 Core System Components

**Photon iMessage Edge**
Handles inbound and outbound iMessage traffic. This is the user-facing layer and remains essential to the product. It listens to messages, sends replies, supports scheduled outbound updates, and acts as the conversational interface for approvals and follow-ups.

**Intent Router**
Classifies inbound messages into structured intents, such as `daily_briefing`, `build_this`, `repo_status`, or `iterate_repo`.

**Signal Radar**
Fetches and scores new technical signals from sources like GitHub, Hacker News, arXiv, RSS, Product Hunt, and model release feeds.

**Opportunity Committee**
A multi-step reasoning workflow that evaluates whether a signal is worth building on, what the best use case is, whether it is a company, feature, or utility, and what the first version should look like.

**Build Orchestrator**
Takes approved opportunities and creates a build plan, workspace, code scaffold, README, issues, and GitHub branch or repository.

**GitHub Integration**
Creates repos, branches, commits, PRs, and seeded issues. GitHub becomes the artifact surface where builds live and iterate.

**User and Repo Memory**
Stores user preferences, prior ideas, opportunities seen, repos created, build runs, and outbound alerts.

**Response Generator**
Creates concise, opinionated iMessage replies that summarize the signal, explain why it matters, and report build status when applicable.

## 6. Primary User Flows

### 6.1 Reactive Discovery Flow

1. User texts SignalTone, "Anything interesting today?"
2. SignalTone fetches recent high-signal events.
3. The opportunity committee evaluates the best candidates.
4. SignalTone replies with the top one to three opportunities, including:
   - What launched
   - Why it matters
   - What people are missing
   - The best use case to build
   - Whether it is worth shipping

### 6.2 Proactive Alert Flow

1. SignalTone monitors sources on a schedule.
2. A new repo, model, or framework crosses a threshold.
3. SignalTone runs the opportunity committee.
4. If the result is strong enough, it texts the user:
   - What launched
   - Why it is interesting
   - The strongest complementary OSS idea
   - Whether it is worth building now

### 6.3 Build Flow

1. User replies, "Build it."
2. SignalTone creates a workspace for that opportunity.
3. It generates:
   - Repo name
   - Project thesis
   - README
   - Starter code
   - Seeded issues
   - First commit
   - Branch or draft PR
4. SignalTone texts the user the result in iMessage.

### 6.4 Iteration Flow

1. User replies, "Make it more useful for developers," or "Add support for X."
2. SignalTone loads the repo context and prior build state.
3. It applies a follow-up build plan.
4. It pushes a new commit or PR update.
5. SignalTone sends a concise status update back via iMessage.

## 7. Core Loops

### 7.1 Inbound Message Loop

```typescript
import { IMessageSDK } from "@photon-ai/imessage-kit";

const sdk = new IMessageSDK({ debug: true });

await sdk.startWatching({
  onDirectMessage: async (msg) => {
    await sdk
      .message(msg)
      .ifFromOthers()
      .ifNotReaction()
      .when(async (m) => {
        const intent = await classifyIntent(m.text ?? "", m.sender);
        const result = await handleIntent(intent, m.sender);
        await sdk.send(m.sender, result.reply);
        await persistTurn(m.sender, m.text ?? "", result);
      })
      .execute();
  },
});
```

### 7.2 Inbound Flow

1. Photon detects a new inbound iMessage
2. SignalTone filters reactions and its own messages
3. Intent Router classifies the message
4. SignalTone dispatches to one of:
   - Discovery
   - Explanation
   - Build
   - Repo iteration
   - Save/recall
   - Scheduling
5. A concise reply is sent through iMessage
6. State is written to SQLite

### 7.3 Scheduled Radar Loop

1. Poll curated sources every N minutes
2. Normalize raw events into `source_event` records
3. Cluster duplicates across feeds
4. Score each event
5. Run opportunity committee on top candidates
6. If candidate exceeds alert threshold:
   - Persist opportunity
   - Send proactive iMessage alert
   - Optionally wait for user approval before building

### 7.4 Build Execution Loop

1. Create workspace for opportunity
2. Generate project thesis and scope
3. Choose project type:
   - Starter app
   - SDK / wrapper
   - Integration
   - Workflow utility
   - Evaluation tool
   - Demo / template
4. Scaffold repo contents
5. Run tests, lint, and basic validation if configured
6. Commit to branch or create draft repo
7. Seed issues and roadmap items
8. Text the user with repo status and next actions

## 8. Opportunity Committee ✅ `src/committee.ts`

The opportunity committee is the heart of the product. It prevents SignalTone from acting like a generic summarizer.

| Role    | Responsibility                                                                  | Output                    |
| ------- | ------------------------------------------------------------------------------- | ------------------------- |
| Scout   | Identify what launched and summarize the core signal                            | Normalized signal summary |
| Skeptic | Attack the hype, surface risk and commodity concerns                            | Hype risk, failure modes  |
| Builder | Propose practical use cases and MVPs                                            | Ranked build ideas        |
| Market  | Decide whether the best angle is a feature, utility, OSS tool, or company wedge | Market framing            |
| Coder   | Turn the best idea into a repo plan                                             | Repo spec, files, issues  |
| Editor  | Compress everything into an iMessage-ready response                             | Final text reply          |

### 8.1 Committee Output Shape

```json
{
  "signal": "New multimodal coding model launched",
  "why_now": "Much better tool calling and lower latency than current options",
  "best_use_case": "A lightweight repo assistant for reading codebases and drafting migration PRs",
  "project_type": "open_source_tool",
  "verdict": "worth_building",
  "risk": "Could be copied quickly if differentiation is thin",
  "first_repo": {
    "name": "repo-migrate-assistant",
    "goal": "Generate migration plans and starter PRs for framework upgrades"
  }
}
```

### 8.2 Scoring Dimensions

Each opportunity is scored on:

- Recency
- Adoption velocity
- Technical leverage
- Complement gap (what useful tool still does not exist around the signal)
- Buildability in 1 to 2 days
- Personal fit to the user
- Likely usefulness to other builders
- Novelty versus previously sent opportunities

## 9. Source Engine

### 9.1 Source Types

SignalTone watches a mix of social-proof and technical-depth sources:

- GitHub search and trending approximations
- Hacker News
- arXiv categories relevant to AI and software engineering
- RSS feeds from major labs, devtools companies, and builders
- Product Hunt for developer-facing launches
- Model release pages and API changelogs
- Curated feeds for infrastructure, agents, security, and productivity

### 9.2 Ranking and Filtering

Raw events are scored by:

- Recency decay
- Source authority
- Topic relevance
- Novelty
- Adoption velocity
- Complement gap
- User utility
- Community utility

SignalTone should prefer things that are not only hyped, but actually useful to build around.

### 9.3 Caching

- Shared fetch cache with a 15 to 30 minute TTL
- User-specific ranking happens after cache
- Deduplication window for repeated links and repeated concepts is at least 48 hours

## 10. GitHub and Build System ✅ `src/github.ts` + `src/builder.ts`

### 10.1 GitHub Objectives

When an opportunity is approved for build, SignalTone should be able to:

- Create a new repo or branch
- Generate an initial README
- Scaffold starter code
- Create seed issues
- Open a draft PR
- Append follow-up commits as the user iterates

### 10.2 Build Artifacts

A successful first build should usually include:

- `README.md`
- `LICENSE`
- Minimal starter code
- Configuration files
- Issue templates or seeded issues
- Roadmap issues
- Example usage
- Optional screenshots or generated assets later

### 10.3 Project Types

SignalTone should not default to random demo apps. It should choose the strongest shape for the signal:

- Open-source utility
- SDK or wrapper
- Integration adapter
- Evaluation dashboard
- Workflow automation tool
- Starter kit / template
- Reference implementation
- Hackathon-ready prototype

### 10.4 Guardrails

- Never auto-merge to main
- Default to draft PR or branch-first workflow
- Do not build if the opportunity score is below threshold
- Allow user approval before repo creation
- Preserve clear repo provenance, including source signal and generated scope

## 11. Intents ✅ `src/intent.ts`

| Intent              | Example                                        | Behavior                                     |
| ------------------- | ---------------------------------------------- | -------------------------------------------- |
| `daily_briefing`    | "Anything interesting today?"                  | Return top opportunities, not just headlines |
| `topic_query`       | "Anything new in AI infra?"                    | Filter signals by domain                     |
| `opportunity_query` | "What new repo is actually worth building on?" | Return ranked buildable opportunities        |
| `build_this`        | "Build the best one"                           | Start a repo workflow                        |
| `refine_build`      | "Make it more useful for teams"                | Update project scope                         |
| `repo_status`       | "What have you built for me?"                  | Summarize repos, PRs, issues                 |
| `save`              | "Save that idea"                               | Persist opportunity or repo concept          |
| `recall`            | "Show me my saved ideas"                       | Return saved items                           |
| `preference_update` | "Focus on devtools and security"               | Update memory profile                        |
| `reminder`          | "Ping me tonight if anything big drops"        | Schedule alert or digest                     |
| `follow_up`         | "Why is that better than existing tools?"      | Expand prior response                        |
| `group_mode`        | "Summarize what this chat should build"        | Handle group chat brainstorming later        |

## 12. Response Generation

All user-facing responses are optimized for iMessage. They should be short, opinionated, and useful.

### 12.1 System Prompt Template

```text
You are SignalTone, an iMessage-native builder scout and execution agent.

Your job is to detect what new technical signal matters, decide whether it is worth building on, and help the user ship useful open-source projects around it.

User profile:
- Topics: {user.topics}
- Build preferences: {user.build_preferences}
- Skill level: {user.skill_level}
- Recent conversation context: {last_messages}
- Existing repos and saved ideas: {repo_context}

Rules:
- Lead with the signal, not fluff.
- Do not just summarize hype.
- Always explain why it matters for builders.
- Prefer practical use cases over generic demos.
- When relevant, say whether it is worth building now.
- If a repo exists, report status clearly.
- Keep iMessage replies concise unless the user asks for depth.
```

### 12.2 Standard Reply Shape

For most opportunities, the response should include:

- What launched
- Why it matters
- What most people are missing
- The best thing to build with it
- Build status, if a repo already exists

**Example:**

> New X model just dropped. The headline is accuracy, but the real opportunity is that it makes Y workflow cheap enough to productize. Most people will build demos. The better move is a small OSS tool for Z. I can scaffold that now.

## 13. User Memory and Persistence ✅ `src/db.ts`

SQLite remains the MVP persistence layer.

### 13.1 Schema

```sql
CREATE TABLE users (
    phone_id            TEXT PRIMARY KEY,
    topics              TEXT,
    skill_level         TEXT DEFAULT 'intermediate',
    response_style      TEXT DEFAULT 'brief',
    build_preferences   TEXT,
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_active         DATETIME
);

CREATE TABLE conversations (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    phone_id            TEXT REFERENCES users(phone_id),
    role                TEXT,
    content             TEXT,
    intent              TEXT,
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE source_events (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    external_id         TEXT,
    source_type         TEXT,
    title               TEXT,
    url                 TEXT,
    topic               TEXT,
    raw_payload         TEXT,
    score               REAL,
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE opportunities (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    phone_id            TEXT REFERENCES users(phone_id),
    source_event_id     INTEGER REFERENCES source_events(id),
    thesis              TEXT,
    project_type        TEXT,
    opportunity_score   REAL,
    verdict             TEXT,
    status              TEXT DEFAULT 'identified',
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE repositories (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    phone_id            TEXT REFERENCES users(phone_id),
    opportunity_id      INTEGER REFERENCES opportunities(id),
    repo_name           TEXT,
    repo_url            TEXT,
    default_branch      TEXT,
    status              TEXT DEFAULT 'draft',
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE build_runs (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    repository_id       INTEGER REFERENCES repositories(id),
    run_type            TEXT,
    summary             TEXT,
    commit_sha          TEXT,
    pr_url              TEXT,
    status              TEXT,
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE saved_items (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    phone_id            TEXT REFERENCES users(phone_id),
    item_type           TEXT,
    reference_id        TEXT,
    note                TEXT,
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sent_alerts (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    phone_id            TEXT REFERENCES users(phone_id),
    source_event_id     INTEGER REFERENCES source_events(id),
    sent_at             DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 13.2 Context Included Per Call

Each reasoning pass should include:

- User profile
- Recent message history
- Recent opportunities shown
- Active repository context
- Saved ideas
- Source material relevant to the current request

## 14. Scheduling and Notifications

SignalTone has two kinds of scheduling:

### 14.1 User-Facing iMessage Scheduling

Used for:

- Morning opportunity briefings
- Evening build recaps
- Reminders to revisit ideas
- Repo progress alerts

### 14.2 Internal Radar Scheduling

Used for:

- Source polling
- Deduplication windows
- Threshold-triggered alerts
- Periodic repo iteration checks

### 14.3 Notification Policy

Do not proactively ping users for every new launch. Only notify when:

- The signal is strong
- The use case is concrete
- The opportunity score is above threshold
- The result is new enough to matter

## 15. Tech Stack

| Layer              | Technology                                                                    |
| ------------------ | ----------------------------------------------------------------------------- |
| iMessage transport | `@photon-ai/imessage-kit`                                                     |
| Runtime            | TypeScript on Bun or Node.js                                                  |
| Orchestration      | Multi-step workflow layer for opportunity analysis and build execution        |
| LLM                | Configurable provider, optimized for structured reasoning and code generation |
| Persistence        | SQLite                                                                        |
| GitHub integration | GitHub REST / GraphQL APIs                                                    |
| Source fetching    | Adapter modules per source                                                    |
| Caching            | In-memory TTL cache for MVP                                                   |
| Scheduling         | Photon scheduler for user-facing delivery, internal scheduler for radar jobs  |
| Host requirements  | macOS for iMessage edge, optional separate build runner for code work         |

## 16. Environment and Permissions

The iMessage edge must run on macOS with:

- Full Disk Access for the runtime
- An active iMessage account signed in
- Long-running process management

Build workflows also require:

- GitHub token or GitHub App credentials
- Local or remote writable workspace
- Permission to create branches, repos, commits, PRs, and issues

Only the Photon edge must live on macOS. Build workers can be isolated separately.

## 17. MVP Scope

### 17.1 In Scope

- iMessage inbound and outbound loop using Photon
- Intent routing for discovery, build, repo status, follow-up, save, and recall
- Source engine for GitHub, Hacker News, and a small curated RSS set
- Opportunity committee that returns one ranked build idea per strong signal
- Ability to text "build it" and create a draft repo or branch
- README generation
- Minimal starter code scaffold
- Seeded GitHub issues
- SQLite memory for users, opportunities, repos, and build runs
- Proactive alerts for only the top-scoring opportunities

### 17.2 Out of Scope for MVP

- Auto-merging or autonomous release
- Web dashboard
- Complex group chat collaboration
- Long-running CI agents
- Broad multi-user scale
- Advanced artifact generation like decks or PDFs
- Deep benchmarking across models

## 18. Post-MVP Roadmap

### Phase 2

- Group chat mode for cofounders or hackathon teams
- Repo iteration from iMessage, such as "add auth" or "focus on SMB users"
- More source adapters, including arXiv and Product Hunt
- Weekly shipped-project digest
- Ranking improvements based on which alerts the user actually acts on

### Phase 3

- Personal GitHub context, such as starred repos, watched repos, and prior build history
- Richer artifact generation, such as diagrams, screenshots, and one-page briefs
- Evaluation mode that scores repo usefulness before creating it
- Optional web layer for browsing opportunities and repo portfolio
- Portfolio view of all generated open-source bets

## 19. Risks and Mitigations

| Risk                    | Mitigation                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------- |
| Too many alerts         | Use strict opportunity thresholds and novelty filters                               |
| Generic projects        | Force the committee to produce a complement gap and practical use case before build |
| Low-quality code output | Default to starter repos, not finished products, and keep user approval in the loop |
| GitHub spam             | Branch-first or draft-repo-first workflow                                           |
| False hype              | Skeptic pass is mandatory before proactive notification                             |
| Context drift           | Persist repo and opportunity state cleanly, keep prompts grounded                   |
| macOS host offline      | Use a restartable service and persist pending scheduled jobs                        |
| API cost growth         | Cache source data and reserve build workflows for only top-scoring candidates       |

## 20. Success Metrics

- **Opportunity alert reply rate:** how often users respond to proactive alerts
- **Build trigger rate:** how often users approve "build it"
- **Repo creation rate:** number of viable repos created per week
- **Iteration rate:** how often users ask for follow-up changes after first scaffold
- **Saved opportunity rate:** how often users save opportunities for later
- **Retention:** users who interact with SignalTone 3 or more days in a week
- **Build usefulness rate:** manual or user-scored measure of whether the generated repo is actually worth keeping
- **Latency:** target under 5 to 10 seconds for normal text replies, longer allowed for build initiation with progress updates

## 21. Positioning

SignalTone is not an iMessage news bot.

SignalTone is an iMessage-native opportunity engine that watches for breakout tech, decides what is worth building, and turns the best ideas into open-source projects in GitHub.

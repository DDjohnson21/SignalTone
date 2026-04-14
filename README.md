# SignalTone

An iMessage-native agent that watches tech news and sends you opinionated, builder-focused briefings. Classifies your messages, fetches live data from multiple sources, and replies directly in iMessage — no app, no browser.

## Stack

- **Runtime:** Bun + TypeScript
- **iMessage:** `@photon-ai/imessage-kit`
- **LLM:** OpenAI (gpt-5.4) or Claude (claude-opus-4-6) — switchable via `LLM_PROVIDER` env var
- **Memory:** SQLite via `bun:sqlite`

## Setup

```bash
bun install
```

Copy the example env and fill in your keys:

```bash
cp .env.example .env
```

Required:
- `OPENAI_API_KEY` (if using `LLM_PROVIDER=openai`)
- `ANTHROPIC_API_KEY` (if using `LLM_PROVIDER=anthropic`)

Optional:
- `GITHUB_TOKEN` — raises GitHub API rate limit from 60 → 5000 req/hr
- `DEBUG=true` — verbose SDK + watcher logs

## Run

```bash
# Production
bun start

# Development (auto-reload on file changes)
bun dev
```

> **Note:** Messages must be sent from a different device or Apple ID than the Mac running the agent. Messages sent from the same Mac are filtered out as outgoing.

## How it works

1. Listens for incoming iMessages via `@photon-ai/imessage-kit`
2. Classifies intent via a structured LLM call (JSON schema output)
3. Fetches live data from 5 sources with a 30-min shared cache
4. Deduplicates against URLs already sent to you in the last 48 hours
5. Re-ranks items by your topic affinity (learned from engagement)
6. Validates all HN article links — dead links fall back to the HN discussion page
7. Streams a response back via iMessage
8. Persists conversation history, saved ideas, and briefing logs in `signaltone.db`

## Sources

| Source | What it fetches |
| --- | --- |
| Hacker News | Top stories filtered by score ≥ 50; external URLs validated |
| GitHub Trending | Repos created in the last 7 days, sorted by stars |
| ArXiv | Latest cs.AI, cs.CL, and cs.SE papers |
| RSS — Simon Willison | AI research and tooling commentary |
| RSS — TechCrunch | General tech news |
| RSS — The Verge | Consumer and industry tech |

## What you can text it

| Intent | Example messages | What it does |
| --- | --- | --- |
| `daily_briefing` | "good morning", "what should I know today?" | Top 1–3 updates with build ideas |
| `evening_summary` | "good night", "wrap up today" | Executive recap of the day's notable shifts |
| `topic_query` | "anything new in AI?", "what's happening in crypto?" | Filtered update for a specific domain |
| `build_idea` | "what should I build this weekend?", "build?" | Concrete ideas rooted in recent trends |
| `follow_up` | "make that more technical", "turn that into a startup idea" | Refines or expands the previous response |
| `preference_update` | "I'm mostly interested in devtools", "keep it brief" | Updates your profile, adjusts future responses |
| `save` | "save this", "bookmark that idea" | Saves the last idea to your list |
| `recall` | "what did I save?", "show me my ideas" | Returns your saved ideas |
| `reminder` | "remind me in 2 hours", "remind me at 5pm" | Schedules an iMessage reminder via the SDK |

## Proactive briefings

SignalTone automatically sends briefings without you texting first:

- **8:00am** — morning briefing (same as `daily_briefing`)
- **9:00pm** — evening summary (same as `evening_summary`)

Briefings are sent to every user who has interacted with the agent. Double-sends are prevented if the process restarts mid-day.

## Topic affinity

Every time you query a topic or follow up on one, that topic's weight increases in your profile. Future source rankings float your preferred topics to the top automatically.

## File structure

```
src/
  index.ts      — entry point, message loop, SDK watcher
  intent.ts     — 9-intent classifier with structured JSON output
  sources.ts    — HN + GitHub + ArXiv + RSS fetcher with 30-min cache
  response.ts   — streaming LLM response generator
  scheduler.ts  — proactive morning/evening briefing scheduler
  db.ts         — SQLite memory (users, conversations, saved_ideas, sent_updates, briefing_log)
  llm.ts        — OpenAI / Anthropic provider abstraction
```

# SignalTone

An iMessage-native agent that watches tech news and sends you opinionated, builder-focused briefings. Classifies your messages, fetches HN + GitHub Trending, and replies directly in iMessage — no app, no browser.

## Stack

- **Runtime:** Bun + TypeScript
- **iMessage:** `@photon-ai/imessage-kit`
- **LLM:** Claude (claude-opus-4-6) via `@anthropic-ai/sdk`
- **Memory:** SQLite via `better-sqlite3`

## Setup

```bash
bun install
```

Set your API key:

```bash
export ANTHROPIC_API_KEY=your_key_here
```

## Run

```bash
# Production
bun start

# Development (auto-reload on file changes)
bun dev
```

## How it works

1. Listens for incoming iMessages
2. Classifies intent (briefing, trending, save idea, etc.) via Claude
3. Fetches live data from Hacker News and GitHub Trending (30-min cache)
4. Streams a response back to the sender via iMessage
5. Persists conversation history and saved ideas in `signaltone.db`

## What you can text it

| Intent | Example messages | What it does |
| --- | --- | --- |
| `daily_briefing` | "good morning", "what should I know today?" | Top 1–3 updates with build ideas |
| `evening_summary` | "good night", "wrap up today" | Executive recap of the day's notable shifts |
| `topic_query` | "anything new in AI?", "what's happening in crypto?" | Filtered update for a specific domain |
| `build_idea` | "what should I build this weekend?", "give me startup ideas" | Concrete ideas rooted in recent trends |
| `follow_up` | "make that more technical", "turn that into a startup idea" | Refines or expands the previous response |
| `preference_update` | "I'm mostly interested in devtools", "keep it brief" | Updates your profile, adjusts future responses |
| `save` | "save this", "bookmark that idea" | Saves the last idea to your list |
| `recall` | "what did I save?", "show me my ideas" | Returns your saved ideas |

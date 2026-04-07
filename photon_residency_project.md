# SignalTone: An iMessage Agent That Turns Tech News Into Build Ideas

## One-Liner

An iMessage agent that watches the tech landscape for you, texts you what matters, and tells you exactly what you could build with it.

## The Problem

Builders drown in information but starve for direction. Everyone scrolls X, skims newsletters, and bookmarks articles they never revisit. The gap isn't awareness, it's action. People hear about new technology but don't know how to apply it. No tool bridges the distance between "that's interesting" and "here's what I should do with it."

## What SignalTone Does

Text the agent like you'd text a friend. Say "good morning" and get back a short, conversational briefing on the most relevant tech shift of the day. Say "good night" and get an executive summary of what moved. Ask "what should I build this weekend?" and get a concrete idea rooted in something real that just happened.

Every response follows a simple structure:

1. What happened
2. Why it matters
3. Practical use cases
4. A project, startup idea, or experiment you could build from it

The agent doesn't just summarize. It translates trends into opportunities.

## What Makes This Different

**It accumulates context over time.** The agent remembers your interests, your skill level, and what you've asked about before. If you keep asking about voice AI, it starts proactively flagging relevant launches, open source drops, and funding rounds without you asking. This is what separates an agent from a chatbot.

**It has a point of view.** Instead of neutral summaries, SignalTone is opinionated. "This matters because X, but most people are sleeping on Y angle." That personality is what makes someone actually text it every day.

**It narrows hard on builders.** This isn't a general news bot. Every response ends with something you can do. The audience is people who ship things: solo founders prototyping MVPs, developers exploring side projects, students looking for hackathon concepts.

## Example Interaction

**User:** good morning

**Agent:**
Morning. Here's one thing worth knowing today:

Open-source voice AI models just got dramatically cheaper and more realistic.

Why it matters: the barrier to building voice agents and phone-based assistants just dropped. This used to require enterprise budgets.

Use cases: appointment booking, customer support, tutoring, accessibility tools.

Build idea: an AI receptionist for small businesses (salons, dental offices, repair shops) that answers missed calls, qualifies leads, and books appointments. You could MVP this in a weekend with Twilio and an open-source voice model.

**User:** make that into a startup idea

**Agent:**
Target local service businesses. They miss 30-40% of inbound calls. Build a voice agent that picks up, handles FAQs, and books directly into their calendar. Charge $99/month per location. Start with one vertical (dentists or salons), nail the script, then expand.

**User:** what should I build this weekend?

**Agent:**
Strip it down. Build a demo that answers one phone number, handles three FAQs, and books a fake appointment. Record a 60-second Loom of it working. That's your landing page content and your proof of concept in one weekend.

## Core User Flow

1. User sends a message ("good morning," "anything new in AI?," "give me a project idea")
2. Agent detects intent: daily briefing, topic-specific update, build idea, or follow-up
3. Agent returns a concise, structured, opinionated response
4. User continues naturally ("give me another one," "make that more technical," "which one is easiest to build?," "give me a weekend MVP version")

## Personalization

The agent learns and remembers:

- Favorite topics (AI, crypto, devtools, cybersecurity, consumer apps)
- Skill level and context
- Whether the user prefers startup ideas, side projects, or hackathon concepts
- Brief vs. deep explanations
- Time of day patterns (morning briefing vs. evening summary)

## MVP Scope

- Receive and parse user text input via iMessage (using Photon's imessage-kit)
- Detect request type: daily briefing, topic query, build idea, follow-up
- Pull high-signal tech updates from curated sources
- Generate structured, opinionated responses with a build idea attached
- Support multi-turn follow-up conversations
- Store user preferences and conversation context across sessions

## Why This Fits the Challenge

**Personal utility:** This is something I would actually text every morning. Not hypothetically. I already manually do a version of this by scrolling X and newsletters. This automates and improves the process.

**Conversation-native:** The entire product is text. No dashboard, no extra UI. You ask a question, get a useful answer, and keep the conversation going naturally. It works the way iMessage already works.

**Explainable to a friend in one sentence:** "It's an iMessage agent that texts you the latest important tech, tells you why it matters, and gives you something you could build with it."

## Stretch Goals

- Watch the user's GitHub activity and proactively text when a new tool or library drops that's relevant to their current project
- Let the user say "save this" to bookmark an idea, then text a weekly recap of saved ideas
- Topic-based deep dives on demand ("tell me everything about the new OpenAI agent framework")

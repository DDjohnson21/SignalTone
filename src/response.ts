import { callChat } from "./llm.js";
import type { ClassifiedIntent } from "./intent.js";
import type { UserProfile, ConversationTurn } from "./db.js";
import type { SourceItem } from "./sources.js";

export function buildOnboardingResponse(intent: ClassifiedIntent): string {
  const topics = intent.extracted_topics && intent.extracted_topics.length > 0
    ? intent.extracted_topics.join(", ")
    : "all tech";

  return `Got it — I'll focus on ${topics}. If you want to change this later, just tell me your interests.

What would you like to know about today?`;
}

// ─── System prompt (Section 7.1) ─────────────────────────────────────────────

function buildSystemPrompt(user: UserProfile, recentHistory: ConversationTurn[]): string {
  const topics =
    user.topics.length > 0 ? user.topics.join(", ") : "general tech";

  const recentContext = recentHistory
    .slice(-3)
    .map((t) => `${t.role}: ${t.content.slice(0, 300)}`)
    .join("\n");

  return `You are SignalTone, a tech scout for builders. You are opinionated, concise,
and action-oriented. Every response should make the reader want to build something.

User profile:
- Topics: ${topics}
- Skill level: ${user.skill_level}
- Preference: ${user.response_style} (brief / detailed)
- Recent conversation context: ${recentContext || "none"}

Rules:
- No fluff. Lead with the signal.
- Every update must include: what happened, why it matters, use cases, and a build idea.
- Have a point of view. Say what most people are missing.
- Keep responses under 200 words unless the user asks for more.
- Use plain conversational language, not bullet headers.
- This is iMessage. Keep it tight. No one reads essays in a text thread.
- Never include URLs, links, or domain names (e.g. z.ai, arxiv.org) in your response. They create separate preview bubbles in iMessage. Refer to sources by name only.`;
}

// ─── Per-intent user turn ─────────────────────────────────────────────────────

function formatSourceContext(items: SourceItem[]): string {
  if (items.length === 0) return "(no source data available — use your knowledge of recent tech trends)";

  return items
    .slice(0, 6)
    .map((item) => {
      const age = Math.round((Date.now() - item.publishedAt.getTime()) / 3600000);
      const ageStr = age < 1 ? "< 1h ago" : `${age}h ago`;
      return `[${item.source}] ${item.title} — ${item.url} (${ageStr}, score: ${item.score})`;
    })
    .join("\n");
}

function buildUserTurn(
  intent: ClassifiedIntent,
  items: SourceItem[],
  savedIdeas?: string[]
): string {
  const src = formatSourceContext(items);
  const mods = intent.modifiers?.join(", ") || "";

  switch (intent.intent) {
    case "daily_briefing":
      return `Morning briefing. Based on these updates:
${src}

Pick 1–3 of the most interesting items. For each, give: what happened, why it matters, a real use case, and a concrete build idea. ${mods ? `Modifiers: ${mods}.` : ""}`;

    case "evening_summary":
      return `Evening summary. Based on:
${src}

Write a 3–5 sentence executive recap of what moved today in tech. Focus on the most notable shifts. No build ideas unless one is too good to leave out.`;

    case "topic_query":
      return `User is asking about: ${intent.topic || "tech"}
Relevant updates:
${src}

Focus on ${intent.topic || "the most relevant item"}. Give the four-part structure (what happened, why it matters, use cases, build idea). ${mods ? `Modifiers: ${mods}.` : ""}`;

    case "build_idea":
      return `User wants build ideas. Recent trends:
${src}

Generate 1–3 concrete build ideas rooted in actual things that just happened. For each: what to build, why now (connect it to the trend), and what the simplest weekend MVP looks like. Be specific — no vague generalities.${mods ? ` Modifiers: ${mods}.` : ""}`;

    case "follow_up":
      return `The user is following up on the previous response.
Modifiers: ${mods || "expand on it"}.
Refine or expand based on the prior context. Don't repeat yourself — add new angles, more technical depth, or a narrowed application.`;

    case "preference_update":
      return `The user updated their preference:
Key: ${intent.preference_key ?? "unknown"}
Value: ${intent.preference_value ?? "unknown"}

Confirm the change in 1–2 sentences. Acknowledge you'll adjust future responses accordingly. Keep it conversational.`;

    case "save":
      return `The user said "save this". Confirm you've saved the last idea with a single-line summary of what was saved. Keep it under 30 words.`;

    case "recall": {
      if (savedIdeas && savedIdeas.length > 0) {
        const list = savedIdeas
          .slice(0, 10)
          .map((idea, i) => `${i + 1}. ${idea.slice(0, 150)}`)
          .join("\n");
        return `Show the user their saved ideas:\n${list}`;
      }
      return `The user asked to see their saved ideas, but they have none yet. Let them know and suggest saying "save this" after any response they want to keep.`;
    }

    case "reminder":
      return `The user set a reminder with time: "${intent.time_expression ?? "later"}". Confirm it in one conversational sentence. Example: "Got it — I'll ping you in 2 hours." Don't add anything else.`;

    case "opportunity_query":
      return `User wants to know what is worth building right now. Recent signals:
${src}

Identify the strongest signal. Explain what most people are missing and whether it is actually worth building on. Be opinionated.${mods ? ` Modifiers: ${mods}.` : ""}`;

    case "repo_status":
      return `The user asked about their repos. This response is generated by the system — keep it brief and clear.`;

    case "refine_build":
      return `The user wants to iterate on their most recent repo.
Refinement request: "${mods || "make it better"}"
Look at the prior context and suggest the specific changes. Be concrete — name the files and what to change.`;

    case "build_this":
      return `The user wants to build something. Acknowledge you are on it. One sentence max.`;

    default:
      return `Give a quick tech briefing based on:\n${src}`;
  }
}

// ─── URL stripping (exported for use in build result messages) ───────────────

export function stripUrls(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\b\w[\w-]*\.\w{2,}(?:\/\S*)?\b/g, (match) => {
      const tlds = /\.(ai|io|com|org|net|dev|app|co|gov|edu|uk|so|xyz|sh)(?:\/|$)/i;
      return tlds.test(match) ? "" : match;
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function generateResponse(
  intent: ClassifiedIntent,
  user: UserProfile,
  recentHistory: ConversationTurn[],
  sourceItems: SourceItem[],
  savedIdeas?: string[]
): Promise<string> {
  // Handle onboarding intent separately
  if (intent.intent === "onboarding") {
    return buildOnboardingResponse(intent);
  }

  const system = buildSystemPrompt(user, recentHistory);
  const userTurn = buildUserTurn(intent, sourceItems, savedIdeas);

  const text = await callChat(system, userTurn, 1024);
  if (!text) return "Something went wrong generating a response. Try again?";

  return stripUrls(text);
}

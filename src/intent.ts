import { callStructured } from "./llm.js";
import type { ConversationTurn } from "./db.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type IntentType =
  | "daily_briefing"
  | "evening_summary"
  | "topic_query"
  | "build_idea"
  | "follow_up"
  | "preference_update"
  | "save"
  | "recall"
  | "reminder"
  | "onboarding";

export interface ClassifiedIntent {
  intent: IntentType;
  topic?: string;
  modifiers?: string[];
  references_previous?: boolean;
  preference_key?: string;
  preference_value?: string;
  time_expression?: string;
  extracted_topics?: string[];
}

// ─── JSON schema for structured output ───────────────────────────────────────

const INTENT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    intent: {
      type: "string",
      enum: [
        "daily_briefing",
        "evening_summary",
        "topic_query",
        "build_idea",
        "follow_up",
        "preference_update",
        "save",
        "recall",
        "reminder",
        "onboarding",
      ],
    },
    topic:               { type: ["string", "null"] },
    modifiers:           { type: ["array", "null"], items: { type: "string" } },
    references_previous: { type: ["boolean", "null"] },
    preference_key:      { type: ["string", "null"] },
    preference_value:    { type: ["string", "null"] },
    time_expression:     { type: ["string", "null"] },
    extracted_topics:    { type: ["array", "null"], items: { type: "string" } },
  },
  // OpenAI strict mode requires all properties in required; use ["type","null"] for optional fields.
  required: ["intent", "topic", "modifiers", "references_previous", "preference_key", "preference_value", "time_expression", "extracted_topics"],
  additionalProperties: false,
};

const CLASSIFICATION_SYSTEM = `Classify incoming iMessage text into exactly one intent.

Intent definitions:
- daily_briefing: morning greetings, "what should I know today?", "good morning", "what's up today?"
- evening_summary: "good night", "wrap up today", "what happened today?", "evening update"
- topic_query: asking about a specific tech domain ("anything new in AI?", "what's happening in crypto?", "show me devtools news", "whats new", "whats new?")
- build_idea: asking for project/startup ideas ("what should I build?", "give me startup ideas", "what can I build this weekend?", "build?")
- follow_up: refining or expanding the immediately previous response ("make that more technical", "turn that into a startup idea", "give me more detail", "simplify that")
- preference_update: user is changing their profile ("I'm interested in devtools", "keep it brief", "I'm a senior engineer", "focus on AI stuff")
- save: saving the last response/idea ("save this", "bookmark that", "save that idea")
- recall: retrieving saved items ("what did I save?", "show me my ideas", "my saved ideas")
- reminder: user wants a reminder in the future ("remind me in 2 hours", "remind me at 5pm", "send me this tonight")
- onboarding: user responding to the onboarding question with topic preferences (e.g., "AI and devtools", "mostly crypto", "all tech", "I like cybersecurity and mobile")

For topic_query, extract the topic (e.g., "AI", "crypto", "devtools", "web3").
For reminder, extract time_expression (e.g. "2 hours", "5pm", "tonight").
For preference_update, extract preference_key (topics|skill_level|response_style) and preference_value.
For onboarding, extract extracted_topics as an array of topic strings from the user's response.
For follow_up or build_idea with refinements, set references_previous: true.
For modifiers: capture words like "brief", "technical", "simple", "detailed", "startup", "weekend", "quick".`;

// ─── Main export ─────────────────────────────────────────────────────────────

export async function classifyIntent(
  text: string,
  conversationHistory: ConversationTurn[]
): Promise<ClassifiedIntent> {
  const recentContext = conversationHistory
    .slice(-3)
    .map((t) => `${t.role}: ${t.content.slice(0, 200)}`)
    .join("\n");

  const userContent = recentContext
    ? `Recent conversation:\n${recentContext}\n\nNew message to classify: "${text}"`
    : `Message to classify: "${text}"`;

  try {
    const raw = await callStructured(CLASSIFICATION_SYSTEM, userContent, INTENT_SCHEMA, 256);
    return JSON.parse(raw) as ClassifiedIntent;
  } catch (err) {
    console.error("Intent classification error:", err);
    return fallback(text);
  }
}

/** Simple heuristic fallback if the LLM call fails. */
function fallback(text: string): ClassifiedIntent {
  const t = text.toLowerCase();
  if (t.includes("morning") || t.includes("good morning")) return { intent: "daily_briefing", topic: null, modifiers: [], references_previous: false, preference_key: null, preference_value: null, time_expression: null, extracted_topics: [] };
  if (t.includes("night") || t.includes("evening")) return { intent: "evening_summary", topic: null, modifiers: [], references_previous: false, preference_key: null, preference_value: null, time_expression: null, extracted_topics: [] };
  if (t === "build?" || t.includes("build") || t.includes("startup") || t.includes("idea")) return { intent: "build_idea", topic: null, modifiers: [], references_previous: false, preference_key: null, preference_value: null, time_expression: null, extracted_topics: [] };
  if (t === "whats new" || t === "whats new?") return { intent: "topic_query", topic: null, modifiers: [], references_previous: false, preference_key: null, preference_value: null, time_expression: null, extracted_topics: [] };
  if (t.includes("save") || t.includes("bookmark")) return { intent: "save", topic: null, modifiers: [], references_previous: false, preference_key: null, preference_value: null, time_expression: null, extracted_topics: [] };
  if (t.includes("saved") || t.includes("recall") || t.includes("my ideas")) return { intent: "recall", topic: null, modifiers: [], references_previous: false, preference_key: null, preference_value: null, time_expression: null, extracted_topics: [] };
  if (t.includes("remind")) return { intent: "reminder", topic: null, modifiers: [], references_previous: false, preference_key: null, preference_value: null, time_expression: null, extracted_topics: [] };
  // Onboarding fallback: if user mentions tech topics, extract them
  const topicKeywords = ["ai", "devtools", "crypto", "cybersecurity", "mobile", "cloud", "web3", "machine learning", "software"];
  const foundTopics = topicKeywords.filter((kw) => t.includes(kw));
  if (foundTopics.length > 0) {
    return { intent: "onboarding", topic: null, modifiers: [], references_previous: false, preference_key: null, preference_value: null, time_expression: null, extracted_topics: foundTopics };
  }
  return { intent: "daily_briefing", topic: null, modifiers: [], references_previous: false, preference_key: null, preference_value: null, time_expression: null, extracted_topics: [] };
}

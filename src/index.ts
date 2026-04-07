/**
 * SignalTone — iMessage-native tech briefing agent
 * Entry point: boots the imessage-kit watcher and wires together
 * intent classification, source fetching, response generation, and SQLite memory.
 */

import { IMessageSDK } from "@photon-ai/imessage-kit";
import { llmConfig } from "./llm.js";
import { classifyIntent } from "./intent.js";
import { getTopItems } from "./sources.js";
import { generateResponse } from "./response.js";
import {
  getOrCreateUser,
  updateUserLastActive,
  updateUserProfile,
  addConversationTurn,
  getRecentConversation,
  saveIdea,
  getSavedIdeas,
} from "./db.js";

// ─── Boot ─────────────────────────────────────────────────────────────────────

// Validate that the required API key for the active provider is present
if (llmConfig.provider === "openai") {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Error: LLM_PROVIDER=openai but OPENAI_API_KEY is not set.");
    process.exit(1);
  }
} else {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Error: ANTHROPIC_API_KEY is not set. Copy .env.example to .env and fill it in.");
    process.exit(1);
  }
}

console.log(`LLM provider: ${llmConfig.provider} (${llmConfig.model})`);

const sdk = new IMessageSDK({ debug: process.env.DEBUG === "true" });

console.log("SignalTone starting — waiting for iMessages...");

// ─── Message handler ──────────────────────────────────────────────────────────

async function handleMessage(sender: string, text: string): Promise<void> {
  const t0 = Date.now();

  // 1. Ensure user exists in DB; bump last_active
  const user = getOrCreateUser(sender);
  updateUserLastActive(sender);

  // 2. Load recent conversation for context (last 5 turns per Section 9.2)
  const history = getRecentConversation(sender, 5);

  // 3. Classify intent — single LLM call returning structured JSON
  const intent = await classifyIntent(text, history);
  console.log(`[${sender}] intent=${intent.intent}${intent.topic ? ` topic=${intent.topic}` : ""}`);

  // 4. Apply preference updates immediately so response generation sees them
  if (intent.intent === "preference_update" && intent.preference_key) {
    const key = intent.preference_key;
    const val = intent.preference_value ?? "";

    if (key === "topics") {
      updateUserProfile(sender, {
        topics: val.split(",").map((t) => t.trim()).filter(Boolean),
      });
    } else if (key === "response_style") {
      const style = val.toLowerCase().includes("brief") ? "brief" : "detailed";
      updateUserProfile(sender, { response_style: style });
    } else if (key === "skill_level") {
      updateUserProfile(sender, { skill_level: val });
    }
  }

  // 5. Fetch source items for content-driven intents
  const needsSources = [
    "daily_briefing",
    "evening_summary",
    "topic_query",
    "build_idea",
  ].includes(intent.intent);

  const sourceItems = needsSources
    ? await getTopItems(intent.topic)
    : [];

  // 6. Pull saved ideas for recall intent
  const savedIdeas =
    intent.intent === "recall"
      ? getSavedIdeas(sender).map((i) => i.idea_text)
      : undefined;

  // 7. Re-fetch user (may have been updated by preference step)
  const freshUser = getOrCreateUser(sender);

  // 8. Generate response
  const response = await generateResponse(
    intent,
    freshUser,
    history,
    sourceItems,
    savedIdeas
  );

  // 9. Handle "save" — persist the last agent message as a saved idea
  if (intent.intent === "save") {
    const lastAgentTurn = [...history].reverse().find((h) => h.role === "agent");
    if (lastAgentTurn) {
      saveIdea(sender, lastAgentTurn.content.slice(0, 600));
    }
  }

  // 10. Send reply via iMessage
  await sdk.send(sender, response);

  // 11. Persist both turns to conversation log
  addConversationTurn(sender, "user", text, intent.intent);
  addConversationTurn(sender, "agent", response, intent.intent);

  const elapsed = Date.now() - t0;
  console.log(`[${sender}] responded in ${elapsed}ms (${response.length} chars)`);
}

// ─── SDK watcher ──────────────────────────────────────────────────────────────

await sdk.startWatching({
  onDirectMessage: async (msg) => {
    await sdk
      .message(msg)
      .ifFromOthers()      // ignore own messages echoed back
      .ifNotReaction()     // ignore tapbacks / emoji reactions
      .when(async (m) => {
        const sender = m.sender;
        const text = (m.text ?? "").trim();

        if (!text) return; // skip empty messages (e.g. image-only)

        try {
          await handleMessage(sender, text);
        } catch (err) {
          console.error(`Error handling message from ${sender}:`, err);

          // Best-effort error reply so the user isn't left hanging
          try {
            await sdk.send(
              sender,
              "Something went wrong on my end. Give me a moment and try again."
            );
          } catch (sendErr) {
            console.error("Failed to send error reply:", sendErr);
          }
        }
      })
      .execute();
  },

  onError: (error) => {
    console.error("iMessage watcher error:", error);
  },
});

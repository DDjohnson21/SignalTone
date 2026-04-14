/**
 * SignalTone — iMessage-native tech briefing agent
 * Entry point: boots the imessage-kit watcher and wires together
 * intent classification, source fetching, response generation, and SQLite memory.
 */

import { IMessageSDK, Reminders } from "@photon-ai/imessage-kit";
import { writeFileSync, readFileSync, unlinkSync } from "fs";
import { llmConfig } from "./llm.js";

// ─── Single-instance lock ─────────────────────────────────────────────────────
const LOCK_FILE = "/tmp/signaltone.lock";
try {
  const existing = readFileSync(LOCK_FILE, "utf8").trim();
  try {
    process.kill(Number(existing), 0); // check if PID is still alive
    console.error(`SignalTone is already running (PID ${existing}). Exiting.`);
    process.exit(1);
  } catch {
    // Stale lock — previous process is gone, continue
  }
} catch {
  // Lock file doesn't exist — first instance
}
writeFileSync(LOCK_FILE, String(process.pid));
process.on("exit", () => { try { unlinkSync(LOCK_FILE); } catch {} });
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
import { classifyIntent } from "./intent.js";
import { getTopItems } from "./sources.js";
import { generateResponse } from "./response.js";
import { startBriefingScheduler } from "./scheduler.js";
import {
  getOrCreateUser,
  updateUserLastActive,
  updateUserProfile,
  addConversationTurn,
  getRecentConversation,
  saveIdea,
  getSavedIdeas,
  getRecentSentUrls,
  getTopicAffinity,
  bumpTopicAffinity,
  logSentUpdate,
  getRecentSentTopics,
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
const reminders = new Reminders(sdk);
startBriefingScheduler(sdk);

console.log("SignalTone starting — waiting for iMessages...");

// ─── Concurrency guard ───────────────────────────────────────────────────────

// Only process messages that arrived after this process started.
// This prevents the SDK's 10-second lookback from replaying old messages.
const BOOT_TIME = Date.now();

// inProgress: synchronous per-sender lock so only one message per sender
//   is handled at a time.
// agentSent: content of messages the agent sent — used to ignore its own
//   echoes now that ifFromOthers() is removed.
// processedMessages: dedup by (timestamp + text) so the same physical message
//   reaching us via two different handles (phone number vs Apple ID) is only
//   handled once. Entries expire after 5 minutes.
const inProgress = new Set<string>();
const agentSent = new Set<string>();
const processedMessages = new Set<string>();

// ─── Message handler ──────────────────────────────────────────────────────────

async function handleMessage(sender: string, text: string): Promise<void> {
  if (inProgress.has(sender)) {
    console.log(`[${sender}] Skipped — already processing`);
    return;
  }
  inProgress.add(sender);

  try {

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

  const seenUrls = getRecentSentUrls(sender, 48);
  const recentTopics = getRecentSentTopics(sender, 48);
  const sourceItems = needsSources
    ? await getTopItems(intent.topic, 8, seenUrls, recentTopics)
    : [];

  // Re-rank by user's topic affinity
  if (sourceItems.length > 0) {
    const affinity = getTopicAffinity(sender);
    sourceItems.sort((a, b) => {
      const aBoost = a.topic ? (affinity[a.topic.toLowerCase()] ?? 0) : 0;
      const bBoost = b.topic ? (affinity[b.topic.toLowerCase()] ?? 0) : 0;
      return bBoost - aBoost;
    });
  }

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

  // Handle reminder intent
  if (intent.intent === "reminder" && intent.time_expression) {
    try {
      reminders.in(intent.time_expression, sender, "SignalTone reminder — what did you want to revisit?");
    } catch (err) {
      console.warn("[Reminders] Failed to schedule reminder:", err);
    }
  }

  // 10. Send reply via iMessage — register content so the watcher ignores the echo
  agentSent.add(response);
  setTimeout(() => agentSent.delete(response), 30_000);
  await sdk.send(sender, response);

  // Log sent source URLs for dedup
  for (const item of sourceItems.slice(0, 3)) {
    logSentUpdate(sender, item.url, item.topic);
  }

  // Bump topic affinity on engagement
  if (intent.topic && ["topic_query", "follow_up"].includes(intent.intent)) {
    bumpTopicAffinity(sender, intent.topic);
  }

  // 11. Persist both turns to conversation log
  addConversationTurn(sender, "user", text, intent.intent);
  addConversationTurn(sender, "agent", response, intent.intent);

  const elapsed = Date.now() - t0;
  console.log(`[${sender}] responded in ${elapsed}ms (${response.length} chars)`);
  } finally {
    inProgress.delete(sender);
  }
}

// ─── SDK watcher ──────────────────────────────────────────────────────────────

await sdk.startWatching({
  onDirectMessage: async (msg) => {
    await sdk
      .message(msg)
      .ifNotReaction() // ignore tapbacks / emoji reactions
      .when((m) => {
        const text = (m.text ?? "").trim();
        const msgTime = m.date instanceof Date ? m.date.getTime() : 0;

        if (!text) return false;
        if (msgTime < BOOT_TIME) return false;
        if (agentSent.has(text)) return false;

        const msgKey = `${msgTime}:${text}`;
        if (processedMessages.has(msgKey)) {
          console.log(`[${m.sender}] Skipped — duplicate handle for same message`);
          return false;
        }
        processedMessages.add(msgKey);
        setTimeout(() => processedMessages.delete(msgKey), 300_000);
        return true;
      })
      .do(async (m) => {
        const sender = m.sender;
        const text = (m.text ?? "").trim();
        try {
          await handleMessage(sender, text);
        } catch (err) {
          console.error(`Error handling message from ${sender}:`, err);

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

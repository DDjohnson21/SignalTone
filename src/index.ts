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
import { generateResponse, buildOnboardingResponse, stripUrls } from "./response.js";
import { startBriefingScheduler } from "./scheduler.js";
import { runCommittee } from "./committee.js";
import { buildOpportunity } from "./builder.js";
import { hasGitHubToken } from "./github.js";
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
  isNewUser,
  saveOpportunity,
  getLastOpportunity,
  getRepositories,
} from "./db.js";
import type { CommitteeOutput } from "./committee.js";

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

// ─── Async build runner (fires after handleMessage returns) ──────────────────

async function runBuildAsync(
  sender: string,
  opportunity: CommitteeOutput,
  opportunityDbId: number | null
): Promise<void> {
  try {
    const result = await buildOpportunity(sender, opportunity, opportunityDbId);
    const summary =
      `Scaffolded ${result.repoFullName}. ` +
      `${result.issueCount} issues seeded. ` +
      (result.prUrl ? "Draft PR is open." : "") +
      "\n\n" +
      opportunity.editor_reply;
    // Repo URL is intentionally included — it's the point of the message.
    await sdk.send(sender, summary.trim());
    addConversationTurn(sender, "agent", summary, "build_this");
  } catch (err) {
    console.error("[Build] Failed:", err);
    const errMsg = "Build failed — check your GITHUB_TOKEN or try again.";
    await sdk.send(sender, errMsg);
    addConversationTurn(sender, "agent", errMsg, "build_this");
  }
}

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

  // 1. Check if this is a new user — if so, ask onboarding question first
  const newUser = isNewUser(sender);
  if (newUser) {
    console.log(`[${sender}] New user detected — running onboarding`);
    agentSent.add(text);
    setTimeout(() => agentSent.delete(text), 30_000);
    await sdk.send(
      sender,
      "Hey! I'm SignalTone, your tech briefing agent. To make my responses more useful, " +
      "what topics should I focus on? (e.g. AI, devtools, crypto, cybersecurity, mobile, cloud) " +
      "Just reply with 1-3 interests, or say 'all tech' for a broad feed."
    );
    addConversationTurn(sender, "user", text, "onboarding");
    addConversationTurn(sender, "agent", "onboarding_question", "onboarding");
    return;
  }

  // 2. Ensure user exists in DB; bump last_active
  const user = getOrCreateUser(sender);
  updateUserLastActive(sender);

  // 3. Load recent conversation for context (last 5 turns per Section 9.2)
  const history = getRecentConversation(sender, 5);

  // 4. Classify intent — single LLM call returning structured JSON
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

  // Handle onboarding — extract and save topics from user's response
  if (intent.intent === "onboarding" && intent.extracted_topics && intent.extracted_topics.length > 0) {
    updateUserProfile(sender, { topics: intent.extracted_topics });
    console.log(`[${sender}] Onboarding topics saved: ${intent.extracted_topics.join(", ")}`);
  }

  // 5. Fetch source items for content-driven intents
  const needsSources = [
    "daily_briefing",
    "evening_summary",
    "topic_query",
    "build_idea",
    "opportunity_query",
    "build_this",
  ].includes(intent.intent);

  // Skip sources for onboarding responses
  if (intent.intent === "onboarding") {
    const response = buildOnboardingResponse(intent);
    agentSent.add(response);
    setTimeout(() => agentSent.delete(response), 30_000);
    await sdk.send(sender, response);
    addConversationTurn(sender, "user", text, intent.intent);
    addConversationTurn(sender, "agent", response, intent.intent);
    console.log(`[${sender}] responded in ${Date.now() - t0}ms (${response.length} chars)`);
    return;
  }

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

  // ── Opportunity Committee intents ──────────────────────────────────────────

  if (intent.intent === "opportunity_query") {
    const committee = await runCommittee(sourceItems, freshUser, intent.topic ?? undefined);
    if (!committee) {
      const fallback = "Couldn't run the committee right now. Try again in a moment.";
      await sdk.send(sender, fallback);
      addConversationTurn(sender, "user", text, intent.intent);
      addConversationTurn(sender, "agent", fallback, intent.intent);
      return;
    }

    const opportunityDbId = saveOpportunity(sender, {
      signal: committee.signal,
      why_now: committee.why_now,
      best_use_case: committee.best_use_case,
      project_type: committee.project_type,
      verdict: committee.verdict,
      risk: committee.risk,
      repo_name: committee.first_repo.name,
      repo_goal: committee.first_repo.goal,
      editor_reply: committee.editor_reply,
    });
    console.log(`[${sender}] Saved opportunity #${opportunityDbId}: ${committee.verdict}`);

    const reply = stripUrls(committee.editor_reply);
    agentSent.add(reply);
    setTimeout(() => agentSent.delete(reply), 30_000);
    await sdk.send(sender, reply);
    addConversationTurn(sender, "user", text, intent.intent);
    addConversationTurn(sender, "agent", reply, intent.intent);
    console.log(`[${sender}] responded in ${Date.now() - t0}ms`);
    return;
  }

  if (intent.intent === "build_this") {
    if (!hasGitHubToken()) {
      const noToken = "Set GITHUB_TOKEN in your .env to enable repo scaffolding.";
      await sdk.send(sender, noToken);
      addConversationTurn(sender, "user", text, intent.intent);
      addConversationTurn(sender, "agent", noToken, intent.intent);
      return;
    }

    // Use the most recent opportunity if it was saved in the last 30 minutes,
    // otherwise run the committee fresh.
    let committee: CommitteeOutput | null = null;
    let opportunityDbId: number | null = null;

    const lastOpp = getLastOpportunity(sender);
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
    if (lastOpp && new Date(lastOpp.created_at) > thirtyMinAgo) {
      committee = {
        signal: lastOpp.signal,
        why_now: lastOpp.why_now,
        best_use_case: lastOpp.best_use_case,
        project_type: lastOpp.project_type as CommitteeOutput["project_type"],
        verdict: lastOpp.verdict as CommitteeOutput["verdict"],
        risk: lastOpp.risk,
        first_repo: {
          name: lastOpp.repo_name ?? "new-project",
          goal: lastOpp.repo_goal ?? "Build something useful",
          description: lastOpp.best_use_case,
          tech_stack: ["TypeScript"],
        },
        editor_reply: lastOpp.editor_reply,
      };
      opportunityDbId = lastOpp.id;
    } else {
      committee = await runCommittee(sourceItems, freshUser, intent.topic ?? undefined);
      if (committee) {
        opportunityDbId = saveOpportunity(sender, {
          signal: committee.signal,
          why_now: committee.why_now,
          best_use_case: committee.best_use_case,
          project_type: committee.project_type,
          verdict: committee.verdict,
          risk: committee.risk,
          repo_name: committee.first_repo.name,
          repo_goal: committee.first_repo.goal,
          editor_reply: committee.editor_reply,
        });
      }
    }

    if (!committee) {
      const fallback = "Couldn't find a strong build opportunity right now. Ask for an opportunity first.";
      await sdk.send(sender, fallback);
      addConversationTurn(sender, "user", text, intent.intent);
      addConversationTurn(sender, "agent", fallback, intent.intent);
      return;
    }

    const ack = `On it — scaffolding ${committee.first_repo.name}. I'll text you when it's ready.`;
    agentSent.add(ack);
    setTimeout(() => agentSent.delete(ack), 30_000);
    await sdk.send(sender, ack);
    addConversationTurn(sender, "user", text, intent.intent);
    addConversationTurn(sender, "agent", ack, intent.intent);

    // Fire the build — do not await so the inProgress lock is released.
    const committeeSnapshot = committee;
    const oppIdSnapshot = opportunityDbId;
    void runBuildAsync(sender, committeeSnapshot, oppIdSnapshot);

    console.log(`[${sender}] Build started for ${committee.first_repo.name}`);
    return;
  }

  if (intent.intent === "repo_status") {
    const repos = getRepositories(sender);
    let reply: string;
    if (repos.length === 0) {
      reply = "Nothing scaffolded yet. Ask for an opportunity and say \"build it\" to create your first repo.";
    } else {
      const list = repos
        .slice(0, 5)
        .map((r, i) => `${i + 1}. ${r.repo_name} — ${r.repo_url}`)
        .join("\n");
      reply = `Repos scaffolded (${repos.length}):\n${list}`;
    }
    agentSent.add(reply);
    setTimeout(() => agentSent.delete(reply), 30_000);
    await sdk.send(sender, reply);
    addConversationTurn(sender, "user", text, intent.intent);
    addConversationTurn(sender, "agent", reply, intent.intent);
    console.log(`[${sender}] responded in ${Date.now() - t0}ms`);
    return;
  }

  if (intent.intent === "refine_build") {
    const repos = getRepositories(sender);
    if (repos.length === 0) {
      const noRepo = "No repos yet. Build something first — say \"build it\" after seeing an opportunity.";
      await sdk.send(sender, noRepo);
      addConversationTurn(sender, "user", text, intent.intent);
      addConversationTurn(sender, "agent", noRepo, intent.intent);
      return;
    }
    const latestRepo = repos[0];
    // Treat as a follow_up with repo context injected into the prompt
    const refinedIntent = { ...intent, intent: "follow_up" as const };
    const refinedHistory = [
      ...history,
      {
        id: -1,
        phone_id: sender,
        role: "agent",
        content: `Current repo: ${latestRepo.repo_name} (${latestRepo.repo_url})`,
        intent: "repo_status",
        created_at: new Date().toISOString(),
      },
    ];
    const response = await generateResponse(refinedIntent, freshUser, refinedHistory, sourceItems);
    const cleaned = stripUrls(response);
    agentSent.add(cleaned);
    setTimeout(() => agentSent.delete(cleaned), 30_000);
    await sdk.send(sender, cleaned);
    addConversationTurn(sender, "user", text, intent.intent);
    addConversationTurn(sender, "agent", cleaned, intent.intent);
    console.log(`[${sender}] responded in ${Date.now() - t0}ms`);
    return;
  }

  // ── Standard response path ─────────────────────────────────────────────────

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

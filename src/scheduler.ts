/**
 * Proactive briefing scheduler.
 * Checks every 60s; sends morning briefings at 8:00am and evening summaries at 9:00pm
 * to every known user. Uses the DB to prevent double-sends on the same day.
 */

import type { IMessageSDK } from "@photon-ai/imessage-kit";
import {
  getAllUserIds,
  getOrCreateUser,
  getRecentConversation,
  getRecentSentUrls,
  getRecentSentTopics,
  alreadySentToday,
  recordBriefingLog,
  addConversationTurn,
} from "./db.js";
import { getTopItems } from "./sources.js";
import { generateResponse } from "./response.js";
import type { ClassifiedIntent } from "./intent.js";

const MORNING_HOUR = 8;
const EVENING_HOUR = 21;

async function sendBriefing(
  sdk: IMessageSDK,
  phoneId: string,
  type: "morning" | "evening"
): Promise<void> {
  const intent: ClassifiedIntent =
    type === "morning" ? { intent: "daily_briefing" } : { intent: "evening_summary" };

  const user = getOrCreateUser(phoneId);
  const history = getRecentConversation(phoneId, 5);
  const seenUrls = getRecentSentUrls(phoneId, 48);
  const recentTopics = getRecentSentTopics(phoneId, 48);
  const sourceItems = await getTopItems(undefined, 8, seenUrls, recentTopics);

  const response = await generateResponse(intent, user, history, sourceItems);
  await sdk.send(phoneId, response);
  recordBriefingLog(phoneId, type);
  addConversationTurn(phoneId, "agent", response, intent.intent);
  console.log(`[Scheduler] Sent ${type} briefing to ${phoneId}`);
}

export function startBriefingScheduler(sdk: IMessageSDK): void {
  const handle = setInterval(async () => {
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();

    let type: "morning" | "evening" | null = null;
    if (hour === MORNING_HOUR && minute === 0) type = "morning";
    else if (hour === EVENING_HOUR && minute === 0) type = "evening";
    if (!type) return;

    const userIds = getAllUserIds();
    for (const phoneId of userIds) {
      if (alreadySentToday(phoneId, type)) continue;
      try {
        await sendBriefing(sdk, phoneId, type);
      } catch (err) {
        console.error(`[Scheduler] Failed to send ${type} briefing to ${phoneId}:`, err);
      }
    }
  }, 60_000);

  handle.unref(); // Don't let this timer alone keep the process alive
  console.log("[Scheduler] Proactive briefings active (8:00am morning, 9:00pm evening)");
}

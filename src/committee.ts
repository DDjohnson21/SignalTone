/**
 * Opportunity Committee — the heart of SignalTone.
 *
 * Evaluates whether a technical signal is worth building on by simulating
 * six internal roles: Scout, Skeptic, Builder, Market, Coder, Editor.
 * Returns a structured verdict with a repo spec and iMessage-ready reply.
 */

import { callChat } from "./llm.js";
import type { SourceItem } from "./sources.js";
import type { UserProfile } from "./db.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ProjectType =
  | "open_source_tool"
  | "sdk_wrapper"
  | "integration"
  | "starter_kit"
  | "eval_dashboard"
  | "workflow_tool"
  | "reference_impl";

export type Verdict = "worth_building" | "interesting_but_niche" | "skip";

export interface CommitteeOutput {
  signal: string;
  why_now: string;
  best_use_case: string;
  project_type: ProjectType;
  verdict: Verdict;
  risk: string;
  first_repo: {
    name: string;
    goal: string;
    description: string;
    tech_stack: string[];
  };
  editor_reply: string;
}

// ─── System prompt ────────────────────────────────────────────────────────────

const COMMITTEE_SYSTEM = `You are the SignalTone Opportunity Committee. Evaluate whether a technical signal is worth building on.

Think through these six roles before writing output:

Scout — what launched, the core technical capability, the community reaction
Skeptic — what is overhyped, the real risks, who already solved this, what fails quietly
Builder — the most practical overlooked use case, the simplest useful MVP, the complement gap
Market — should this be a feature, a utility, an OSS tool, or a company wedge?
Coder — what stack, what files, what would the first commit look like?
Editor — compress everything to a tight iMessage reply: what launched, what people are missing, whether to build now

Output ONLY a valid JSON object. No markdown fences. No commentary before or after.

{
  "signal": "one-sentence summary of what launched",
  "why_now": "why this matters specifically for builders right now",
  "best_use_case": "the most practical, non-obvious build opportunity",
  "project_type": "open_source_tool | sdk_wrapper | integration | starter_kit | eval_dashboard | workflow_tool | reference_impl",
  "verdict": "worth_building | interesting_but_niche | skip",
  "risk": "the real risk builders should know before starting",
  "first_repo": {
    "name": "kebab-case-repo-name",
    "goal": "one sentence describing what the project does",
    "description": "two sentence repo description",
    "tech_stack": ["TypeScript", "..."]
  },
  "editor_reply": "iMessage reply, max 150 words, plain text only, no URLs or domain names. Lead with the signal. Say what most people are missing. End with a clear opinion on whether it is worth building now."
}`;

// ─── Main export ─────────────────────────────────────────────────────────────

export async function runCommittee(
  items: SourceItem[],
  user: UserProfile,
  specificSignal?: string
): Promise<CommitteeOutput | null> {
  const signalContext = specificSignal
    ? `User wants to build on this signal: "${specificSignal}"\n\n`
    : "";

  const itemsText =
    items.length > 0
      ? items
          .slice(0, 5)
          .map((i) => `[${i.source}] ${i.title} (score: ${Math.round(i.score)})`)
          .join("\n")
      : "(no recent signals — use your knowledge of recent high-signal tech launches)";

  const userCtx = `User profile: topics=[${user.topics.join(", ") || "general tech"}], skill=${user.skill_level}`;

  const prompt = `${signalContext}${userCtx}

Recent signals:
${itemsText}

Run the committee on the strongest candidate. Output JSON only.`;

  try {
    const raw = await callChat(COMMITTEE_SYSTEM, prompt, 1500);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in committee response");
    return JSON.parse(jsonMatch[0]) as CommitteeOutput;
  } catch (err) {
    console.error("[Committee] Error:", err);
    return null;
  }
}

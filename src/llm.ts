/**
 * LLM provider abstraction.
 * Reads LLM_PROVIDER from env ("anthropic" | "openai") and routes calls
 * to the appropriate SDK. Both providers expose the same two functions:
 *
 *   callStructured(system, user, schema, maxTokens?) → raw JSON string
 *   callChat(system, user, maxTokens?)               → response text
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

// ─── Config ───────────────────────────────────────────────────────────────────

export type Provider = "anthropic" | "openai";

export interface LLMConfig {
  provider: Provider;
  model: string;
}

function resolveConfig(): LLMConfig {
  const raw = (process.env.LLM_PROVIDER ?? "anthropic").toLowerCase().trim();
  const provider: Provider = raw === "openai" ? "openai" : "anthropic";

  if (provider === "openai") {
    return { provider: "openai", model: process.env.OPENAI_MODEL ?? "gpt-4o" };
  }
  return { provider: "anthropic", model: process.env.ANTHROPIC_MODEL ?? "claude-opus-4-6" };
}

export const llmConfig: LLMConfig = resolveConfig();

// ─── Lazy clients ─────────────────────────────────────────────────────────────

let _anthropic: Anthropic | null = null;
let _openai: OpenAI | null = null;

function anthropic(): Anthropic {
  return (_anthropic ??= new Anthropic());
}

function openai(): OpenAI {
  return (_openai ??= new OpenAI());
}

// ─── Structured output (intent classification) ────────────────────────────────

/**
 * Returns the raw JSON string from the model.
 * Both providers guarantee the output matches the supplied JSON schema.
 */
export async function callStructured(
  system: string,
  user: string,
  schema: Record<string, unknown>,
  maxTokens = 256
): Promise<string> {
  if (llmConfig.provider === "openai") {
    const res = await openai().chat.completions.create({
      model: llmConfig.model,
      max_completion_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "structured_output",
          strict: true,
          schema,
        },
      },
    });
    return res.choices[0]?.message?.content ?? "{}";
  }

  // Anthropic
  const res = await anthropic().messages.create({
    model: llmConfig.model,
    max_tokens: maxTokens,
    output_config: {
      format: { type: "json_schema", schema },
    },
    system,
    messages: [{ role: "user", content: user }],
  });
  const block = res.content.find((b) => b.type === "text");
  return block?.type === "text" ? block.text : "{}";
}

// ─── Streaming chat (response generation) ────────────────────────────────────

/**
 * Streams a chat completion and returns the complete text.
 * Streaming is used on both providers to avoid HTTP timeouts on long outputs.
 */
export async function callChat(
  system: string,
  user: string,
  maxTokens = 1024
): Promise<string> {
  if (llmConfig.provider === "openai") {
    const stream = await openai().chat.completions.create({
      model: llmConfig.model,
      max_completion_tokens: maxTokens,
      stream: true,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });

    const chunks: string[] = [];
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) chunks.push(delta);
    }
    return chunks.join("");
  }

  // Anthropic — stream and collect via finalMessage()
  const stream = anthropic().messages.stream({
    model: llmConfig.model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
  });
  const final = await stream.finalMessage();
  const block = final.content.find((b) => b.type === "text");
  return block?.type === "text" ? block.text : "";
}

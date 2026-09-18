import type Anthropic from "@anthropic-ai/sdk";
import { logEvent } from "./logger.js";

const COMPACT_THRESHOLD_TOKENS = 100_000;
const SUMMARY_MODEL = "claude-sonnet-5";

export function shouldCompact(usage: Anthropic.Usage): boolean {
  return usage.input_tokens > COMPACT_THRESHOLD_TOKENS;
}

export async function compact(
  client: Anthropic,
  messages: Anthropic.MessageParam[]
): Promise<Anthropic.MessageParam[]> {
  const summaryResponse = await client.messages.create({
    model: SUMMARY_MODEL,
    max_tokens: 2048,
    messages: [
      ...messages,
      {
        role: "user",
        content:
          "Summarize this conversation so far: what the user asked for, what has been done, key decisions made, and what's still in progress. Be concise but keep anything needed to continue the work correctly.",
      },
    ],
  });

  const summaryText = summaryResponse.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  logEvent("compaction", { originalMessageCount: messages.length, summary: summaryText });

  return [
    {
      role: "user",
      content: `[Earlier conversation summarized to save context]\n\n${summaryText}`,
    },
  ];
}

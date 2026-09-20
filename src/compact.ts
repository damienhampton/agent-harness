import type Anthropic from "@anthropic-ai/sdk";
import { logEvent } from "./logger.js";

const COMPACT_THRESHOLD_TOKENS = 100_000;
const SUMMARY_MODEL = "claude-sonnet-5";
// How many of the most recent messages to keep verbatim across a
// compaction. Everything older than this window gets folded into a single
// summary message; the tail is left untouched so recent, still-relevant
// detail (the precise tool output/edit just made, the exact wording of the
// last few exchanges) survives compaction instead of being lossily
// re-summarized from scratch every time the threshold is hit again.
export const KEEP_LAST_MESSAGES = 10;

export function shouldCompact(usage: Anthropic.Usage): boolean {
  return usage.input_tokens > COMPACT_THRESHOLD_TOKENS;
}

/**
 * Finds the index that splits `messages` into a prefix to summarize and a
 * verbatim tail of (at most) `KEEP_LAST_MESSAGES` messages. Walks forward
 * from the naive `length - KEEP_LAST_MESSAGES` cut point to the next
 * "assistant" message so the tail always starts on an assistant turn: the
 * summarized prefix is replaced by a single synthetic "user" message, and
 * following that with an "assistant" message keeps the strict user/assistant
 * alternation the API requires. Returns `messages.length` (i.e. an empty
 * tail, nothing kept) if no assistant message exists at or after the cut
 * point.
 */
function findSplitIndex(messages: Anthropic.MessageParam[]): number {
  let splitIndex = Math.max(messages.length - KEEP_LAST_MESSAGES, 0);
  while (splitIndex < messages.length && messages[splitIndex].role !== "assistant") {
    splitIndex++;
  }
  return splitIndex;
}

export async function compact(
  client: Anthropic,
  messages: Anthropic.MessageParam[]
): Promise<Anthropic.MessageParam[]> {
  if (messages.length <= KEEP_LAST_MESSAGES) {
    // The whole conversation already fits inside the window -- nothing old
    // enough to fold away, so skip the summary call entirely.
    return messages;
  }

  const splitIndex = findSplitIndex(messages);
  const toSummarize = messages.slice(0, splitIndex);
  const kept = messages.slice(splitIndex);

  if (toSummarize.length === 0) {
    // No assistant message to split on yet (shouldn't normally happen once
    // we're past the length check above, but be defensive) -- leave it as
    // is rather than making a pointless summary call.
    return messages;
  }

  const summaryResponse = await client.messages.create({
    model: SUMMARY_MODEL,
    max_tokens: 2048,
    messages: [
      ...toSummarize,
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

  logEvent("compaction", {
    originalMessageCount: messages.length,
    summarizedMessageCount: toSummarize.length,
    keptMessageCount: kept.length,
    summary: summaryText,
  });

  return [
    {
      role: "user",
      content: `[Earlier conversation summarized to save context]\n\n${summaryText}`,
    },
    ...kept,
  ];
}

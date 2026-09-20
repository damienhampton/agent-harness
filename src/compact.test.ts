import { beforeEach, describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

const createMock = vi.fn();
const fakeClient = { messages: { create: createMock } } as unknown as Anthropic;

const { compact, shouldCompact, KEEP_LAST_MESSAGES } = await import("./compact.js");

function userMsg(text: string): Anthropic.MessageParam {
  return { role: "user", content: text };
}

function assistantMsg(text: string): Anthropic.MessageParam {
  return { role: "assistant", content: text };
}

/** Builds a strictly alternating [user, assistant, user, assistant, ...] history. */
function conversation(turns: number): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];
  for (let i = 0; i < turns; i++) {
    messages.push(userMsg(`user message ${i}`));
    messages.push(assistantMsg(`assistant message ${i}`));
  }
  return messages;
}

function summaryApiResponse(text: string) {
  return { content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 10 } };
}

beforeEach(() => {
  createMock.mockReset();
});

describe("shouldCompact", () => {
  it("is false under the threshold and true over it", () => {
    expect(shouldCompact({ input_tokens: 1000, output_tokens: 0 } as Anthropic.Usage)).toBe(false);
    expect(shouldCompact({ input_tokens: 200_000, output_tokens: 0 } as Anthropic.Usage)).toBe(true);
  });
});

describe("compact (sliding window)", () => {
  it("leaves messages untouched, without calling the API, when there's nothing old enough to summarize", async () => {
    const messages = conversation(2); // 4 messages, well within KEEP_LAST_MESSAGES
    const result = await compact(fakeClient, messages);

    expect(createMock).not.toHaveBeenCalled();
    expect(result).toBe(messages);
  });

  it("summarizes only the prefix beyond the window and keeps the tail verbatim", async () => {
    createMock.mockResolvedValueOnce(summaryApiResponse("summary of the old stuff"));

    // Plenty more messages than KEEP_LAST_MESSAGES so there's a real prefix to fold away.
    const messages = conversation(KEEP_LAST_MESSAGES + 5);

    const result = await compact(fakeClient, messages);

    expect(createMock).toHaveBeenCalledTimes(1);
    // first message is the synthetic summary
    expect(result[0].role).toBe("user");
    expect(result[0].content).toContain("summary of the old stuff");
    // the rest is exactly the kept tail (a verbatim suffix of the original), untouched
    const keptCount = result.length - 1;
    expect(result.slice(1)).toEqual(messages.slice(messages.length - keptCount));
    // and it's meaningfully shorter than the original
    expect(result.length).toBeLessThan(messages.length);
    // roughly the requested window size (may be smaller if the naive cut
    // point had to be nudged forward onto the next assistant message)
    expect(keptCount).toBeLessThanOrEqual(KEEP_LAST_MESSAGES);
  });

  it("keeps the summary+tail alternating on user/assistant, splitting on an assistant message", async () => {
    createMock.mockResolvedValueOnce(summaryApiResponse("summary"));

    const messages = conversation(KEEP_LAST_MESSAGES + 5);
    const result = await compact(fakeClient, messages);

    for (let i = 0; i < result.length; i++) {
      expect(result[i].role).toBe(i % 2 === 0 ? "user" : "assistant");
    }
  });

  it("passes only the prefix being summarized (plus the instruction) to the summary call, not the whole history", async () => {
    createMock.mockResolvedValueOnce(summaryApiResponse("summary"));

    const messages = conversation(KEEP_LAST_MESSAGES + 5);
    const result = await compact(fakeClient, messages);
    const keptTail = result.slice(1); // everything but the synthetic summary message

    const callArgs = createMock.mock.calls[0][0];
    // the kept tail's messages should not have been sent for summarization
    for (const keptMessage of keptTail) {
      expect(
        callArgs.messages.some((m: Anthropic.MessageParam) => m.content === keptMessage.content)
      ).toBe(false);
    }
  });
});

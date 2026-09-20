import Anthropic from "@anthropic-ai/sdk";
import { toolDefs, executeTool, TOOL_RISK } from "./tools.js";
import { logEvent } from "./logger.js";
import { shouldCompact, compact } from "./compact.js";
import { checkApproval, createApprovalState, type ApprovalState, type OnApprovalRequest } from "./approval.js";

const MODEL = "claude-sonnet-5";
const MAX_TOOL_TURNS = 25;
const MAX_TOKENS = 8192;
// The SDK already retries 408/409/429/5xx (incl. `overloaded_error`) with
// exponential backoff + jitter internally; we just need to give it a
// generous budget and make sure that if every retry is exhausted (or the
// error isn't retryable at all, e.g. a network failure), that failure ends
// the current turn gracefully instead of throwing out of runTurn and
// crashing the whole REPL session (see catch around messages.create below).
const MAX_RETRIES = 5;

export type OnText = (text: string) => void;

async function maybeCompact(
  client: Anthropic,
  messages: Anthropic.MessageParam[],
  usage: Anthropic.Usage,
  onText: OnText,
  turn: number
): Promise<void> {
  if (!shouldCompact(usage)) return;
  try {
    const compacted = await compact(client, messages);
    if (compacted === messages) {
      // Nothing old enough to fold away yet (conversation is already
      // shorter than the sliding window) -- compact() made no API call and
      // returned the same array, so there's nothing to report.
      return;
    }
    messages.length = 0;
    messages.push(...compacted);
    onText(`[context window filling up, compacted conversation history]`);
  } catch (err) {
    logEvent("compaction_failed", { turn, error: (err as Error).message });
    onText(`[compaction failed, continuing without it: ${(err as Error).message}]`);
  }
}

/**
 * Runs one user turn to completion: repeatedly calls the model, executes any
 * tool calls, and feeds results back, until the model responds with no tool
 * calls or MAX_TOOL_TURNS is hit. A response truncated by max_tokens (e.g.
 * cut off mid-thinking, with no text or tool_use) is discarded and retried
 * rather than treated as a completed turn. Mutates `messages` in place so
 * callers can keep reusing the same array across turns (interactive mode).
 *
 * `approvalState` is likewise mutated/reused across turns so that
 * session-scoped approvals (and /mode changes in the CLI) persist for the
 * life of a session. `onApprovalRequest` is how the CLI adapter prompts a
 * human; omit it (e.g. no TTY) and anything needing approval is refused
 * rather than hanging.
 *
 * No dependency on process.env/argv/stdio — those belong to the CLI adapter.
 */
export async function runTurn(
  apiKey: string,
  messages: Anthropic.MessageParam[],
  onText: OnText = console.log,
  approvalState: ApprovalState = createApprovalState(),
  onApprovalRequest?: OnApprovalRequest
): Promise<void> {
  const client = new Anthropic({ apiKey, maxRetries: MAX_RETRIES });

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    logEvent("request", { turn, messages });
    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        tools: toolDefs,
        messages,
      });
    } catch (err) {
      // The SDK has already exhausted its own retry/backoff budget (or hit a
      // non-retryable error, e.g. a network failure) by the time we get
      // here. Surface it and end the turn cleanly rather than letting it
      // propagate out of runTurn and take down the whole REPL session.
      logEvent("request_failed", { turn, error: (err as Error).message });
      onText(`[request failed after retries, turn aborted: ${(err as Error).message}]`);
      return;
    }
    logEvent("response", { turn, response });

    if (response.stop_reason === "max_tokens") {
      logEvent("truncated", { turn, contentTypes: response.content.map((b) => b.type) });
      onText(`[response truncated by max_tokens, retrying]`);
      continue;
    }

    messages.push({ role: "assistant", content: response.content });

    for (const block of response.content) {
      if (block.type === "text") {
        onText(block.text);
      }
    }

    const toolUses = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );

    if (toolUses.length === 0) {
      await maybeCompact(client, messages, response.usage, onText, turn);
      return;
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const toolUse of toolUses) {
      const input = toolUse.input as Record<string, unknown>;
      logEvent("tool_call", { turn, tool: toolUse.name, input });

      const risk = TOOL_RISK[toolUse.name] ?? "mutating";
      const approval = await checkApproval(approvalState, toolUse.name, risk, input, onApprovalRequest);
      if (!approval.allowed) {
        logEvent("tool_denied", { turn, tool: toolUse.name, reason: approval.reason });
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: approval.reason ?? "Denied.",
          is_error: true,
        });
        continue;
      }

      const { output, isError } = executeTool(toolUse.name, input);
      logEvent("tool_result", { turn, tool: toolUse.name, output, isError });
      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: output,
        is_error: isError,
      });
    }

    messages.push({ role: "user", content: toolResults });

    await maybeCompact(client, messages, response.usage, onText, turn);
  }

  onText(`[stopped after ${MAX_TOOL_TURNS} tool turns without a final response]`);
}

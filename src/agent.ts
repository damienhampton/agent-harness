import Anthropic from "@anthropic-ai/sdk";
import { toolDefs, executeTool } from "./tools.js";
import { logEvent } from "./logger.js";
import { shouldCompact, compact } from "./compact.js";

const MODEL = "claude-sonnet-5";
const MAX_TOOL_TURNS = 25;
const MAX_TOKENS = 8192;

export type OnText = (text: string) => void;

/**
 * Runs one user turn to completion: repeatedly calls the model, executes any
 * tool calls, and feeds results back, until the model responds with no tool
 * calls or MAX_TOOL_TURNS is hit. A response truncated by max_tokens (e.g.
 * cut off mid-thinking, with no text or tool_use) is discarded and retried
 * rather than treated as a completed turn. Mutates `messages` in place so
 * callers can keep reusing the same array across turns (interactive mode).
 *
 * No dependency on process.env/argv/stdio — those belong to the CLI adapter.
 */
export async function runTurn(apiKey: string, messages: Anthropic.MessageParam[], onText: OnText = console.log): Promise<void> {
  const client = new Anthropic({ apiKey });

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    logEvent("request", { turn, messages });
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      tools: toolDefs,
      messages,
    });
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
      if (shouldCompact(response.usage)) {
        const compacted = await compact(client, messages);
        messages.length = 0;
        messages.push(...compacted);
      }
      return;
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = toolUses.map((toolUse) => {
      logEvent("tool_call", { turn, tool: toolUse.name, input: toolUse.input });
      const { output, isError } = executeTool(toolUse.name, toolUse.input as Record<string, unknown>);
      logEvent("tool_result", { turn, tool: toolUse.name, output, isError });
      return {
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: output,
        is_error: isError,
      };
    });

    messages.push({ role: "user", content: toolResults });
  }

  onText(`[stopped after ${MAX_TOOL_TURNS} tool turns without a final response]`);
}

import Anthropic from "@anthropic-ai/sdk";
import { toolDefs, executeTool } from "./tools.js";
import { logEvent } from "./logger.js";

const MODEL = "claude-sonnet-5";
const MAX_TURNS = 25;

async function main(): Promise<void> {
  const userMessage = process.argv.slice(2).join(" ");
  if (!userMessage) {
    console.error("Usage: npm start -- \"<message>\"");
    process.exit(1);
  }
  const apiKey = process.env.APP_ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("APP_ANTHROPIC_API_KEY is not set.");
    process.exit(1);
  }

  const client = new Anthropic({ apiKey });
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userMessage }];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    logEvent("request", { turn, messages });
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      tools: toolDefs,
      messages,
    });
    logEvent("response", { turn, response });

    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );

    for (const block of response.content) {
      if (block.type === "text") {
        console.log(block.text);
      }
    }

    if (toolUses.length === 0) {
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

  console.error(`Stopped after ${MAX_TURNS} turns without a final response.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

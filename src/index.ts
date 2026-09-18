#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { runTurn } from "./agent.js";

async function main(): Promise<void> {
  const apiKey = process.env.APP_ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("APP_ANTHROPIC_API_KEY is not set.");
    process.exit(1);
  }

  const messages: Anthropic.MessageParam[] = [];
  const oneShotMessage = process.argv.slice(2).join(" ");

  if (oneShotMessage) {
    messages.push({ role: "user", content: oneShotMessage });
    await runTurn(apiKey, messages, console.log);
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log("Interactive mode. Type /exit or press Ctrl+D to quit.");
  while (true) {
    let line: string;
    try {
      line = await rl.question("> ");
    } catch {
      break; // stdin closed (e.g. Ctrl+D)
    }
    if (line.trim() === "/exit") break;
    if (!line.trim()) continue;
    messages.push({ role: "user", content: line });
    await runTurn(apiKey, messages, console.log);
  }
  console.log("\nBye.");
  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

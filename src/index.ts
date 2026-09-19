#!/usr/bin/env node
import { createInterface, type Interface } from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { runTurn } from "./agent.js";
import { createApprovalState, isApprovalMode, type ApprovalMode, type OnApprovalRequest } from "./approval.js";

function parseArgs(argv: string[]): { mode: ApprovalMode; message: string } {
  let mode: ApprovalMode = "confirm";
  const rest: string[] = [];
  for (const arg of argv) {
    const match = arg.match(/^--mode=(.+)$/);
    if (match) {
      if (!isApprovalMode(match[1])) {
        console.error(`Unknown --mode '${match[1]}'. Valid modes: confirm, plan, auto.`);
        process.exit(1);
      }
      mode = match[1];
    } else {
      rest.push(arg);
    }
  }
  return { mode, message: rest.join(" ") };
}

/** Prompts the human on stdin/stdout to approve a mutating/shell tool call. */
function makeApprovalPrompt(rl: Interface): OnApprovalRequest {
  return async ({ tool, input, risk }) => {
    console.log(`\nApproval needed [${risk}]: ${tool}(${JSON.stringify(input)})`);
    const answer = (await rl.question("Allow? [y]es / [n]o / [a]lways this session: ")).trim().toLowerCase();
    if (answer === "a" || answer === "always") return "session";
    if (answer === "y" || answer === "yes") return "once";
    return "deny";
  };
}

async function main(): Promise<void> {
  const apiKey = process.env.APP_ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("APP_ANTHROPIC_API_KEY is not set.");
    process.exit(1);
  }

  const { mode, message: oneShotMessage } = parseArgs(process.argv.slice(2));
  const approvalState = createApprovalState(mode);
  const messages: Anthropic.MessageParam[] = [];

  if (oneShotMessage) {
    messages.push({ role: "user", content: oneShotMessage });
    // Only offer interactive approval if there's actually a human on the
    // other end of stdin; otherwise anything needing approval is refused
    // (see approval.ts) rather than hanging waiting for input that'll never
    // come.
    let rl: Interface | undefined;
    let onApprovalRequest: OnApprovalRequest | undefined;
    if (process.stdin.isTTY) {
      rl = createInterface({ input: process.stdin, output: process.stdout });
      onApprovalRequest = makeApprovalPrompt(rl);
    }
    await runTurn(apiKey, messages, console.log, approvalState, onApprovalRequest);
    rl?.close();
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const onApprovalRequest = makeApprovalPrompt(rl);
  console.log(
    `Interactive mode (approval mode: ${approvalState.mode}). Type /exit to quit, /mode confirm|plan|auto to change approval mode.`
  );
  while (true) {
    let line: string;
    try {
      line = await rl.question("> ");
    } catch {
      break; // stdin closed (e.g. Ctrl+D)
    }
    const trimmed = line.trim();
    if (trimmed === "/exit") break;
    if (!trimmed) continue;

    if (trimmed.startsWith("/mode")) {
      const arg = trimmed.split(/\s+/)[1];
      if (arg && isApprovalMode(arg)) {
        approvalState.mode = arg;
        console.log(`Approval mode set to ${arg}.`);
      } else {
        console.log(`Usage: /mode confirm|plan|auto (current: ${approvalState.mode})`);
      }
      continue;
    }

    messages.push({ role: "user", content: line });
    await runTurn(apiKey, messages, console.log, approvalState, onApprovalRequest);
  }
  console.log("\nBye.");
  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

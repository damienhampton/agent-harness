import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { execSync } from "node:child_process";
import type Anthropic from "@anthropic-ai/sdk";
import type { ToolRisk } from "./approval.js";

export const toolDefs: Anthropic.Tool[] = [
  {
    name: "read_file",
    description: "Read the full contents of a text file at the given path.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to read, relative to the current working directory." },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file, overwriting it if it exists or creating it (and any missing parent directories) if not. Use for new files; use edit_file to change an existing file in place.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to write, relative to the current working directory." },
        content: { type: "string", description: "Full content to write to the file." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Replace one exact occurrence of old_string with new_string in an existing file. Fails if old_string is not found, or is found more than once (include more surrounding context to disambiguate).",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to edit, relative to the current working directory." },
        old_string: { type: "string", description: "Exact text to find. Must be unique in the file." },
        new_string: { type: "string", description: "Text to replace it with." },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "run_tests",
    description: "Run the project's test command and return its combined stdout/stderr and exit code.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Test command to run. Defaults to 'npm test'." },
      },
      required: [],
    },
  },
  {
    name: "run_shell",
    description: "Run an arbitrary shell command (git, npm, mkdir, etc.) in the current working directory and return its combined stdout/stderr and exit code. A small set of obviously destructive commands (e.g. rm -rf on / or ~, disk formatting, shutdown) are refused.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run." },
      },
      required: ["command"],
    },
  },
];

// Risk classification used by the approval layer (see approval.ts). Unknown
// tool names default to "mutating" (the safer default) wherever this map is
// consulted.
export const TOOL_RISK: Record<string, ToolRisk> = {
  read_file: "readonly",
  write_file: "mutating",
  edit_file: "mutating",
  run_tests: "shell",
  run_shell: "shell",
};

// Light-touch tripwire, not a sandbox: catches the obviously catastrophic
// cases (wipe the disk, wipe the home dir, shut the machine down) without
// trying to be a real permission model.
const DANGEROUS_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\brm\s+(-\w*\s+)*-\w*[rf]\w*(-\w+\s+)*\s+(\/|~|\$HOME)(\s|\/|$)/, reason: "recursive delete of root or home" },
  { pattern: /\brm\s+.*(-[a-z]*r[a-z]*|-[a-z]*f[a-z]*).*\*\s*$/, reason: "recursive delete with a bare wildcard" },
  { pattern: /\bsudo\b/, reason: "privilege escalation" },
  { pattern: /\bdd\s+.*\bof=\/dev\//, reason: "raw write to a block device" },
  { pattern: /\bmkfs\b|\bdiskutil\s+(erase|reformat)/i, reason: "disk formatting" },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/, reason: "system shutdown/reboot" },
  { pattern: /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;\s*:/, reason: "fork bomb" },
  { pattern: /\bchmod\s+-R\s+\d+\s+\/(\s|$)/, reason: "recursive permission change on root" },
];

function checkDangerous(command: string): string | null {
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) return reason;
  }
  return null;
}

function readFile(input: Record<string, unknown>): { output: string; isError: boolean } {
  const path = input.path;
  if (typeof path !== "string") {
    return { output: "Missing or invalid required argument 'path'", isError: true };
  }
  try {
    return { output: readFileSync(path, "utf-8"), isError: false };
  } catch (err) {
    return { output: `Error reading file: ${(err as Error).message}`, isError: true };
  }
}

function writeFile(input: Record<string, unknown>): { output: string; isError: boolean } {
  const path = input.path;
  const content = input.content;
  if (typeof path !== "string" || typeof content !== "string") {
    return { output: "Missing or invalid required arguments 'path' and/or 'content'", isError: true };
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf-8");
    return { output: `Wrote ${content.length} bytes to ${path}`, isError: false };
  } catch (err) {
    return { output: `Error writing file: ${(err as Error).message}`, isError: true };
  }
}

function editFile(input: Record<string, unknown>): { output: string; isError: boolean } {
  const path = input.path;
  const oldString = input.old_string;
  const newString = input.new_string;
  if (typeof path !== "string" || typeof oldString !== "string" || typeof newString !== "string") {
    return { output: "Missing or invalid required arguments 'path', 'old_string', 'new_string'", isError: true };
  }
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch (err) {
    return { output: `Error reading file: ${(err as Error).message}`, isError: true };
  }
  const occurrences = content.split(oldString).length - 1;
  if (occurrences === 0) {
    return { output: "old_string not found in file", isError: true };
  }
  if (occurrences > 1) {
    return { output: `old_string found ${occurrences} times; must be unique. Add more surrounding context.`, isError: true };
  }
  try {
    writeFileSync(path, content.replace(oldString, newString), "utf-8");
    return { output: `Replaced 1 occurrence in ${path}`, isError: false };
  } catch (err) {
    return { output: `Error writing file: ${(err as Error).message}`, isError: true };
  }
}

function runCommand(command: string): { output: string; isError: boolean } {
  const dangerReason = checkDangerous(command);
  if (dangerReason) {
    return { output: `Refused to run: command looks like ${dangerReason}. Not executing.`, isError: true };
  }
  try {
    const output = execSync(command, {
      encoding: "utf-8",
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { output: `Exit code: 0\n${output}`, isError: false };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string; message: string };
    if (e.stdout !== undefined || e.stderr !== undefined) {
      return { output: `Exit code: ${e.status}\n${e.stdout ?? ""}${e.stderr ?? ""}`, isError: false };
    }
    return { output: `Error running command: ${e.message}`, isError: true };
  }
}

function runTests(input: Record<string, unknown>): { output: string; isError: boolean } {
  const command = typeof input.command === "string" ? input.command : "npm test";
  return runCommand(command);
}

function runShell(input: Record<string, unknown>): { output: string; isError: boolean } {
  const command = input.command;
  if (typeof command !== "string") {
    return { output: "Missing or invalid required argument 'command'", isError: true };
  }
  return runCommand(command);
}

export function executeTool(name: string, input: Record<string, unknown>): { output: string; isError: boolean } {
  switch (name) {
    case "read_file":
      return readFile(input);
    case "write_file":
      return writeFile(input);
    case "edit_file":
      return editFile(input);
    case "run_tests":
      return runTests(input);
    case "run_shell":
      return runShell(input);
    default:
      return { output: `Unknown tool: ${name}`, isError: true };
  }
}

import { readFileSync } from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";

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
];

export function executeTool(name: string, input: Record<string, unknown>): { output: string; isError: boolean } {
  if (name !== "read_file") {
    return { output: `Unknown tool: ${name}`, isError: true };
  }
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

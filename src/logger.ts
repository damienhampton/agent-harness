import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const LOG_DIR = "logs";
mkdirSync(LOG_DIR, { recursive: true });

const sessionFile = join(LOG_DIR, `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);

export function logEvent(type: string, data: unknown): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), type, data });
  appendFileSync(sessionFile, line + "\n");
}

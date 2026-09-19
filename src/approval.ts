// Tool-call approval/permission layer. Classifies tools by risk and decides
// whether a given call may run outright, needs interactive approval, or is
// blocked, based on the current session's approval mode.
//
// No dependency on process.env/argv/stdio — prompting itself is delegated to
// an `OnApprovalRequest` callback supplied by the CLI adapter, same pattern
// as `OnText` in agent.ts.

export type ToolRisk = "readonly" | "mutating" | "shell";

export type ApprovalMode = "confirm" | "plan" | "auto";

export const APPROVAL_MODES: ApprovalMode[] = ["confirm", "plan", "auto"];

export function isApprovalMode(value: string): value is ApprovalMode {
  return (APPROVAL_MODES as string[]).includes(value);
}

/** "once": allow this call only. "session": allow this tool for the rest of the session. "deny": refuse. */
export type ApprovalAnswer = "once" | "session" | "deny";

export type OnApprovalRequest = (request: {
  tool: string;
  input: Record<string, unknown>;
  risk: ToolRisk;
}) => Promise<ApprovalAnswer>;

export interface ApprovalState {
  mode: ApprovalMode;
  /** Tool names approved for the rest of this session (confirm mode only). */
  sessionApprovals: Set<string>;
}

export function createApprovalState(mode: ApprovalMode = "confirm"): ApprovalState {
  return { mode, sessionApprovals: new Set() };
}

export interface ApprovalResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Decides whether a tool call may proceed. Read-only tools are always
 * allowed. Mutating/shell tools depend on mode:
 * - auto: always allowed (still subject to the dangerous-command blocklist
 *   inside the tool itself).
 * - plan: always blocked, so a session can be used as a dry run.
 * - confirm: allowed if already approved for this session, otherwise
 *   delegates to `onApprovalRequest`. If none is supplied (e.g. no TTY),
 *   denies with guidance to rerun in auto mode rather than hang.
 */
export async function checkApproval(
  state: ApprovalState,
  tool: string,
  risk: ToolRisk,
  input: Record<string, unknown>,
  onApprovalRequest?: OnApprovalRequest
): Promise<ApprovalResult> {
  if (risk === "readonly") return { allowed: true };

  if (state.mode === "auto") return { allowed: true };

  if (state.mode === "plan") {
    return {
      allowed: false,
      reason: `Blocked: '${tool}' is a ${risk} action and this session is in plan mode (read-only/dry-run). Switch modes with /mode confirm or /mode auto to allow it.`,
    };
  }

  // confirm mode
  if (state.sessionApprovals.has(tool)) return { allowed: true };

  if (!onApprovalRequest) {
    return {
      allowed: false,
      reason: `Blocked: '${tool}' needs approval but no interactive approval is available in this session (no TTY). Rerun with --mode=auto to skip prompts.`,
    };
  }

  const answer = await onApprovalRequest({ tool, input, risk });
  if (answer === "deny") {
    return { allowed: false, reason: `Denied: '${tool}' was not approved by the user.` };
  }
  if (answer === "session") {
    state.sessionApprovals.add(tool);
  }
  return { allowed: true };
}

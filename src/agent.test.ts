import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApprovalState, type OnApprovalRequest } from "./approval.js";

/** Approves every request once, without granting session-wide approval. */
const approveOnce: OnApprovalRequest = async () => "once";

const createMock = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: createMock };
  },
}));

const { runTurn } = await import("./agent.js");

function textResponse(text: string, inputTokens = 100) {
  return { content: [{ type: "text", text }], usage: { input_tokens: inputTokens, output_tokens: 10 } };
}

function toolUseResponse(id: string, name: string, input: Record<string, unknown>, inputTokens = 100) {
  return {
    content: [{ type: "tool_use", id, name, input }],
    usage: { input_tokens: inputTokens, output_tokens: 10 },
  };
}

function truncatedResponse() {
  return {
    content: [{ type: "thinking", thinking: "still reasoning..." }],
    stop_reason: "max_tokens",
    usage: { input_tokens: 100, output_tokens: 8192 },
  };
}

let dir: string;

beforeEach(() => {
  createMock.mockReset();
  dir = mkdtempSync(join(tmpdir(), "my-agent-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("runTurn", () => {
  it("executes a tool call and feeds the result back", async () => {
    const filePath = join(dir, "greeting.txt");
    writeFileSync(filePath, "hello world");

    createMock
      .mockResolvedValueOnce(toolUseResponse("tu1", "read_file", { path: filePath }))
      .mockResolvedValueOnce(textResponse("the file says hello world"));

    const messages: any[] = [{ role: "user", content: "read the file" }];
    const seen: string[] = [];
    await runTurn("fake-key", messages, (t) => seen.push(t));

    expect(seen).toEqual(["the file says hello world"]);
    expect(createMock).toHaveBeenCalledTimes(2);

    const toolResultMsg = messages[2];
    expect(toolResultMsg.content[0].content).toBe("hello world");
    expect(toolResultMsg.content[0].is_error).toBe(false);
  });

  it("reports a tool error back to the model instead of crashing", async () => {
    const missingPath = join(dir, "does-not-exist.txt");

    createMock
      .mockResolvedValueOnce(toolUseResponse("tu1", "read_file", { path: missingPath }))
      .mockResolvedValueOnce(textResponse("that file doesn't exist"));

    const messages: any[] = [{ role: "user", content: "read the file" }];
    const seen: string[] = [];
    await runTurn("fake-key", messages, (t) => seen.push(t));

    const toolResultMsg = messages[2];
    expect(toolResultMsg.content[0].is_error).toBe(true);
    expect(toolResultMsg.content[0].content).toContain("ENOENT");
    expect(seen).toEqual(["that file doesn't exist"]);
  });

  it("refuses an ambiguous edit_file match", async () => {
    const filePath = join(dir, "dup.txt");
    writeFileSync(filePath, "foo\nfoo\n");

    createMock
      .mockResolvedValueOnce(
        toolUseResponse("tu1", "edit_file", { path: filePath, old_string: "foo", new_string: "bar" })
      )
      .mockResolvedValueOnce(textResponse("that string isn't unique, can you clarify?"));

    const messages: any[] = [{ role: "user", content: "replace foo with bar" }];
    await runTurn("fake-key", messages, () => {}, createApprovalState("auto"));

    const toolResultMsg = messages[2];
    expect(toolResultMsg.content[0].is_error).toBe(true);
    expect(toolResultMsg.content[0].content).toContain("found 2 times");
    expect(readFileSync(filePath, "utf-8")).toBe("foo\nfoo\n");
  });

  it("captures run_tests exit code and output without treating a failing test as a crash", async () => {
    createMock
      .mockResolvedValueOnce(
        toolUseResponse("tu1", "run_tests", { command: `node -e "console.log('boom'); process.exit(1)"` })
      )
      .mockResolvedValueOnce(textResponse("the tests failed"));

    const messages: any[] = [{ role: "user", content: "run the tests" }];
    await runTurn("fake-key", messages, () => {}, createApprovalState("auto"));

    const toolResultMsg = messages[2];
    expect(toolResultMsg.content[0].is_error).toBe(false);
    expect(toolResultMsg.content[0].content).toContain("Exit code: 1");
    expect(toolResultMsg.content[0].content).toContain("boom");
  });

  it("runs a benign shell command via run_shell", async () => {
    createMock
      .mockResolvedValueOnce(toolUseResponse("tu1", "run_shell", { command: `node -e "console.log('hi')"` }))
      .mockResolvedValueOnce(textResponse("it printed hi"));

    const messages: any[] = [{ role: "user", content: "run a command" }];
    await runTurn("fake-key", messages, () => {}, createApprovalState("auto"));

    const toolResultMsg = messages[2];
    expect(toolResultMsg.content[0].is_error).toBe(false);
    expect(toolResultMsg.content[0].content).toContain("hi");
  });

  it("refuses an obviously destructive run_shell command without executing it", async () => {
    createMock
      .mockResolvedValueOnce(toolUseResponse("tu1", "run_shell", { command: "sudo rm -rf /" }))
      .mockResolvedValueOnce(textResponse("I won't run that"));

    const messages: any[] = [{ role: "user", content: "wipe everything" }];
    // auto mode so we exercise the dangerous-command blocklist inside the
    // tool itself, not the approval layer (covered separately below).
    await runTurn("fake-key", messages, () => {}, createApprovalState("auto"));

    const toolResultMsg = messages[2];
    expect(toolResultMsg.content[0].is_error).toBe(true);
    expect(toolResultMsg.content[0].content).toContain("Refused to run");
  });

  it("compacts history via a summary call when the context window fills up", async () => {
    // Seed a history longer than the sliding window so there's an old
    // enough prefix for compaction to actually fold away.
    const messages: any[] = [];
    for (let i = 0; i < 12; i++) {
      messages.push({ role: "user", content: `old message ${i}` });
      messages.push({ role: "assistant", content: `old reply ${i}` });
    }

    createMock
      .mockResolvedValueOnce(textResponse("done for now", 150_000))
      .mockResolvedValueOnce(textResponse("summary: user asked X, we did Y"));

    await runTurn("fake-key", messages, () => {});

    expect(createMock).toHaveBeenCalledTimes(2);
    // history shrank: the old prefix collapsed into one summary message,
    // recent messages (including this turn's exchange) kept verbatim.
    expect(messages.length).toBeLessThan(26);
    expect(messages[0].content).toContain("summary: user asked X, we did Y");
    expect(messages.at(-1)).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "done for now" }],
    });
  });

  it("degrades to a warning instead of crashing when compaction itself fails", async () => {
    // Seed a history longer than the sliding window so compact() actually
    // has a prefix to summarize (and thus a summary call that can fail).
    const messages: any[] = [];
    for (let i = 0; i < 12; i++) {
      messages.push({ role: "user", content: `old message ${i}` });
      messages.push({ role: "assistant", content: `old reply ${i}` });
    }

    createMock
      .mockResolvedValueOnce(textResponse("done for now", 150_000))
      .mockRejectedValueOnce(new Error("summary call failed"));

    const seen: string[] = [];
    await expect(runTurn("fake-key", messages, (t) => seen.push(t))).resolves.toBeUndefined();

    expect(seen.some((t) => t.includes("compaction failed"))).toBe(true);
    // history is left untouched rather than half-cleared
    expect(messages).toHaveLength(25);
  });

  it("compacts mid-turn after a tool round trip, not just when the turn ends", async () => {
    const filePath = join(dir, "big.txt");
    writeFileSync(filePath, "x");

    // Seed a history longer than the sliding window so the tool round trip
    // below actually triggers a real (not no-op) compaction.
    const messages: any[] = [];
    for (let i = 0; i < 12; i++) {
      messages.push({ role: "user", content: `old message ${i}` });
      messages.push({ role: "assistant", content: `old reply ${i}` });
    }
    messages.push({ role: "user", content: "do a long task" });

    createMock
      .mockResolvedValueOnce(toolUseResponse("tu1", "read_file", { path: filePath }, 150_000))
      .mockResolvedValueOnce(textResponse("summary: read a file, more to do"))
      .mockResolvedValueOnce(textResponse("all done"));

    const seen: string[] = [];
    await runTurn("fake-key", messages, (t) => seen.push(t));

    // call 1: the tool_use turn that pushes usage over threshold
    // call 2: compact()'s own summary call, made right after that round trip
    // call 3: the next turn, working off the compacted history
    expect(createMock).toHaveBeenCalledTimes(3);
    expect(seen.some((t) => t.includes("compacted"))).toBe(true);
    expect(seen.at(-1)).toBe("all done");
    // Sliding-window compaction: only the old prefix gets folded into the
    // summary; the tool round trip and the final answer survive verbatim
    // rather than the whole history being collapsed away.
    expect(messages[0].content).toContain("summary: read a file, more to do");
    expect(messages.at(-1)).toEqual({ role: "assistant", content: [{ type: "text", text: "all done" }] });
    expect(messages.length).toBeGreaterThan(2);
  });

  it("keeps recent messages verbatim across repeated compactions instead of collapsing everything", async () => {
    // Simulate a long-running, tool-heavy turn: every round trip re-triggers
    // shouldCompact (usage pinned above threshold), so compact() runs many
    // times in a row. Recent tool activity should still be readable
    // afterwards rather than being summarized away on every single pass.
    const filePath = join(dir, "notes.txt");
    writeFileSync(filePath, "hello");

    // Seed a history longer than the sliding window so every round trip
    // below has an old-enough prefix to actually fold away.
    const messages: any[] = [];
    for (let i = 0; i < 12; i++) {
      messages.push({ role: "user", content: `old message ${i}` });
      messages.push({ role: "assistant", content: `old reply ${i}` });
    }
    messages.push({ role: "user", content: "do a very long task" });

    for (let i = 0; i < 6; i++) {
      createMock.mockResolvedValueOnce(toolUseResponse(`tu${i}`, "read_file", { path: filePath }, 150_000));
      createMock.mockResolvedValueOnce(textResponse(`summary after round ${i}`));
    }
    createMock.mockResolvedValueOnce(textResponse("all done"));

    const seen: string[] = [];
    await runTurn("fake-key", messages, (t) => seen.push(t));

    expect(seen.filter((t) => t.includes("compacted")).length).toBe(6);
    expect(seen.at(-1)).toBe("all done");
    // the most recent tool round trip is still present verbatim, not folded
    // into a summary, since it's well within the kept window
    const lastToolResult = messages.at(-2);
    expect(lastToolResult.role).toBe("user");
    expect(lastToolResult.content[0].type).toBe("tool_result");
    expect(lastToolResult.content[0].content).toBe("hello");
  });

  it("retries instead of silently ending the turn on max_tokens truncation", async () => {
    createMock
      .mockResolvedValueOnce(truncatedResponse())
      .mockResolvedValueOnce(textResponse("finally, an answer"));

    const messages: any[] = [{ role: "user", content: "think hard about this" }];
    const seen: string[] = [];
    await runTurn("fake-key", messages, (t) => seen.push(t));

    expect(createMock).toHaveBeenCalledTimes(2);
    expect(seen.some((t) => t.includes("truncated"))).toBe(true);
    expect(seen.at(-1)).toBe("finally, an answer");
    // the truncated attempt must not be left in history
    expect(messages.filter((m) => m.role === "assistant")).toHaveLength(1);
  });

  it("ends the turn gracefully instead of crashing when the API call fails after retries", async () => {
    createMock.mockRejectedValueOnce(new Error("overloaded_error: 529"));

    const messages: any[] = [{ role: "user", content: "hello" }];
    const seen: string[] = [];
    await expect(runTurn("fake-key", messages, (t) => seen.push(t))).resolves.toBeUndefined();

    expect(seen.some((t) => t.includes("request failed after retries"))).toBe(true);
    // no assistant message was recorded for the failed call
    expect(messages).toHaveLength(1);
  });

  it("stops after the max tool-turn cap instead of looping forever", async () => {
    const filePath = join(dir, "loop.txt");
    writeFileSync(filePath, "x");
    createMock.mockResolvedValue(toolUseResponse("tu1", "read_file", { path: filePath }));

    const messages: any[] = [{ role: "user", content: "loop forever" }];
    const seen: string[] = [];
    await runTurn("fake-key", messages, (t) => seen.push(t));

    expect(seen.some((t) => t.includes("stopped after 25 tool turns"))).toBe(true);
    expect(createMock).toHaveBeenCalledTimes(25);
  });
});

describe("tool approval", () => {
  it("does not require approval for read-only tools even in confirm mode (the default)", async () => {
    const filePath = join(dir, "greeting.txt");
    writeFileSync(filePath, "hello world");

    createMock
      .mockResolvedValueOnce(toolUseResponse("tu1", "read_file", { path: filePath }))
      .mockResolvedValueOnce(textResponse("done"));

    const messages: any[] = [{ role: "user", content: "read the file" }];
    // No onApprovalRequest supplied at all — read_file must not need one.
    await runTurn("fake-key", messages, () => {}, createApprovalState("confirm"));

    expect(messages[2].content[0].is_error).toBe(false);
    expect(messages[2].content[0].content).toBe("hello world");
  });

  it("denies a mutating call in confirm mode when no approval prompt is available (no TTY)", async () => {
    const filePath = join(dir, "new.txt");

    createMock
      .mockResolvedValueOnce(toolUseResponse("tu1", "write_file", { path: filePath, content: "hi" }))
      .mockResolvedValueOnce(textResponse("couldn't write it"));

    const messages: any[] = [{ role: "user", content: "write the file" }];
    await runTurn("fake-key", messages, () => {}, createApprovalState("confirm"));

    expect(messages[2].content[0].is_error).toBe(true);
    expect(messages[2].content[0].content).toContain("mode=auto");
  });

  it("allows a mutating call in confirm mode when the human approves once", async () => {
    const filePath = join(dir, "new.txt");

    createMock
      .mockResolvedValueOnce(toolUseResponse("tu1", "write_file", { path: filePath, content: "hi" }))
      .mockResolvedValueOnce(textResponse("wrote it"));

    const messages: any[] = [{ role: "user", content: "write the file" }];
    await runTurn("fake-key", messages, () => {}, createApprovalState("confirm"), approveOnce);

    expect(messages[2].content[0].is_error).toBe(false);
    expect(readFileSync(filePath, "utf-8")).toBe("hi");
  });

  it("does not re-prompt for a tool approved for the rest of the session", async () => {
    const filePath = join(dir, "new.txt");
    const approvalRequests: string[] = [];
    const approveSessionOnFirstAsk: OnApprovalRequest = async ({ tool }) => {
      approvalRequests.push(tool);
      return "session";
    };

    createMock
      .mockResolvedValueOnce(toolUseResponse("tu1", "write_file", { path: filePath, content: "one" }))
      .mockResolvedValueOnce(toolUseResponse("tu2", "write_file", { path: filePath, content: "two" }))
      .mockResolvedValueOnce(textResponse("done"));

    const approvalState = createApprovalState("confirm");
    const messages: any[] = [{ role: "user", content: "write it twice" }];
    await runTurn("fake-key", messages, () => {}, approvalState, approveSessionOnFirstAsk);

    expect(approvalRequests).toEqual(["write_file"]); // only asked once
    expect(readFileSync(filePath, "utf-8")).toBe("two");
  });

  it("denies a user's explicit refusal without executing the tool", async () => {
    const filePath = join(dir, "new.txt");
    const denyAll: OnApprovalRequest = async () => "deny";

    createMock
      .mockResolvedValueOnce(toolUseResponse("tu1", "write_file", { path: filePath, content: "hi" }))
      .mockResolvedValueOnce(textResponse("ok, not writing it"));

    const messages: any[] = [{ role: "user", content: "write the file" }];
    await runTurn("fake-key", messages, () => {}, createApprovalState("confirm"), denyAll);

    expect(messages[2].content[0].is_error).toBe(true);
    expect(messages[2].content[0].content).toContain("Denied");
  });

  it("blocks mutating/shell tools outright in plan mode, without prompting", async () => {
    const filePath = join(dir, "new.txt");
    const shouldNotBeCalled: OnApprovalRequest = async () => {
      throw new Error("should not prompt in plan mode");
    };

    createMock
      .mockResolvedValueOnce(toolUseResponse("tu1", "write_file", { path: filePath, content: "hi" }))
      .mockResolvedValueOnce(textResponse("can't do that in plan mode"));

    const messages: any[] = [{ role: "user", content: "write the file" }];
    await runTurn("fake-key", messages, () => {}, createApprovalState("plan"), shouldNotBeCalled);

    expect(messages[2].content[0].is_error).toBe(true);
    expect(messages[2].content[0].content).toContain("plan mode");
  });
});

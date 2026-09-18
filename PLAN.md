# Plan: self-hosted agent harness

Learning project: build a Claude-Code-like harness from scratch (no framework),
using the model's native tool-use API directly. Human stays in the loop always —
not an autonomous self-improving agent.

## Bootstrap steps

1. **Bare-bones loop** ✅
   Send message → model tool call → execute one tool (`read_file`) → feed result
   back → repeat until final text. Native tool-use API. Full JSONL request/response
   logging from turn one.

2. **More tools, interactive mode, context strategy** ✅
   - Tools: `write_file`, `edit_file` (str-replace, not overwrite), `run_tests`.
   - Interactive REPL (persistent conversation across turns) alongside one-shot CLI mode.
   - Compaction: when `usage.input_tokens` exceeds a threshold, summarize the
     conversation via a separate model call and replace history with the summary.
   - Hexagonal split: core turn logic (`runTurn(apiKey, messages, onText)`) has no
     dependency on `process.env`/`process.argv`/stdio — those live only in the CLI
     entry point (`main()`), so the core is unit/functionally testable in isolation.

3. **Functional test suite** ⬅ current
   Tests mock the Anthropic SDK (the external dependency) and drive `runTurn`
   through scripted multi-turn responses: tool-call happy path, tool error path,
   ambiguous/missing `edit_file` match, `run_tests` exit codes, compaction trigger,
   max-tool-turns guard. Real filesystem in a temp dir for file tools (that's the
   thing under test, not an external dependency). Kept small and behavioral — no
   unit tests for trivial string/argument plumbing.

4. **Point at a disposable external repo**
   Run the harness against some other small repo to find rough edges — bad error
   handling, hallucinated tool args, missing sandboxing — before risking anything
   that matters.

5. **Point at itself**
   Only once guardrails exist: a test suite the harness can run but not edit, git
   as an undo button, branch protection. Human approves every self-modifying change.

## Running design priorities (not separate steps)

- Robust tool-call failure handling — most of the real design work lives here.
- Full logging/tracing of every request/response (done, `logs/*.jsonl`).
- Sandboxing/guardrails in place *before* self-modification is allowed in step 5.

## Evals (distinct from the dev-time test suite above)

Evals grade the *harness's own behavior* over time, not just correctness of a
given commit. Designed in from the start, added once step 4/5 begins in earnest:

- **Category 1 — tool-call correctness**: fake tools, check emitted args are
  well-formed. Pure code, cheapest, most stable.
- **Category 2 — task completion**: task + hidden test suite (e.g. "add a fib
  function" → does pytest pass). Main regression suite for harness changes.
- **Category 3 — process evals**: turn count, token usage, unsafe actions without
  confirmation, retry behavior on tool error. Needs harness-level instrumentation
  (the JSONL logs are the raw material for this).
- **Category 4 — LLM-judged**: only for things with no mechanical check (e.g.
  commit message clarity). Small, noisy, never a pass/fail gate.

Start with Category 1 + 2 only.

**Open question**: is the eval runner just another tool the harness can call on
itself, or a separate harness-external process? Not yet decided.

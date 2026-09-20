# TODO

Suggestions from code review, tracked as a checklist. See PLAN.md for the
overall bootstrap plan these slot into.

## Bugs / robustness

- [x] Wrap `client.messages.create` calls with retry/backoff (or use SDK
      `maxRetries`) so a transient 429/500/`overloaded_error` doesn't crash
      the whole REPL session. The SDK already retries 408/409/429/5xx with
      exponential backoff + jitter internally (`maxRetries`, default 2); we
      now pass an explicit, larger budget (`MAX_RETRIES = 5` in `agent.ts`)
      and, more importantly, catch whatever error is left once that budget
      is exhausted (or any non-retryable error, e.g. a network failure)
      around the `messages.create` call so it ends the current turn with an
      `onText` message instead of throwing out of `runTurn` and crashing
      the whole process.
- [x] Wrap `compact()` in try/catch so a failed summarization degrades to
      "skip compaction, log a warning, carry on" instead of crashing a turn
      that otherwise succeeded.
- [x] Fix compaction only being checked when a turn ends with no tool call:
      a turn that keeps calling tools for all `MAX_TOOL_TURNS` never
      compacted, so a long tool-heavy turn could grow past the model's
      hard prompt-token limit before ever getting a chance to shrink.
      `maybeCompact` now runs after every tool round trip, not just at
      turn-end. (Found for real: a self-mod session hit a 1,008,113-token
      prompt this way.)
- [ ] Change compaction to a sliding window: summarize everything except the
      last N messages, keep those verbatim, instead of replacing the entire
      history with one summary.
- [ ] Fix stale `"main": "index.js"` in package.json (real entry is
      `dist/index.js` via `bin`).
- [ ] Add `AbortController`/cancellation support so Ctrl+C can interrupt a
      long-running tool call (e.g. `run_shell`) instead of only killing the
      whole process.

## Safety

- [x] Add a tool-call approval/permission layer instead of a single on/off
      switch (`src/approval.ts`, wired into `runTurn` and the CLI):
  - [x] Classify tools by risk: read-only (`read_file`) vs. mutating
        (`write_file`, `edit_file`) vs. shell (`run_shell`, `run_tests`).
        Extend this map when `list_dir`/`grep` are added.
  - [x] Support modes: `confirm` (default — read-only auto-approved,
        mutating/shell prompt each time), `plan`/dry-run (mutating/shell
        always blocked, no prompt — for a safe first look at an unfamiliar
        repo), `auto`/yolo (no prompts, still runs through the
        dangerous-command blocklist) — for one-shot/CI use and step 4
        dogfooding. Set via `--mode=confirm|plan|auto` on the CLI.
  - [x] In interactive mode, the mode can be switched mid-session via
        `/mode confirm|plan|auto`, not just fixed at startup.
  - [x] At the approval prompt, support "approve for the rest of this
        session" (per-tool, `[a]lways`) in addition to yes/no-this-once.
  - [x] One-shot mode with no TTY on stdin skips prompting entirely and
        anything needing approval is refused with a message pointing at
        `--mode=auto`, rather than hanging.
- [ ] Sandbox file tool paths: resolve against `process.cwd()` and reject
      absolute paths / `../` escapes outside the project root (with an
      explicit override flag if ever needed).
- [ ] Avoid logging secrets by default — redact or otherwise handle tool
      input/output before writing to `logs/*.jsonl` (e.g. `.env` contents
      read by the model currently land in logs verbatim).
- [x] Keep the dangerous-command blocklist as defense-in-depth backing up the
      approval step above, not the primary control (still checked inside
      `run_shell`/`run_tests` even in `auto` mode).
- [ ] The risk classification treats `run_shell` as one flat "shell" risk
      level, so `git push` gets the same approval treatment as `ls`. In
      practice a self-mod session ran `git push` to the real GitHub remote
      unattended. Consider a step above "shell": mark commands that touch
      shared/remote state (`git push`, `npm publish`, etc.) as needing
      explicit approval even in `auto` mode.

## Architecture / maintainability

- [ ] Consolidate tool definitions and dispatch into a single registry
      (`{ name, description, input_schema, handler }[]`) instead of two
      hand-synced sources of truth (`toolDefs` array + `executeTool` switch).
- [ ] Replace repeated manual `typeof` validation in `tools.ts` with a small
      shared schema-validation helper (or zod) driven off `input_schema`.
- [ ] Narrow `run_tests` (drop the arbitrary `command` override, or merge it
      into `run_shell`) so it isn't just a redundant alias with the same
      capability.
- [ ] Pull magic numbers/strings (`"claude-sonnet-5"`, `MAX_TOOL_TURNS`,
      `MAX_TOKENS`, `COMPACT_THRESHOLD_TOKENS`) into a single config module
      with env var overrides.
- [ ] Add a system prompt: working directory, behavioral guidelines (prefer
      `edit_file` over `write_file` for existing files, ask before
      destructive actions), basic repo context.

## Testing

- [ ] Add tests for `index.ts` (CLI arg parsing, missing API key,
      interactive loop, Ctrl+D handling).
- [ ] Add direct unit tests for `checkDangerous` edge cases/bypasses in
      `tools.ts`, not just the two examples exercised via `agent.test.ts`.
- [ ] Add a test that a failed compaction call doesn't crash the turn.
- [ ] Add a test for `run_shell` timeout behavior.

## Features

- [ ] Search/navigation tools (`glob` / `list_dir` / `grep`) so the model
      isn't limited to files it already knows the exact path of.
- [ ] Streaming output via `client.messages.stream()` instead of `onText`
      firing once per complete response block.
- [ ] Diff preview for `write_file`/`edit_file`, combined with the approval
      step above, so a human can accept/reject before a change is written.
- [ ] Cost/usage reporting: sum input/output tokens (and a rough $ estimate)
      per session and print at exit.
- [ ] Config file / CLI flags for model name, max turns, compaction
      threshold, allowed tool set, sandboxed root.
- [ ] Git-aware safety net for self-modification (PLAN.md step 5):
      auto-commit or require a clean working tree before a session starts,
      so undo is always available.
- [ ] Retry/backoff wrapper around the Anthropic client call, surfacing
      rate-limit info to the user instead of a raw stack trace.

## UX

- [ ] Add more interactive-mode slash commands alongside the existing
      `/exit` and `/mode`:
  - [ ] `/help` — list available slash commands and current approval mode.
  - [ ] `/clear` — reset the in-memory conversation history (`messages`)
        without restarting the process, for starting a fresh task in the
        same session.
  - [ ] `/compact` — manually trigger `compact()` on demand instead of
        only when `shouldCompact`'s automatic token threshold is hit.
- [ ] Multi-line input in interactive mode (currently `rl.question` reads a
      single line, so pasting/writing a multi-paragraph prompt doesn't work).
      Needs a way to signal "end of input" (e.g. blank-line-to-submit, a
      `\` continuation, or a toggleable paste/edit mode).
- [ ] Activity indicator between sending a message and the first output
      (spinner/"thinking..." line) so the CLI doesn't look hung during the
      request/tool-call round trip.

## Project context

- [ ] Introduce a "project" concept: persistent state that lives across
      sessions, separate from a single conversation. Needs design, but
      should include at least:
  - [ ] A project-level todo list the model (and human) can read/update
        across sessions, not just within one conversation.
  - [ ] Memory of related past conversations/sessions (e.g. summaries
        pulled from `logs/`) so context can be recovered without replaying
        full history.
  - [ ] Support projects that map to a single repo, to multiple repos, and
        to no repo at all (e.g. research/planning work) — project scope
        shouldn't assume one repo = one project.
  - [ ] Decide where this state lives (e.g. a `.agent/` directory per
        project vs. a separate store) and how it's selected/switched
        between at startup.

## Nitpicks

- [ ] Add an `engines` field to package.json pinning a Node version.
- [ ] Add a LICENSE file matching the declared `"license": "ISC"`.
- [ ] Add lint/format tooling (ESLint/Prettier).
- [ ] Add a CI workflow (e.g. GitHub Actions) to run build + tests on push/PR.

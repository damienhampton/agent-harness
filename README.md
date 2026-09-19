# agent-harness

Self-hosted AI agent harness, built from scratch — a learning project. A loop
that sends context to a model, parses native tool-use calls from its
response, executes them, and feeds results back. No agent framework or SDK
wrapper; built directly on the Anthropic Messages API.

See [PLAN.md](./PLAN.md) for the full bootstrap plan and design priorities.

## Setup

```bash
npm install
export APP_ANTHROPIC_API_KEY=sk-ant-...
```

## Usage

One-shot:

```bash
npm start -- "read package.json and tell me the name field"
```

Interactive (persists conversation across turns until `/exit`):

```bash
npm start
```

## Tool-call approval modes

Mutating tools (`write_file`, `edit_file`) and shell tools (`run_shell`,
`run_tests`) require approval before they run; `read_file` never does.
Approval mode defaults to `confirm` and can be set with `--mode`:

```bash
npm start -- --mode=auto "fix the failing test"
```

- `confirm` (default) — prompts before each mutating/shell call. Answer
  `y` to allow once, `a` to allow that tool for the rest of the session, or
  `n`/anything else to deny. In one-shot mode with no TTY on stdin, prompts
  aren't possible and anything needing approval is refused instead of
  hanging — pass `--mode=auto` for non-interactive use.
- `plan` — dry run. Mutating/shell calls are always blocked, no prompt.
  Useful for a first look at an unfamiliar repo.
- `auto` — no prompts. Shell commands still go through the dangerous-command
  blocklist in `tools.ts` regardless of mode.

In interactive mode, switch modes mid-session with `/mode confirm|plan|auto`.

## Tools available to the model

- `read_file`
- `write_file`
- `edit_file` (exact string replace; fails if the match isn't unique)
- `run_tests`

## Testing

```bash
npm test
```

Functional tests (vitest) mock only the Anthropic SDK — file tool tests run
against a real temp directory.

## Logging

Every request, response, tool call, and tool result is appended as JSONL to
`logs/session-*.jsonl`.

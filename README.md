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

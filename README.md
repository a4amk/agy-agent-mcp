# agy-agent-mcp

[![test](https://github.com/a4amk/agy-agent-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/a4amk/agy-agent-mcp/actions/workflows/ci.yml)

An MCP server that turns the Antigravity CLI (`agy`) into five sub-agent tools.
You delegate a task, the call blocks, and you get the sub-agent's final report back.
Several delegations can run at once, each with its own transcript and result.

## Install

Requires Node >= 22.6 and an authenticated `agy` CLI.

```sh
npm install -g agy-agent-mcp
```

Register with OpenCode, Claude Code, or Antigravity itself:

```sh
# OpenCode
opencode mcp add agy -- agy-agent-mcp
# Claude Code
claude mcp add agy -- agy-agent-mcp
# Antigravity
agy mcp add agy-agent agy-agent-mcp
```

If `agy` is not on PATH, add `--env AGY_BIN=/path/to/agy` to any of the above.

OpenCode: pass `--global` to `mcp add` to register once for every project (writes `~/.config/opencode/opencode.json`). Project configs defining the same server name override the global entry, so remove per-project `agy` blocks after switching.

After upgrading the installed package, restart the MCP client or reload its catalog (`opencode api post /api/location/reload -d '{}'` for OpenCode) — sessions spawned before the upgrade keep replaying the old boot failure otherwise.

From a local checkout (`npm install` first): `opencode mcp add agy -- "$(pwd)/bin/mcp.mjs"`.

## Quickstart

Call `general_task` to delegate a coding task and wait for the final report:

```json
{
  "name": "general_task",
  "arguments": {
    "prompt": "Fix failing tests in test/parser.test.ts and verify the build passes",
    "cwd": "/path/to/project"
  }
}
```

The call blocks until the sub-agent finishes and returns its summary:

```json
{
  "task_id": "task_a1b2c3d4",
  "status": "success",
  "response": "Fixed the off-by-one error in src/parser.ts and verified all tests pass.",
  "usage": {
    "input_tokens": 12450,
    "output_tokens": 830,
    "total_tokens": 13280
  },
  "files_touched": ["src/parser.ts", "test/parser.test.ts"],
  "conversation_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "stream_file": "/tmp/agy-agent-mcp/tasks/task_a1b2c3d4.stream",
  "transcript_file": "/tmp/agy-agent-mcp/tasks/task_a1b2c3d4.ndjson"
}
```

A refused call returns `{"error": "..."}` with `isError: true`, the message names the offending argument, and nothing is spawned:

```json
{
  "error": "missing required argument: prompt"
}
```

A failed run comes back with `isError: true` and `status` of `error`, `timeout` or `quota_error`, and `error` carries the CLI's own message.

## Tools

| Tool | Mode | Default Effort | Purpose |
| --- | --- | --- | --- |
| `general_task` | `accept-edits` | `medium` | Delegate a coding task that may edit files and wait for the report. |
| `explore_task` | `plan` | `low` | Delegate a read-only diagnosis or exploration task without editing files. |
| `watch_task` | — | — | Inspect live transcripts, poll progress, collect results, or cancel runs. |
| `list_models` | — | — | List model IDs accepted by the `model` argument. |
| `list_agents` | — | — | List custom agent profiles accepted by the `agent` argument. |

### `general_task` and `explore_task`

`general_task` runs in `accept-edits` mode (it may edit files), default `effort: "medium"`.
`explore_task` runs in `plan` mode (read-only), default `effort: "low"`.
Everything else is the same for both:

- `prompt` (string, required): Full, self-contained task description for the sub-agent.
- `model` (string, optional, default: CLI default): Model ID to use (e.g. `gemini-3.8-flash`).
- `effort` (string `low|medium|high`, optional): Reasoning effort tier (`"medium"` default for `general_task`, `"low"` for `explore_task`).
- `agent` (string, optional, default: CLI default): Antigravity agent profile (see `list_agents`).
- `cwd` (string, optional, default: server cwd): Project directory for the delegated task.
- `background` (boolean, optional, default: `false`): Start task detached in background and return handle immediately.
- `timeout_ms` (integer `0..3600000`, optional, default: `900000`): Idle timeout in ms before killing silent child (`0` disables).
- `edit_scope` (array of strings, optional, default: unset): Paths defining expected edit boundary for change auditing.
- `add_dirs` (array of strings, optional, default: unset): Extra directories to add to workspace (`--add-dir`).
- `sandbox` (boolean, optional, default: `false`): Enable Antigravity terminal command sandboxing (`--sandbox`).
- `auto_approve` (boolean, optional, default: `false`): Pass `--dangerously-skip-permissions` to stop headless auto-denials.
- `project` (string, optional, default: unset): Antigravity project ID or name.
- `conversation_id` (string, optional, default: unset): Existing Antigravity conversation UUID to resume.

A tier-carrying model ID (e.g. `gemini-3.8-flash-high`) already encodes its tier and must not be paired with a conflicting `effort`.
Headless runs never prompt: tools requiring user confirmation are denied automatically and surfaced in `denied_actions`. Add rules under `permissions.allow` in your Antigravity `settings.json` to grant access.

### `watch_task`

Reads recent activity, polls progress, collects complete results, or stops runs:

- `stream_file` (string, optional, default: latest run): State path, `task_<id>.stream` filename, or task ID.
- `tail_lines` (integer `0..2000`, optional, default: `400`): Trailing transcript lines to return (`0` for all).
- `wait` (boolean, optional, default: `false`): Wait for run to finish and return complete final result in one call.
- `cancel` (boolean, optional, default: `false`): Stop the running task immediately. Cannot combine with `wait: true`.

### `list_models`

Lists model IDs accepted by `model`. Takes no arguments (any argument is refused).
Output: Raw CLI output in `models` and parsed model names in `model_ids`.

### `list_agents`

Lists agent profiles accepted by `agent` (rejects any arguments).
Output: Configured custom agent profiles in `agents`.

## Two ways to delegate

- **Way 1 — just delegate**: The call blocks until the sub-agent finishes, and you get the final report back.
- **Way 2 — delegate and collect later**: Pass `background: true` to receive a handle immediately, then:
  - `watch_task({ stream_file, wait: true })` collects the complete result in one call without polling;
  - `watch_task` alone polls live transcript lines and the step digest while running;
  - `cancel: true` stops the in-flight child process.

Several delegations can run concurrently, each with its own transcript and result. When runs share a git working tree, `files_touched` and `scope_violations` may include other runs' changes, which the result flags with `audit_note`. A wait for a run owned by another server process is refused with an error envelope telling you to poll instead; a cancel for such a run is reported as ignored, with a hint that the run belongs to another process.

## Watching a run live

Every run streams live activity to `<AGY_MCP_STATE_DIR>/task_<id>.stream` (default `/tmp/agy-agent-mcp/tasks/task_<id>.stream`).
The result is the sub-agent's summary, not its transcript; the transcript is on disk (`.stream` for humans, `.ndjson` for machines) and the result carries the paths.
You can watch any run live from a terminal with `tail -f`:

```sh
tail -f /tmp/agy-agent-mcp/tasks/task_<id>.stream
```

Sample transcript:

```text
session open · cwd=/tmp/probe · permission_mode=request-review · tools=60
● user_input
● agent_response
  ⎿ done in 3.5s · 8059 tokens
← Write /tmp/probe/hello.txt
  ⎿ done in 1.2s
→ Read /tmp/probe/hello.txt
  ⎿ 1 lines, 6 bytes · done in 0.02s
● agent_response
Created /tmp/probe/hello.txt with the word probe.
  ⎿ done in 3.4s · 2198 tokens
== done: status=SUCCESS · 12.1s
```

Whether the client shows live progress depends on the client (OpenCode does not, Claude Code does).
Call `watch_task` for an in-protocol view of the live step digest (`steps`, `step_count`, `phase`, `usage_latest`) and recent transcript lines.

### Live-follow companion CLI

```sh
npx agy-agent-follow --model gemini-3.8-flash --effort high "summarize the open TODOs in src/ in one paragraph"
```

- Delegates through the same runner as the MCP tools; every mirrored transcript line is printed to stdout as it is written, with the machine-readable result JSON right before exit (exit code `0` only on `status: "success"`).
- `--tool general|explore` switches the posture (`accept-edits` vs read-only `plan`), plus `--cwd` and `--timeout-ms`.
- `--effort low|medium|high` sets the reasoning tier; a model ID that already carries one (e.g. `gemini-3.8-flash-high`) must not repeat a different tier — that combination is refused locally, before any task is spawned.
- Ctrl-C / SIGTERM kill the in-flight `agy` child (receipts in the same tasks directory).

## If something goes wrong

| Symptom | Cause | What to do |
| --- | --- | --- |
| Refused call | Input argument validation failed before any child process was spawned. | Fix the argument named in the error message and call the tool again. |
| Failed run | The sub-agent exited non-zero, timed out, or hit a quota ceiling. | Inspect `error` and `notes`. Increase `timeout_ms` for timeouts, or retry after quota resets. |
| Missing permission | A tool required user approval that headless execution cannot provide. | Pass `auto_approve: true` (pair with `sandbox: true`), or add allow-rules in your own Antigravity `settings.json`. |
| Unknown model ID | The CLI does not recognize the ID, or it carries a tier that conflicts with an explicit `effort`. | `list_models` only lists tier-carrying IDs (e.g. `gemini-3.8-flash-high`); a bare ID such as `gemini-3.8-flash` is valid but will not appear there. Use either form, and do not pass a conflicting `effort`. |

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGY_BIN` | `agy` | Path to the Antigravity CLI binary. |
| `AGY_MCP_IDLE_TIMEOUT_MS` | `900000` | Per-run idle timeout in ms (15 min, resets on child output; `0` disables). |
| `AGY_MCP_PRINT_TIMEOUT_MS` | `0` (off) | Hard wall-clock timeout ceiling per run in ms (`0` disables). |
| `AGY_MCP_ROOT` | unset | Directory jail restricting allowed task `cwd` and `edit_scope` paths. |
| `AGY_MCP_STATE_DIR` | `/tmp/agy-agent-mcp/tasks` | Directory for task `.stream` transcripts and `.ndjson` receipts. |
| `AGY_MCP_RETENTION_DAYS` | `7` | Days to retain task transcripts and receipts on startup sweep (`0` disables). |
| `AGY_MCP_DENY_AUTO_APPROVE` | unset | Set to `1` or `true` to disable `auto_approve` across all calls. |

## Development

```sh
npm test               # offline test suite (test/client6.ts, fake agy binary)
node test/client.ts    # maintainer live e2e test (requires agy auth + trusted workspace)
npm run lint           # check formatting and lint rules with Biome
npm run lint:fix       # auto-apply Biome formatting and safe fixes
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup (behavior lives in code and the test suite's summary lines).

MIT, see [LICENSE](LICENSE).

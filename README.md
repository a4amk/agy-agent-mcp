# agy-agent-mcp

[![test](https://github.com/a4amk/agy-agent-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/a4amk/agy-agent-mcp/actions/workflows/ci.yml)

An MCP server that wraps the [Antigravity](https://antigravity.google) CLI (`agy`) as five subagent tools (`general_task`, `explore_task`, `watch_task`, `list_models`, and `list_agents`). Every delegated task is a single headless CLI run (`agy -p "<prompt>" --output-format stream-json`), and **the tool call is the wait** — the call blocks until the child process exits and returns the final report in one shot. While the run is in flight, its work streams live to a human-readable `.stream` transcript on disk.

The server has **zero runtime dependencies** — the small stdio MCP protocol slice it needs is hand-implemented in `src/index.ts`, so `npm install` ships no transitive packages.

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

## Tools

| Tool | Purpose |
| --- | --- |
| `general_task` | Delegate a general-purpose coding task (`--mode accept-edits`, default `effort: "medium"`) and wait for the full report. |
| `explore_task` | Delegate a read-only exploration or diagnosis task (`--mode plan`, default `effort: "low"`) and wait for the report. |
| `watch_task` | Read the live or recent `.stream` transcript (`stream_file` optional, defaults to latest; `tail_lines` `0..2000`, default `400`). |
| `list_models` | List model IDs accepted by `model`. |
| `list_agents` | List agent profiles accepted by `agent`. |

Mode is pinned per tool (`accept-edits` for `general_task`, `plan` for `explore_task`), while `model`, `agent`, and `effort` (`low`, `medium`, `high`, `xhigh`, `max`) are optional per call.

## Watching a run live

Every delegation mirrors live CLI events to `<AGY_MCP_STATE_DIR>/task_<id>.stream` (default `/tmp/agy-agent-mcp/tasks/task_<id>.stream`, also returned as `stream_file`). Tail that file directly (`tail -f /tmp/agy-agent-mcp/tasks/task_<id>.stream`) or call `watch_task` with no arguments from another session to view the latest run.

### Handle-and-watch workflow

In MCP clients that do not render MCP progress notifications (such as OpenCode v2.0.22 or Claude Code, where progress notifications are discarded or buffered while tool results render), use the **handle-and-watch workflow**:
- **Start detached**: pass `background: true` on `general_task` or `explore_task` to start the run in the background and receive a handle immediately (`{ task_id, status: "running", stream_file, transcript_file, started: true, note: "..." }`).
- **Poll progress**: call `watch_task` with `stream_file: "<task_id>"` (or bare ID / latest) to inspect the live transcript as it grows (`running: true`).
- **Retrieve final result**: once the run exits, `watch_task` returns `running: false`, `finished: true`, and includes the enriched final result (`status`, `response`, `duration_seconds`, `usage`, `files_touched`, `scope_violations`, and `progress_bridge`).
- **Cancel a detached run**: pass `cancel: true` on `watch_task` to stop a running detached task immediately (kills the child, releases the lock, and reports the run as cancelled).
- **Read the feed, not the dump**: every `watch_task` report also carries a compact **digest** — `steps` (one entry per completed event: `kind` (`read`/`write`/`run`/`phase`), `label`, `target`, `dur_seconds`, `output`, token usage), plus `step_count`, `phase`, `elapsed_seconds` and `usage_latest`. That is what to render for a live status display; `content` remains the raw transcript tail for detail work.

This handle-and-watch workflow is the way to watch a run live in a client that does not render MCP progress notifications.

MCP clients that opt in by sending a `params._meta.progressToken` on a delegation call also receive the newest transcript lines live as `notifications/progress` during the run (~200ms coalesced per message, monotonic progress counter over mirrored lines, last up to 2 lines each clipped so the payload stays a slice of the transcript). At most **one delegation runs at a time**: a second `general_task` or `explore_task` arriving while one is in flight is rejected with an `isError` envelope naming the running task rather than queued; `watch_task` and the list tools are never blocked. Keep `tail -f` / `watch_task` as the zero-configuration fallback.

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

### Live-follow companion CLI

```sh
npx agy-agent-follow --model gemini-3.8-flash --effort high "summarize the open TODOs in src/ in one paragraph"
```

- Delegates through the same runner as the MCP tools; every mirrored transcript line is printed to stdout as it is written, with the machine-readable result JSON right before exit (exit code `0` only on `status: "success"`).
- `--tool general|explore` switches the posture (`accept-edits` vs read-only `plan`), plus `--cwd` and `--timeout-ms`.
- No `--effort` flag on purpose — the model ID carries its tier, and mixing `--model <tiered-id>` with a conflicting `--effort` is rejected by the `agy` CLI.
- Ctrl-C / SIGTERM kill the in-flight `agy` child (single-flight per process; receipts in the same tasks directory).

## Delegating

- **The call is the wait**: `general_task` and `explore_task` block until the headless `agy` process exits and return the structured report (`response`, `status`, `duration_seconds`, `usage`, `denied_actions`, `files_touched`, `stream_file`, `transcript_file`).
- **Resumable conversations**: each result includes a `conversation_id` UUID when reported by the CLI; pass it back on a subsequent `general_task` or `explore_task` call to continue the thread.
- **Per-call overrides**: pass optional `model`, `agent`, `effort`, `cwd`, `add_dirs`, `project`, `sandbox`, or `auto_approve` (`--dangerously-skip-permissions`, pair with `sandbox`) on any task call.
- **Edit scope auditing**: pass `edit_scope` (files or directories relative to `cwd`, or absolute) to declare the expected edit boundary; when `cwd` is a git repository, the server diffs `git status --porcelain` before and after the run to surface `files_touched` and any out-of-scope `scope_violations` in the result.
- **Idle timeout vs. hard ceiling**: an idle timer kills a silent child after 15 minutes by default (`timeout_ms` per call or `AGY_MCP_IDLE_TIMEOUT_MS`, `0..3600000`, `0` disables) and resets on every stdout or stderr byte, so a productive run is never killed for being slow; set `AGY_MCP_PRINT_TIMEOUT_MS` for an opt-in hard wall-clock ceiling.
- **Headless permissions**: headless runs never prompt and auto-deny gated tools (reported in `denied_actions`); permission allow-rules (such as `command(<prefix>)` under `permissions.allow`) live in your own Antigravity `settings.json`, which this server never edits.

Thinking text is not exposed by the CLI (only thinking token counts), which appear in the `⎿ done in ...` summary lines when `thinking_tokens > 0`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGY_BIN` | `agy` | Path to the Antigravity CLI binary. |
| `AGY_MCP_IDLE_TIMEOUT_MS` | `900000` | Per-run idle timeout in ms (15 min, resets on any child output; `0` disables). |
| `AGY_MCP_PRINT_TIMEOUT_MS` | `0` (off) | Opt-in hard wall-clock timeout per run in ms (`--print-timeout` + runner kill). |
| `AGY_MCP_ROOT` | unset | Directory jail for task `cwd` and `edit_scope` paths. |
| `AGY_MCP_STATE_DIR` | `/tmp/agy-agent-mcp/tasks` | Directory for per-run `task_<id>.ndjson` and `task_<id>.stream` files. |
| `AGY_MCP_RETENTION_DAYS` | `7` | Days to retain `.ndjson` and `.stream` files on startup sweep (`0` disables). |
| `AGY_MCP_DENY_AUTO_APPROVE` | unset | Set to `1` or `true` to ignore `auto_approve` (`--dangerously-skip-permissions`). |

## Development

```sh
npm test               # offline test suite (test/client6.ts, fake agy binary)
node test/client.ts    # maintainer live e2e test (requires agy auth + trusted workspace)
npm run lint           # check formatting and lint rules with Biome
npm run lint:fix       # auto-apply Biome formatting and safe fixes
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and the behavioral reference.

MIT, see [LICENSE](LICENSE).

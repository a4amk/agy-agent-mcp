# agy-agent-mcp

[![test](https://github.com/a4amk/agy-agent-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/a4amk/agy-agent-mcp/actions/workflows/ci.yml)

An MCP server that exposes the [Antigravity](https://antigravity.google) CLI (`agy`) as five tools: subagent-style delegation (`general_task` and `explore_task`), a live transcript viewer (`watch_task`), and discovery helpers (`list_models` and `list_agents`). Every delegated task is one headless CLI run — `agy -p "<prompt>" --output-format stream-json`, spawned as a plain child process from an argv array (no shell, no tmux) — and the tool call blocks until that process exits: **the call is the wait**. Stream events on the child's stdout are mirrored live to a human-readable `.stream` file while the `result` event carries the final report; any non-JSON notices the CLI prints become `notes` in the report.

The machinery this server used to need is gone because headless mode removed the problems it solved:

- no task registry, queue, or concurrency slots — a synchronous call has no lifecycle to track between calls;
- no tmux sessions — there is no interactive pane to attach to;
- no pane polling or turn-end heuristics — process exit is an unambiguous completion signal;
- no chrome stripping — the JSON response is clean text, not a TUI screen;
- no permission-dialog parsing or keystroke relay — headless runs auto-deny requests that would prompt and report them in `denied_actions` (no hang, no dialog);
- no elicitation forms or progress tickers — the report arrives in one shot.

## Install

Published to npm as `agy-agent-mcp`. Node >= 22.6 is required on the host; the TypeScript sources run directly via type stripping (no build step, no `tmux` dependency).

```sh
npm install -g agy-agent-mcp
```

If you prefer not to install globally, use `["npx", "-y", "agy-agent-mcp"]` as the server command instead.

### Register with OpenCode

```sh
opencode mcp add agy --global \
  --env AGY_BIN="$(command -v agy)" \
  -- "$(command -v node)" agy-agent-mcp
```

The tools then appear as `tools.agy.general_task(...)`, `tools.agy.explore_task(...)`, and so on (Code Mode normalizes the server name).

`AGY_BIN` is pinned to an absolute path on purpose: client-spawned processes can have a different `PATH` than your shell, and the child must end up running the same user's logged-in `agy`.

### Register with Claude Code

```sh
claude mcp add agy -- agy-agent-mcp
```

### Register with Antigravity itself

```sh
agy mcp add agy-agent agy-agent-mcp
```

Nested delegation works because child runs inherit the Antigravity login and config. Just don't let an `agy` session delegate work to itself recursively.

### From source

```sh
npm install
opencode mcp add agy --global \
  --env AGY_BIN="$(command -v agy)" \
  -- "$(command -v node)" "$(pwd)/src/index.ts"
```

Or in `opencode.jsonc` by hand:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "agy": {
        "type": "local",
        "command": ["/absolute/path/to/node", "/absolute/path/to/agy-agent-mcp/src/index.ts"],
        "environment": {
          "AGY_BIN": "/absolute/path/to/agy"
        }
      }
    }
  }
}
```

Run `command -v node` and `command -v agy` to fill in the absolute paths.

## Tools

The server registers five tools:

| Tool | What it does |
| --- | --- |
| `general_task` | Delegates a general-purpose coding sub-agent (`--mode accept-edits`, `effort: "medium"` by default, overridable per call) and blocks until the headless run completes; returns the full report. |
| `explore_task` | Delegates a fast read-only exploration and diagnosis sub-agent (`--mode plan`, `effort: "low"` by default, overridable per call); same synchronous runner, with `--mode plan` fixed so the read-only posture cannot be weakened. |
| `watch_task` | Read-only viewer for a task's live human `.stream` transcript (`stream_file` optional — no args picks the latest `task_<id>.stream`; `tail_lines` `0..2000`, default `400`, `0` for full transcript hard-capped at `200,000` chars). |
| `list_models` | Model IDs accepted by `model`. |
| `list_agents` | Antigravity agent profiles accepted by `agent`. |

Both delegation tools (`general_task` and `explore_task`) share one parameter set:

- `prompt` (required) — the task description. The sub-agent gets nothing else, so include project paths and any context you have.
- `cwd` — directory the sub-agent works in. Defaults to the server's own cwd and must exist; when `AGY_MCP_ROOT` is set it has to be inside that directory.
- `conversation_id` — continue an existing Antigravity conversation instead of starting a new one.
- `model`, `agent`, `effort` (`low`, `medium`, `high`, `xhigh`, `max`) — per-call optional Antigravity session settings. There is intentionally no `mode` parameter: each tool's `--mode` preset (`accept-edits` for `general_task`, `plan` for `explore_task`) is fixed at registration so callers cannot weaken the read-only posture of `explore_task`.
- `edit_scope` — orchestrator-chosen allowlist of files and directories (relative to `cwd`, or absolute) the task is expected to edit. Out-of-scope changes are surfaced in the result's `files_touched`/`scope_violations` audit (an audit-and-replay control, not a sandbox).
- `auto_approve` — expert switch: passes `--dangerously-skip-permissions` so headless runs stop auto-denying gated tools (unless blocked by `AGY_MCP_DENY_AUTO_APPROVE=1`). Pair it with `sandbox` when granting it.
- `sandbox` — passes `--sandbox` to the CLI.
- `add_dirs` — extra directories passed as repeatable `--add-dir` flags.
- `project` — Antigravity project ID or name for the task.
- `timeout_ms` — per-run **idle** timeout in ms (`0..3600000`; default: `900000` / 15 minutes via `AGY_MCP_IDLE_TIMEOUT_MS`; `0` disables the idle kill for that run). Every stdout or stderr chunk from the child resets this timer, so a productive long run is never killed for being slow; the child is killed (`SIGTERM`, then `SIGKILL` after 5s) only after this many ms of total child silence, reporting `status: "timeout"`. Headless `agy` can legitimately sit silent for up to ~30 minutes while waiting on background tasks, which is why the default idle window is 15 minutes (tunable up to 60 minutes or `0`) and a hard wall-clock ceiling (`AGY_MCP_PRINT_TIMEOUT_MS`, default `0` = off) is a separate opt-in knob.

`watch_task` takes two optional parameters:

- `stream_file` — omitted to inspect the newest `task_<id>.stream` in `AGY_MCP_STATE_DIR` (by mtime), or set to an absolute path under `AGY_MCP_STATE_DIR`, a bare file name (`"task_f8870173.stream"`), or a task ID (`"task_f8870173"` / `"f8870173"`). Paths escaping `AGY_MCP_STATE_DIR` are rejected.
- `tail_lines` — `0..2000` (default `400`; `0` returns the full transcript, hard-capped at the last `200,000` characters).

## What the result contains

One report object per `general_task` / `explore_task` call:

- `task_id`, `prompt` (echoed, truncated to 200 characters), `cwd` (resolved path), and `opencode_session_id` (when OpenCode attached a session ID in request `_meta`);
- `status` — `success`, `error`, `timeout`, or `quota_error`;
- `response` — the CLI's response text, truncated to the **last 20,000 characters** when longer (with `response_truncated: true`);
- `response_empty` (`true`) and `response_empty_note` — attached when the run succeeded (`status: "success"`) but returned an empty/whitespace response, reminding the caller to check `denied_actions`, `files_touched`, and `notes`;
- `duration_seconds` — from the CLI's `result` event, falling back to measured wall-clock seconds when the CLI omits it; plus `num_turns` and `usage` when reported;
- `conversation_id` — a resumable conversation UUID when the CLI reports one, paired with `resume_hint`;
- `denied_actions` — the tool requests headless mode auto-denied, so the caller can tell the user what was gated;
- `auto_approve_applied` — always reported, so it is obvious when `--dangerously-skip-permissions` was actually in effect;
- `notes` — every non-JSON stdout line plus stderr, capped at **4,000 characters** (stream event lines are excluded; useful when the CLI prints plain-text notices around headless permission denials);
- `files_touched` / `scope_violations` — the git-based audit when the task `cwd` is a git repository, each capped at **50 entries**;
- `stream_file` — absolute path of the run's live plain-text `.stream` transcript;
- `transcript_file` — absolute path of the run's `.ndjson` machine event log;
- `error` and `exit_code` on failure or timeout, and `quota_note` when the quota classifier fires.

`watch_task` returns a read-only viewer report:

- `found` — whether the target `.stream` file exists;
- `file`, `bytes`, `modified` (ISO timestamp) — file metadata when found;
- `running` and `finished` — booleans derived from whether the closing `== done:` line has been written yet (`running` plus `modified` distinguish a live run from an abandoned one);
- `content` — the tailed plain-text transcript, and `clipped: true` (with a leading `…\n` in `content`) when `tail_lines` or the `200,000`-character ceiling clipped earlier output;
- `candidates` (up to 5 recent `task_<id>.stream` filenames, newest first) and `hint` (pointing at the `.ndjson` machine log when a task ID has a `.ndjson` file but no `.stream` twin) when `found` is `false`.

## Watching a run live

While a synchronous delegation call is still in flight, the runner mirrors the CLI's `stream-json` events into `<AGY_MCP_STATE_DIR>/task_<id>.stream` (by default `/tmp/agy-agent-mcp/tasks/task_<id>.stream`, also returned in every task result as `stream_file`). The file is plain text, never truncated mid-run, and can be opened in an editor, tailed with `tail -f`, or inspected via `watch_task` from another session while the delegation is running (or afterwards). Call `watch_task` with no args for the latest run, or pass `stream_file` as an absolute path under the state dir, a bare `task_<id>.stream` filename, or a task ID. The transcript uses the arrows-and-elbows tool-line style familiar from OpenCode/Claude Code and omits timestamps so it stays clean to read; per-event timestamps live in the `.ndjson` log.

- `session open · cwd=<cwd> · permission_mode=<mode> · tools=<n>` — emitted on the `init` event when the CLI session opens;
- step markers — emitted when a `step_update` step opens: `● user_input` and `● agent_response` for non-tool steps, and space-separated directional tool markers matching OpenCode's UI (`→ Read|View|Grep|List <target>`, `← Write|Edit <target>`, `$ <command>` for shell runs, or neutral `● <name> <target>` / `● <name>` for Web, Message, Subagent, `browser_*`, and unknown tools);
- `  ⎿ [<output> · ]done in <duration>s` — emitted on the next line when a tool step reaches `DONE` (`<output> · ` is included when `tool_info.output` is present);
- flowed `agent_response` text — `text_delta` chunks are appended mid-line without trailing newlines so the agent's words stream continuously, closed by a newline when the step reaches `DONE` and followed by `  ⎿ done in <duration>s · <total_tokens> tokens` (plus ` · thinking <thinking_tokens>` when `thinking_tokens > 0`, or `  ⎿ done in <duration>s` when usage is absent). The CLI does not stream thinking text — thinking appears only as token counts in the done lines;
- `== done: status=<status> · <duration>s` — emitted when the `result` event arrives.

```text
session open · cwd=/tmp/probe · permission_mode=request-review · tools=60
● user_input
● agent_response
  ⎿ done in 4.0s · 8093 tokens · thinking 38
← Write /tmp/probe/a.txt
  ⎿ done in 1.8s
● agent_response
  ⎿ done in 5.0s · 2285 tokens · thinking 27
→ Read /tmp/probe/a.txt
  ⎿ 1 lines, 6 bytes · done in 0.02s
● agent_response
<flowed delta text>
  ⎿ done in 17.8s · 2238 tokens · thinking 13
$ git status
  ⎿ done in 1.1s
== done: status=SUCCESS · 29.58s
```

`.stream` files remain on disk after completion for forensics and are swept at startup alongside `.ndjson` event logs under `AGY_MCP_RETENTION_DAYS`.

## Permissions in headless mode

Headless runs never prompt. Tools that would require permission are auto-denied by the CLI — no hang, no dialog — and the denial surfaces in `denied_actions` plus a plain-text note. The decision belongs to the user: allow-rules live in their own Antigravity `settings.json` under `permissions.allow` (grammar such as `command(<prefix>)`, e.g. `command(cat)`), and this server never edits that file. File edits inside the task cwd never prompt (the CLI writes files directly), so edit-heavy tasks run to completion without any approvals; shell commands are the gated vector, and `edit_scope` keeps editors honest about where they changed files.

## How a delegated run works

1. **Validate and snapshot**: `cwd` is resolved (and jailed under `AGY_MCP_ROOT` when set), `edit_scope` entries are resolved against it (escaping entries throw before anything spawns), and `git status --porcelain` is captured when the cwd is a git repository.
2. **Spawn headless**: `agy -p <prompt> --output-format stream-json` plus a flag per set option (`--conversation`, `--agent`, `--model`, `--effort`, `--add-dir` (repeatable), `--project`, `--sandbox`, `--mode plan|accept-edits`, `--dangerously-skip-permissions` when allowed) and `--print-timeout` (`0s` by default so the CLI waits until completion while the runner's idle timer owns termination, or `<AGY_MCP_PRINT_TIMEOUT_MS / 1000>s` when the opt-in hard wall ceiling is configured).
3. **Stream and block until exit**: completion is the child's exit. The runner arms a per-run idle timer (`timeout_ms` or `AGY_MCP_IDLE_TIMEOUT_MS`, 15 minutes by default; `0` disables) that resets on every stdout and stderr chunk, plus an optional hard wall timer when `AGY_MCP_PRINT_TIMEOUT_MS > 0`. If either fires, the runner logs a `timeout` event with `kind: "idle"` or `kind: "wall"` to the `.ndjson` transcript and kills the child (`SIGTERM`, then `SIGKILL` after 5s), reporting `"child idle for <ms>ms; ..."` or `"task exceeded hard cap of <ms>ms; ..."` in `error`. Because headless `agy` may legitimately sit silent for up to ~30 minutes waiting on background tasks, the idle timer is the default guard (15m default, configurable up to 60m or off) and the wall ceiling is strictly opt-in. Each stdout line is parsed once as it arrives: stream events (`init`, `step_update`, `result`) are mirrored live to `stream_file` and never added to `notes`; the inner `result` object of the last `result` event (or the last legacy JSON object line) carries the result fields; non-JSON stdout lines and stderr become `notes` (capped at 4,000 chars). If no result object arrives, the run is an `error` with the exit code and notes preserved.
4. **Map the status**: exit 0 with `SUCCESS` → `success`; a child killed by the idle timer or the opt-in wall ceiling → `timeout`; anything else → `error`. If a failing or empty run shows quota/rate-limit signatures, the status upgrades to `quota_error`. If a `success` run produced an empty response, `response_empty: true` and `response_empty_note` are attached.
5. **Audit**: the run's git snapshot is diffed against a fresh `git status --porcelain` to produce `files_touched` (capped at 50 entries), and `scope_violations` (capped at 50 entries) when `edit_scope` was given.

## Identifiers

| ID | Format | Issued by | Lives as |
| --- | --- | --- | --- |
| OpenCode session | `ses_...` | OpenCode | The client session that made the call; attached automatically in `_meta`, echoed as `opencode_session_id` |
| Task id | `task_........` | this server | Names the run's `.ndjson` event log and `.stream` live transcript; pass to `watch_task` (`stream_file`) to inspect a specific run (nothing to cancel by it) |
| agy conversation | UUID | Antigravity | A resumable conversation when present; pass back as `conversation_id` |

## Examples

One synchronous call with an edit boundary — the result arrives when the run exits:

```json
{
  "tool": "general_task",
  "arguments": {
    "prompt": "In the api project, fix the flaky retry test in src/retry.ts and run the unit test suite.",
    "cwd": "/work/api",
    "edit_scope": ["src/retry.ts", "test/retry.test.ts"]
  }
}
```

Read-only exploration:

```json
{
  "tool": "explore_task",
  "arguments": {
    "prompt": "Trace how authentication tokens are refreshed and summarize the call graph.",
    "cwd": "/work/api"
  }
}
```

Follow-up in the same conversation:

```json
{
  "tool": "general_task",
  "arguments": {
    "prompt": "Now benchmark the fix you just made and report the numbers.",
    "cwd": "/work/api",
    "conversation_id": "<from the previous result>"
  }
}
```

## Quota detection

When a run fails or comes back empty, the response, error, and notes are scanned for quota or rate-limit signatures (HTTP 429, rate limit, credits, billing, model capacity). On a match the status becomes `quota_error` and `quota_note` tells the calling agent to stop and inform the user rather than silently falling back to other agents.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `AGY_BIN` | `agy` | Path to the CLI binary. |
| `AGY_MCP_IDLE_TIMEOUT_MS` | `900000` | Per-run idle timeout in ms (15 minutes). Resets on every stdout or stderr chunk from the child, killing after that much total child silence (`SIGTERM`, then `SIGKILL` after 5s); `0` disables. Overridable per call via `timeout_ms` (`0..3600000`). |
| `AGY_MCP_PRINT_TIMEOUT_MS` | `0` (off) | Opt-in hard wall-clock ceiling per run in ms (`0` = disabled). Passed to the CLI as `--print-timeout` (`0s` when off) and enforced by the runner (`SIGTERM` → 5s → `SIGKILL`, `kind: "wall"`) even while output is still flowing. |
| `AGY_MCP_ROOT` | unset | Edit boundary / directory jail for task `cwd` and `edit_scope` paths. |
| `AGY_MCP_STATE_DIR` | `/tmp/agy-agent-mcp/tasks` | Directory where per-run machine event logs (`task_<id>.ndjson`) and live human stream transcripts (`task_<id>.stream`) are written (`<os.tmpdir()>/agy-agent-mcp/tasks`). |
| `AGY_MCP_RETENTION_DAYS` | `7` | Startup sweep removes stale `.ndjson` and `.stream` files older than this many days; `0` disables the sweep. |
| `AGY_MCP_DENY_AUTO_APPROVE` | unset | Set to `1` or `true` to block `auto_approve` requests (`--dangerously-skip-permissions` is never passed and `auto_approve_applied` reports `false`). |

## Notes

- In the Antigravity CLI, file edits never raise permission prompts (the CLI writes files directly, even outside the workspace) and `--sandbox` does not wall file writes; shell commands are the gated vector. Scope discipline is enforced by the git-based `files_touched`/`scope_violations` audit and the orchestrator's review (revert via `git`), not by a filesystem sandbox that would break normal dev flows (package-manager caches in `$HOME`, etc.).
- Every run appends events (`task_start` with prompt/cwd/args, `spawn`, `exit`, `timeout` with `kind: "idle" | "wall"`, `audit`, `task_end`) to an `.ndjson` log under `AGY_MCP_STATE_DIR`; `transcript_file` in the result points at it, while `stream_file` points at the human-readable `.stream` transcript.
- Resting state lives on disk: after a restart the server starts empty (there was never anything to restore), while retained `.ndjson` and `.stream` logs remain for forensics and `watch_task`.
- On SIGINT/SIGTERM (and on a quiet EPIPE exit) the server kills any in-flight headless run child. A headless child is a one-shot process with no pane a human could resume, so leaving it behind would only orphan model usage in the background.

## Development

```sh
npm run start          # run the server manually over stdio (node src/index.ts)
npm run lint           # check formatting and lint rules (biome check src test bin)
npm run lint:fix       # auto-apply Biome formatting and safe fixes
npm test               # offline suite (node test/client6.ts — fake agy binary, no auth or quota needed)
node test/client.ts    # live e2e test (maintainer-level: requires agy auth + a trusted workspace)
```

`npm test` runs `test/client6.ts` completely offline against fake shell scripts (argv envelopes, `stream-json` parsing and `.stream` rendering, idle/wall timeouts, git audit, startup `.ndjson`/`.stream` sweep, and `watch_task` helpers). `node test/client.ts` runs real headless turns through `agy`. CI (`.github/workflows/ci.yml`) runs `npm ci`, `npm run lint`, and `npm test` on Node 22 for pushes to `main` and pull requests.

Bugs and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT, see [LICENSE](LICENSE).

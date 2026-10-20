# Contributing

## Development setup

Clone the repository and install dependencies:

```sh
git clone https://github.com/a4amk/agy-agent-mcp
cd agy-agent-mcp
npm install
```

Node 22.6 or later is required because TypeScript runs directly via type stripping without a build step. The server runs the CLI headlessly, so no `tmux` is needed. You only need an authenticated Antigravity CLI (`agy`) in your PATH if you want to run the maintainer-level live end-to-end test (`node test/client.ts`).

## Running from source

Start the server locally over stdio:

```sh
npm run start
```

## Linting and formatting

Formatting and linting are enforced with [Biome](https://biomejs.dev/) `2.5.15`, configured in `biome.json` (2-space indentation, double quotes, semicolons, `lineWidth: 120`, default branch `main`):

```sh
npm run lint       # biome check src test bin
npm run lint:fix   # biome check --write src test bin
```

## Running tests

Run the offline test suite and linter before submitting changes:

```sh
npm test               # offline suite (node test/client6.ts — no agy auth or quota needed)
node test/client.ts    # live e2e (maintainer-level: requires agy auth + a trusted workspace)
```

`npm test` (`node test/client6.ts`) uses fake shell scripts and runs completely offline for free — covering argv envelopes, `stream-json` output parsing and `.stream` rendering, idle and opt-in wall-clock timeouts (`kind: "idle"` vs `"wall"`), git-based `files_touched`/`scope_violations` auditing, the startup `.ndjson`/`.stream` retention sweep, and `watch_task` helpers.

`node test/client.ts` is a maintainer-level live end-to-end check that runs real headless turns through `agy` (blocking `general_task`, conversation resume, and `watch_task`) against a trusted workspace and consumes a small amount of model quota.

## Continuous integration

GitHub Actions (`.github/workflows/ci.yml`) runs `npm ci`, `npm run lint`, and `npm test` on Node 22 for pushes to `main` and all pull requests.

## Pull requests

- Target the `main` branch and keep pull requests focused on a single change.
- Use concise, one-line commit messages.
- When adding or modifying delegation tools (`general_task`, `explore_task`), inspection tools (`watch_task`), or discovery tools (`list_models`, `list_agents`), add an entry to the five-tool table in `src/index.ts` (title, description, hand-written `inputSchema` literal, and handler); the `test/goldens/` files capture the exact wire shape and must stay in deep agreement.
- Make sure `npm run lint` and `npm test` pass cleanly before opening a pull request (and `node test/client.ts` when changing live CLI integration).

## Behavioral reference

### Delegation result fields (`general_task` / `explore_task`)

- `task_id` (`task_<8-hex-chars>`) — names both `<AGY_MCP_STATE_DIR>/<task_id>.ndjson` (`transcript_file`) and `<AGY_MCP_STATE_DIR>/<task_id>.stream` (`stream_file`), and is accepted directly by `watch_task` (`stream_file`).
- `status` — `"success"` (exit code `0` and CLI `status: "SUCCESS"`), `"timeout"` (killed by the idle timer or opt-in wall ceiling via `SIGTERM` then `SIGKILL` after 5s), `"quota_error"`, or `"error"`.
- `prompt` — echoed prompt, truncated to 200 characters (`…[truncated N chars]`).
- `cwd` — resolved working directory (validated under `AGY_MCP_ROOT` when set).
- `opencode_session_id` — echoed when OpenCode attaches `ai.opencode/sessionID` (`ses_...`) in request `_meta`.
- `response` — CLI response text, truncated to the **last 20,000 characters** when longer (with `response_truncated: true`).
- `response_empty` (`true`) and `response_empty_note` — attached when `status === "success"` but `response` is empty or whitespace, reminding the caller to check `denied_actions`, `files_touched`, and `notes`.
- `duration_seconds` — taken from the CLI `result` event, falling back to measured wall-clock seconds when omitted; `num_turns` and `usage` are forwarded when reported by the CLI.
- `conversation_id` and `resume_hint` — resumable Antigravity conversation UUID when reported by the CLI.
- `denied_actions` — tool invocations auto-denied by headless mode; `auto_approve_applied` (`boolean`) is always present to record whether `--dangerously-skip-permissions` was actually passed.
- `notes` — all non-JSON stdout lines plus stderr (stream-event lines excluded), capped at **4,000 characters**.
- `files_touched` and `scope_violations` — git porcelain diff before vs. after the run when `cwd` is inside a git work tree, each capped at **50 entries**. `edit_scope` is an audit-and-replay control (the CLI writes files directly without prompting, and `--sandbox` only walls terminal commands); entries escaping `cwd` or `AGY_MCP_ROOT` are rejected before spawn.
- `exit_code`, `error`, and `quota_note` — populated on non-success or quota-classified runs.

### `watch_task` report and `.stream` format

- `stream_file` input accepts an absolute path under `AGY_MCP_STATE_DIR`, a bare `task_<id>.stream` filename, or a task ID (`task_<id>` / `<id>`); omitting it selects the newest `task_<id>.stream` by mtime. Paths escaping `AGY_MCP_STATE_DIR` throw.
- Returns `found`, `file`, `bytes`, `modified` (ISO timestamp), `running` (`!finished`), `finished` (whether a line starting with `== done:` is present or a result event exists in the `.ndjson` receipt), and `content` (last `tail_lines` lines, default `400`, `0` = all lines, hard-capped at the last **200,000 characters** with `clipped: true` and a leading `…\n`).
- When the watched task has finished, the report returns the final result fields (`status`, `response`, `duration_seconds`, `usage`, `files_touched`, `scope_violations`, and `progress_bridge` when present), read durably from the `.ndjson` receipt across sessions and processes. Passing `cancel: true` stops a running detached task (kills the child through the runner's abort path, releases the lock, and returns the final report showing the run cancelled).
- When `found` is `false`, returns up to 5 recent `candidates` (`task_<id>.stream`, newest first) and a `hint` pointing to the `.ndjson` machine log if a twin `task_<id>.ndjson` exists without a `.stream` file.
- `.stream` rendering maps `init` to `session open · cwd=<cwd> · permission_mode=<mode> · tools=<n>`, `step_update` to `● user_input`, `● agent_response` (with flowed `text_delta` chunks and `  ⎿ done in <dur>s · <total_tokens> tokens[ · thinking <thinking_tokens>]`), and directional tool markers (`→ Read|View|Grep|List <target>`, `← Write|Edit <target>`, `$ <command>`, or `● <name>[ <target>]` followed by `  ⎿ [<output> · ]done in <dur>s`), closing with `== done: status=<status> · <dur>s` on `result`.

### Quota detection, lifecycle, and logs

- **Quota detection**: when a run fails (`status !== "success"`) or returns an empty response, `error`, `response`, and `notes` are scanned against quota/rate-limit patterns (`quota`, `rate limit`, `429`, `resource exhaust`, `credit`, `billing`, `usage limit`, `daily limit`, `fast forward`, `model capacity`). Matches upgrade `status` to `"quota_error"` and attach `quota_note` instructing the caller to inform the user rather than silently falling back to another agent.
- **Machine logs & retention**: every run logs `task_start`, `spawn` (or `spawn_error`), `timeout` (`kind: "idle" | "wall"`), `exit`, `audit`, and `task_end` to `<AGY_MCP_STATE_DIR>/task_<id>.ndjson`. At startup, `sweepStateDir()` removes `task_*.ndjson` and `task_*.stream` files older than `AGY_MCP_RETENTION_DAYS` (default `7`; `0` disables).
- **Shutdown**: on `SIGINT`, `SIGTERM`, or an unhandled `EPIPE` when the MCP client closes stdio mid-call, `shutdownRunner()` sends `SIGTERM` (and `SIGKILL` after 5s) to all in-flight headless child processes so orphaned runs do not burn model quota in the background.

### Single-flight lock and progress notifications

- **Single-flight delegation lock**: at most one delegation (`general_task` / `explore_task`) is in flight at a time; a second delegation call arriving while one runs is rejected immediately (not queued) with an `isError` envelope naming the in-flight `task_id` and `stream_file` path (`one agent at a time - retry after it completes`, generic fallback naming the tool when the run has not reported its task yet). The lock engages at `tools/call` dispatch entry and is released in a `finally` (timeout kills and error results release it too); `watch_task`, `list_models`, `list_agents`, and `ping` are never blocked by it.
- **Background delegation lock**: when `background: true` is passed, the delegation returns a handle immediately and the detached run keeps executing in the background; the single-flight lock remains engaged until the run finishes (normal completion, timeout kills, spawn errors, and cancellation all release it exactly once), rejecting concurrent delegations until the run exits.
- **Progress bridge**: only for delegation calls that carry a client-provided `params._meta.progressToken` (absent token = byte-for-byte today's behavior). It is event-driven from the single mirrored `.stream` append site in the runner (fired in the same event-loop turn as the file write), coalesces emissions to at most one `notifications/progress` every ~200 ms with an unref'd timer, and carries a monotonic counter of completed mirrored lines (`progress` starts at `0` with the `task started · stream <basename>` notice; `total` is omitted as unknown). Each message holds the last up to 2 mirrored lines, clipped to 160 chars per line / 400 chars whole; a synchronous final flush always writes the last lines (including the `== done: ...` marker) to the client **before** the result envelope for that call, while a shutdown (SIGINT/SIGTERM/EOF) mid-run may leave the last flush unwritten (acceptable).

### Live-follow companion CLI (`agy-agent-follow`)

- **Follow CLI contract**: `bin/follow.mjs` → `dist/follow.js` calls `runTask` directly (same bridge hooks as the server, no MCP layer, no JSON-RPC): stdout carries exactly the live mirrored `.stream` transcript lines plus the final result JSON (exit code `0` only on `status: "success"`), and stderr gets only the `[agy-agent-follow] tool=<tool> model=<model|default> cwd=<cwd>` meta banner. There is deliberately no `--effort` flag — the model ID carries its tier, and the `agy` CLI rejects `--model <tiered-id>` together with a conflicting `--effort`. `--tool general|explore` pins the same `accept-edits` / `plan` modes as the MCP tools; Ctrl-C (exit 130), SIGTERM (exit 143), and EPIPE kill the in-flight child via `shutdownRunner()`.

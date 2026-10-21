# agy-agent-mcp

[![test](https://github.com/a4amk/agy-agent-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/a4amk/agy-agent-mcp/actions/workflows/ci.yml)

An MCP server that wraps the [Antigravity](https://antigravity.google) CLI (`agy`) as five subagent tools (`general_task`, `explore_task`, `watch_task`, `list_models`, and `list_agents`). Every delegated task is a single headless CLI run (`agy -p "<prompt>" --output-format stream-json`), and **the tool call is the wait** — the call blocks until the child process exits and returns the final report in one shot. That report is the sub-agent's **summary**, not its transcript: the full transcript is written to disk, and a caller pulls the detail only when it asks for it (see [The orchestrator contract](#the-orchestrator-contract)). While the run is in flight, its work streams live to a human-readable `.stream` transcript on disk.

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
| `general_task` | Delegate a general-purpose coding task (`--mode accept-edits`, default `effort: "medium"`) and wait for the full report — one tool call, no polling. |
| `explore_task` | Delegate a read-only exploration or diagnosis task (`--mode plan`, default `effort: "low"`) and wait for the report — one tool call, no polling. |
| `watch_task` | Read the live or recent `.stream` transcript (`stream_file` optional, defaults to latest; `tail_lines` `0..2000`, default `400`); once the run ends, the report carries the complete final result. It is the **on-demand detail channel**, not a second copy of the result — the delegation call already returned the summary, and a poll costs only what it pulls. |
| `list_models` | List model IDs accepted by `model` (`models` = the raw `agy models` output, `model_ids` = the IDs parsed out of it). The CLI only lists tier-carrying IDs, so a bare ID such as `gemini-3.8-flash` usually does not appear in the list. |
| `list_agents` | List agent profiles accepted by `agent` (the raw `agy agents` output). When that command prints nothing the tool says so — it cannot tell an empty agent list from a changed CLI output format. |

Mode is pinned per tool (`accept-edits` for `general_task`, `plan` for `explore_task`), while `model`, `agent`, and `effort` (`low`, `medium`, `high` — the levels the available models accept) are optional per call.

Model IDs come in two shapes: a bare ID (`gemini-3.8-flash`) that takes its tier from `effort`, and a tier-carrying ID (`gemini-3.8-flash-high`, as returned by `list_models`) that already encodes it. The CLI's own model list only carries the tier-carrying shape, so a bare ID is usually absent from `list_models` even though it is still a valid `model` argument. A tier-carrying ID wins over `effort`: no `--effort` flag is passed for it, and combining it with a *different* effort is refused locally (the `agy` CLI rejects that combination outright).

The id-like arguments (`model`, `agent`, `project`, `conversation_id`) are trimmed before they reach the CLI — the CLI compares them verbatim, so `" gemini-3.8-flash "` would be an unknown model — and the trimmed value is what the error messages quote. The `prompt` is passed through verbatim (leading whitespace may be meaningful).

Call arguments are validated against the schema the server advertises in `tools/list`, before anything is spawned: a missing, empty, or whitespace-only `prompt`, a wrong-typed or out-of-range argument (`timeout_ms` `0..3600000`, `tail_lines` `0..2000`, `effort` `low|medium|high`), and an unknown argument key are all refused with the usual `{"error": "..."}` envelope (`isError: true`), and the message names the offending argument. A refused call starts no task, writes no transcript, and releases the single-flight lock.

The discovery tools (`list_models`, `list_agents`) report failures as failures: when `agy models` / `agy agents` cannot be started (missing binary), exits non-zero, or does not finish within 30 s, the tool answers with the usual `{"error": "..."}` envelope (`isError: true`) — the message names the command, the failure mode and (when there is one) the exit code, and keeps the captured output inside it. A crash is never dressed up as a model list. A command that succeeds but prints nothing is **not** an error: `list_models` then says so in `models` and returns an empty `model_ids` (with a `note`), and `list_agents` reports that no custom agents are configured. `model_ids` holds the IDs parsed out of the CLI's output: a line is an ID when it contains a TAB, and the ID is the text before that TAB (the `Fetching available models...` header is not an ID).

One caveat on `list_agents`: `agy agents` prints nothing on many installations, so the tool reports "no custom agents configured" for *any* silent success — it cannot distinguish "there are none" from "the CLI changed its output format". Treat the answer as "the CLI listed nothing", not as a fact about the agent set, and check `agy agents` yourself if a custom `agent` matters.

## Watching a run live

Every delegation mirrors live CLI events to `<AGY_MCP_STATE_DIR>/task_<id>.stream` (default `/tmp/agy-agent-mcp/tasks/task_<id>.stream`, also returned as `stream_file`). Tail that file directly (`tail -f /tmp/agy-agent-mcp/tasks/task_<id>.stream`) or call `watch_task` with no arguments from another session to view the latest run. The transcript lives on disk — it is never part of the delegation result, and the `.stream` file is a live feed that works in every client (`watch_task` gives a polled view of the same file).

### Handle-and-watch workflow

MCP clients differ in whether they render `notifications/progress`: **OpenCode discards them** (its MCP client installs a no-op `onprogress` handler), while **Claude Code renders them since v2.1.153** (2026-05-28 — the regression tracked in `anthropics/claude-code#51713` was closed with "This issue was fixed as of version 2.1.153"). `notifications/progress` is the only spec-compliant way to stream during an in-flight tool call, because MCP has no streaming tool responses: a `tools/call` returns exactly one `CallToolResult` (see the [MCP progress spec](https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/progress)).

In a client that does not render progress notifications, use the **handle-and-watch workflow**:
- **Start detached**: pass `background: true` on `general_task` or `explore_task` to start the run in the background and receive a handle immediately (`{ task_id, status: "running", stream_file, transcript_file, started: true, note: "..." }`). A detached run emits **no** MCP progress notifications — an MCP progress notification only belongs to a request that is still in flight, and a detached call has already been answered — so `watch_task` is its progress channel.
- **Poll progress**: call `watch_task` with `stream_file: "<task_id>"` (or bare ID / latest) to inspect the live transcript as it grows (`running: true`). Polling is the *agent's* loop here: in a client that renders no progress notifications the human watches collapsed tool calls, and the transcript is what the agent reads between polls.
- **Retrieve final result**: once the run exits, `watch_task` returns `running: false`, `finished: true`, and carries the **complete** final result — every field of the durable receipt, the same result `general_task`/`explore_task` returns (`status`, `response`, `error`, `notes`, `exit_code`, `usage`, `conversation_id`, `num_turns`, `denied_actions`, `quota_note`, `files_touched`, `scope_violations`, `resume_hint`, …). A failed run therefore says *why* it failed, not just that it failed.
- **Cancel a detached run**: pass `cancel: true` on `watch_task` to stop a running detached task immediately (kills the child, releases the lock, and reports the run as cancelled). The cancel path is **in-process**: it can only stop a run that *this* server process started — a detached run owned by another server process keeps running and is still reported as `running: true`.
- **Read the feed, not the dump**: every `watch_task` report that finds a transcript also carries a compact **digest** — `steps` (one entry per completed event: `kind` (`read`/`write`/`run`/`phase`), `label`, `target`, `dur_seconds`, `output`, token usage), plus `step_count`, `phase`, `elapsed_seconds` and `usage_latest`. That is what to render for a live status display; `content` remains the raw transcript tail for detail work. The digest is a **bounded window**: `steps` holds the 50 most recent steps (oldest first), while `step_count` reports the **total** number of steps — so `step_count > steps.length` tells you the window was clipped, and a long run cannot blow up the report. A report that found no transcript carries no digest and no result fields at all: exactly `found` and `candidates` for the no-argument form, and `found`, `file` and `candidates` (plus `hint` when the `.ndjson` twin exists) when a `stream_file` was given.

The handle-and-watch workflow is **not** live watching: it gives you a handle to collect from and a report you can poll. In a client that renders no progress notifications, the human sees collapsed tool calls while the agent polls — the live feed a human can watch is the `.stream` file (`tail -f`), and that works in every client.

MCP clients that opt in by sending a `params._meta.progressToken` on a delegation call also receive the newest transcript lines live as `notifications/progress` during the run (~200ms coalesced per message, monotonic progress counter over mirrored lines, last up to 2 lines each clipped so the payload stays a slice of the transcript). That bridge is the **only** in-call streaming channel MCP offers, but it is a thin one: a frame carries the newest *mirrored lines* — step markers and the lines a step has completed — not the live narration, because a narration chunk is only counted once its line is terminated. The narration itself is written to the `.stream` file as it is produced and is available live through `watch_task` / the `.stream` file in every client, whether or not that client renders progress notifications.

The bridge covers the **in-flight** call only: a detached (`background: true`) delegation has already returned its handle, so it emits no progress notifications at all and a `progressToken` on it is ignored — follow such a run with `watch_task`. At most **one delegation runs at a time**: a second `general_task` or `explore_task` arriving while one is in flight is rejected — not queued — with the usual `{"error": "..."}` envelope (`isError: true`), whose message names the running task id and its stream file; `watch_task` and the list tools are never blocked. Keep `tail -f` / `watch_task` as the zero-configuration fallback.

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
- `--effort low|medium|high` sets the reasoning tier; a model ID that already carries one (e.g. `gemini-3.8-flash-high`) must not repeat a different tier — that combination is refused locally, before any task is spawned.
- Ctrl-C / SIGTERM kill the in-flight `agy` child (single-flight per process; receipts in the same tasks directory).

## Delegating

- **The call is the wait**: `general_task` and `explore_task` block until the headless `agy` process exits and return the structured report (`response`, `status`, `duration_seconds`, `usage`, `denied_actions`, `files_touched`, `stream_file`, `transcript_file`).
- **One call, one report**: that report is the *complete* result of the run, returned in **one** tool call — the call is the wait, so there is nothing to poll and no extra call to make, and the caller's context pays for the summary only. The detached flow (`background: true`) exists to *start* a run and collect it later, and it costs that extra call: the handle comes back immediately, and the result is then only reachable through `watch_task` (or the `.ndjson` receipt on disk).
- **Failures are failures**: a run that did not succeed comes back with `isError: true` on the tool result and `status` `"error"`, `"timeout"` or `"quota_error"`. `error` carries the CLI's own failure message (verbatim) when it reported one, `exit_code` carries the process exit code, and `notes` keeps the CLI's non-JSON stdout plus stderr. A failed run is never described as a clean exit: the server never writes `code 0` into `error` (the CLI's own message is surfaced verbatim even when it says so itself).
- **A malformed result event never vanishes**: if the CLI prints a `result` event whose `result` is not an object (a string, `null`, an array), the raw line is kept in `notes` (you see exactly what the CLI printed), the `.stream` transcript carries a trace of it (`== result event: unusable …`), and `error` says the *result event was not usable* — it is never described as "no JSON result line in output", because a JSON line *was* printed. A run that printed no result event at all keeps that older wording.
- **Resumable conversations**: each result includes a `conversation_id` UUID when reported by the CLI; pass it back on a subsequent `general_task` or `explore_task` call to continue the thread.
- **Per-call overrides**: pass optional `model`, `agent`, `effort`, `cwd`, `add_dirs`, `project`, `sandbox`, or `auto_approve` (`--dangerously-skip-permissions`, pair with `sandbox`) on any task call.
- **Effort defaults**: without an explicit `effort`, `general_task` runs at `medium` and `explore_task` at `low`; a tier-carrying model ID (as returned by `list_models`) overrides that default, because its tier is already part of the ID.
- **Edit scope auditing**: pass `edit_scope` (files or directories relative to `cwd`, or absolute) to declare the expected edit boundary; when `cwd` is a git repository, the server diffs `git status --porcelain` before and after the run to surface `files_touched` and any out-of-scope `scope_violations` in the result.
- **Idle timeout vs. hard ceiling**: an idle timer kills a silent child after 15 minutes by default (`timeout_ms` per call or `AGY_MCP_IDLE_TIMEOUT_MS`, `0..3600000`, `0` disables) and resets on every stdout or stderr byte, so a productive run is never killed for being slow; set `AGY_MCP_PRINT_TIMEOUT_MS` for an opt-in hard wall-clock ceiling.
- **Shutdown reaps every child**: when the MCP client disconnects (stdin EOF) or the server gets SIGINT/SIGTERM, the in-flight children are killed (`SIGTERM`, then `SIGKILL` after 1.5 s) — the delegation run *and* a hanging discovery command (`agy models` / `agy agents`) — so no orphaned `agy` process is left burning quota in the background.
- **Headless permissions**: headless runs never prompt and auto-deny gated tools (reported in `denied_actions`); permission allow-rules (such as `command(<prefix>)` under `permissions.allow`) live in your own Antigravity `settings.json`, which this server never edits.
- **The default posture's blind spot**: a headless run whose tool requests were *all* auto-denied still comes back as `status: "success"` with an empty `response` — the CLI reports the denial, it does not fail the run. Do not read such a "success" as "the work was done": check `response_empty` (with its `response_empty_note`), `denied_actions` and `notes` first. An empty success normally means the sub-agent was never allowed to run the tools it needed, not that there was nothing to do.

Thinking text is not exposed by the CLI (only thinking token counts), which appear in the `⎿ done in ...` summary lines when `thinking_tokens > 0`.

## The orchestrator contract

This server exists for *orchestrator* agents that delegate work to an `agy` sub-agent, so a delegation must not flood the orchestrator's context. The contract it actually keeps:

- **The result is the summary, not the transcript.** A delegation result carries the sub-agent's final `response` — its summary — plus the facts an orchestrator needs to act on it: `status`, `usage`, `files_touched` (when `cwd` is a git repo), `scope_violations` (when `cwd` is a git repo **and** `edit_scope` was given), `error`, `exit_code`, `conversation_id` and `resume_hint`. For a realistic run that is about **1 200 characters (~300 tokens)** of JSON. The transcript length does not land in the result: `response` keeps the last 20 000 characters, `notes` is capped at 4 000 characters, `files_touched` / `scope_violations` at 50 entries each.
- **The transcript is on disk, never in the result.** `transcript_file` (the `.ndjson` machine log) and `stream_file` (the human-readable `.stream` mirror) point at it — the result carries the paths, not the text.
- **`watch_task` is the on-demand detail channel, not a second way to get the result.** The caller already has the summary; `watch_task` exists to pull the *detail* — the transcript tail and the step digest — when it needs it, and it pays only for what it pulls: `tail_lines` bounds the raw tail (default `400` lines, hard cap 200 000 characters) and the digest is a bounded window over the 50 most recent steps.
- **The progress bridge is the only in-call streaming channel MCP offers, and whether it is seen is up to the client.** A foreground delegation carrying a `_meta.progressToken` streams `notifications/progress` while the call is in flight; OpenCode discards those frames, Claude Code renders them since v2.1.153. The bridge carries the newest mirrored lines, not the live narration — the narration is available live through `watch_task` / the `.stream` file in every client.

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

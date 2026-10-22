# Changelog

## Unreleased

- **Concurrent delegations are now allowed**: any number of `general_task` and `explore_task` calls may run concurrently; a second delegation is no longer refused (`another delegation is already running` is removed).
- Each concurrent run executes as an independent child process with its own transcript file and final result.
- `watch_task(cancel: true)` now acts on the run named by the caller via `stream_file` or task ID; cancelling without `stream_file` when multiple runs are in flight is safely ignored with an ambiguity hint.
- The shutdown drain now awaits every in-flight detached (`background: true`) run on client disconnect so every receipt is written.
- Concurrent delegations sharing a working tree in a git repository now carry an `audit_note` explaining that `files_touched` and `scope_violations` may reflect changes from other concurrent runs.
- Cancelling a detached run via `notifications/cancelled` no longer removes its registry entry before the child settles, ensuring the cancellation receipt is written even if the client disconnects immediately.
- `watch_task(cancel: true)` without a `stream_file` when exactly one delegation is in flight now returns the report for the cancelled delegation rather than resolving the newest transcript by file modification time.
- The ambiguity hint for `watch_task(cancel: true)` when multiple delegations are in flight is now always attached even if the transcript resolved by `watch_task` was already finished.


## 0.3.0 - 2026-10-21

### Breaking changes

This release is a minor bump: the following change what a caller observes.

- **Unknown argument keys are refused.** A call carrying a key that is not in the tool's `inputSchema` used to be accepted and the key ignored; it is an error now and nothing is spawned. *Migration: send only the keys the tool's `inputSchema` declares.*
- **Wrong-typed arguments are refused**, including `null` for an optional argument — a mistyped value used to be silently dropped (so `auto_approve: "true"` silently meant **false**). *Migration: omit an optional argument you do not want instead of sending `null` or `""`.*
- **A failed delegation returns `isError: true`** on the tool result (it used to be `false`, with the failure only in the body). *Migration: read `status` as well as `isError` if you branch on the outcome.*
- **`error` carries the CLI's own failure message verbatim** instead of the generic `"agy exited with code N"`. *Migration: do not match the old wording; surface the message as-is.*
- **The single-flight rejection body is the `{"error": "..."}` envelope**, not a plain-text `"MCP error: ..."` block. *Migration: parse the rejection body as JSON.*
- **A run whose tool requests were all auto-denied and that produced no output is `status: "error"`**, not a `"success"` with an empty response. *Migration: read the error text / `denied_actions` to tell "blocked" from "done".*
- **A detached (`background: true`) run survives the client disconnect** — the server lingers until the run ends and writes its receipt, instead of killing the run. Every other child is still reaped at the disconnect, and `SIGINT`/`SIGTERM` still kill everything at once. *Migration: the server process now lingers for the duration of a detached run; the run's result is still collectable from any client that can see the state dir.*
- **A failed `list_models` / `list_agents` answers with the error envelope**, not a `models` / `agents` field. *Migration: handle `isError` on the two discovery tools.*
- **The watch digest holds at most the 50 most recent steps** (it used to hold every step), while `step_count` keeps reporting the total. *Migration: read `step_count` for the total.*

- added handle-and-watch workflow: detached delegations (background: true), enriched watch_task result retrieval, and detached run cancellation
- added agy-agent-follow live-follow companion CLI (bin/follow.mjs + src/follow.ts)
- fixed effort handling: the documented default effort is really applied now (general_task runs at medium, explore_task at low), a tier-carrying model id wins over it (no --effort is passed for it), a conflicting effort is refused locally before anything is spawned, and only low|medium|high are accepted
- fixed failure reporting: a failed delegation comes back with isError true and carries the CLI's own failure message verbatim, plus the notes and the exit code (behaviour change: a failed run is flagged on the tool envelope, and a successful run now carries exit_code as well)
- fixed input validation: call arguments are validated against the schema the server advertises, so a missing, empty or whitespace-only prompt, wrong types, out-of-range numbers and unknown argument keys are refused before anything is spawned (behaviour change: a mistyped or unknown argument is an error now instead of being silently ignored)
- fixed watch_task reporting: the report carries the complete final result, so a failed run says why it failed instead of only that it failed
- fixed progress notifications: a detached delegation (background: true) emits no notifications/progress at all, and watch_task is its progress channel
- fixed discovery reporting: list_models and list_agents report a failing command as an error instead of dressing a crash up as a result, and list_models also exposes the parsed model_ids plus a note when the output yielded none (behaviour change: a failed discovery call answers with an error envelope, not a models/agents field, and a successful one now carries the model_ids and note fields)
- fixed model ids: the id-like arguments (model, agent, project, conversation_id) are trimmed before they reach the CLI, so a padded id is no longer an unknown model, agent or project
- fixed the single-flight rejection: it uses the same `{"error": "..."}` envelope as every other refusal, so its body parses as JSON (behaviour change: the rejection body is no longer a plain-text "MCP error: ..." block)
- fixed the discovery child: an `agy models` / `agy agents` child is reaped on shutdown (client disconnect, SIGINT, SIGTERM) like a delegation child, instead of being orphaned when the client disconnects
- fixed the malformed result event: a CLI `result` event whose `result` is not an object (a string, `null`, an array) no longer vanishes - the raw line is kept in `notes`, the `.stream` transcript carries a trace of it (`== result event: unusable ...`), and the failure wording says the result event was not usable instead of claiming that no JSON line was printed (behaviour change: the error wording of such a run differs from the wording of a run that printed no result event at all)
- fixed the receipt parser: an array (or any other non-object) in a `.ndjson` result event is not accepted as a receipt any more, so `watch_task` no longer reports its elements as the numeric fields "0", "1", ...
- fixed the watch digest: it is a bounded window over the 50 most recent steps (oldest first) while `step_count` keeps reporting the total number of steps, so a long run no longer costs a huge report on every poll (behaviour change: `steps` holds at most 50 entries - the most recent ones - and `step_count > steps.length` says the window was clipped)
- fixed blocked runs: a run whose tool requests were all auto-denied and that therefore produced no output at all is no longer reported as a success - it comes back with isError true, status "error" and an error that names the denied action and the way out (auto_approve: true, or a permissions.allow rule in your own Antigravity settings.json), and watch_task carries the same verdict (behaviour change: such a run used to be a "success" with an empty response; a denial that still produced a response, and a silent success without any denial, stay successes)
- made the ignored cancel visible: a watch_task(cancel: true) for a run this server process does not own (the cancel path acts on the module-level activeDelegation, so it can only stop a run this process started) now carries a hint saying the cancel was ignored, the run is in flight and owned by another server process, and only that process can cancel it (behaviour change: such a report now has a hint field; a cancel that works and a cancel for a finished run carry no hint)
- fixed the detached run: a background (detached) run now survives the client disconnect - on stdin EOF the server waits for the run to finish, writes its receipt and only then exits, so the result stays collectable from any client that can see the state dir (behaviour change: the server process lingers for the duration of the run instead of killing it; every other child - an abandoned foreground call, a hanging `agy models` / `agy agents` - is still reaped at the disconnect, and a SIGINT/SIGTERM still kills every child and exits the server at once)
- added a release script: `npm run release -- <version>` prepares the version bump (`package.json` and `package-lock.json`), the changelog heading and the goldens in one command, runs the gates and creates the `chore(release): <version>` commit (it never pushes, tags or publishes - the maintainer does that, and a failed run puts the working tree back the way it was)
- fixed the initialize goldens: the suite compares `serverInfo.version` exactly now, so a golden can no longer drift away from `package.json` unnoticed

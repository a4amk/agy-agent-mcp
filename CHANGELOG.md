# Changelog

## Unreleased

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

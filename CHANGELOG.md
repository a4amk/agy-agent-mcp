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

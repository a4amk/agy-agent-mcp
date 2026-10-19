/**
 * Live E2E test:
 * - `general_task` runs the real Agantigravity CLI headlessly and the call
 *   blocks until the run exits (the tool call IS the wait; there is no
 *   wait_task/polling surface anymore)
 * - verifies the report: status success, resumable conversation_id, OpenCode
 *   session tagging via `_meta["ai.opencode/sessionID"]`, and that pane-era
 *   fields (tmux/attach/pending_prompt) are truly gone
 * - a second call resumes the same conversation and asserts the follow-up ran
 *   (num_turns >= 2) and references the first prompt
 */

import { existsSync, mkdirSync, statSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

// A workspace the CLI already trusts keeps the live run cheap and
// deterministic (a fresh directory can hang the headless run on intake).
const CWD = "/tmp/opencode/agy-tmux-test";
mkdirSync(CWD, { recursive: true });

const transport = new StdioClientTransport({
  command: "node",
  args: ["src/index.ts"],
  cwd: process.cwd(),
  stderr: "inherit",
});

const client = new Client({ name: "test-client", version: "0.1.0" });
await client.connect(transport);

function parse(resp: { content?: Array<{ text?: string }> }) {
  return JSON.parse(resp.content?.[0]?.text ?? "{}");
}

async function call(name: string, args: Record<string, unknown>, sessionID?: string) {
  const params = {
    name,
    arguments: args,
    ...(sessionID ? { _meta: { "ai.opencode/sessionID": sessionID } } : {}),
  };
  return parse(await client.request({ method: "tools/call", params }, CallToolResultSchema));
}

const tools = await client.listTools();
const toolNames = tools.tools.map((t) => t.name);
console.log("tools:", toolNames.join(", "));
for (const expected of ["general_task", "explore_task", "watch_task", "list_models", "list_agents"]) {
  if (!toolNames.includes(expected)) {
    throw new Error(`expected ${expected} in registered tools`);
  }
}
for (const legacy of [
  "wait_task",
  "get_task",
  "list_tasks",
  "cancel_task",
  "start_task",
  "delegate_task",
  "usage_totals",
]) {
  if (toolNames.includes(legacy)) {
    throw new Error(`legacy tool ${legacy} should not be registered anymore`);
  }
}

const SESSION_ID = "ses_e2e_headless";
const WORD = "parsnip";
const first = await call(
  "general_task",
  {
    prompt: `Remember this word for later: ${WORD}. Reply with exactly: ${WORD}`,
    cwd: CWD,
    effort: "low",
  },
  SESSION_ID
);
console.log(
  "first:",
  JSON.stringify({
    status: first.status,
    conversation_id: first.conversation_id,
    num_turns: first.num_turns,
    duration_seconds: first.duration_seconds,
    auto_approve_applied: first.auto_approve_applied,
    response: (first.response ?? "").trim(),
  })
);

if (first.status !== "success") {
  throw new Error(`expected status=success, got ${first.status} (${first.error ?? ""})`);
}
if (first.opencode_session_id !== SESSION_ID) {
  throw new Error(`expected opencode_session_id=${SESSION_ID}, got ${first.opencode_session_id}`);
}
if (!/^[0-9a-f-]{36}$/.test(first.conversation_id ?? "")) {
  throw new Error(`expected a resumable conversation_id, got ${first.conversation_id}`);
}
if (typeof first.task_id !== "string" || !first.task_id.startsWith("task_")) {
  throw new Error(`expected a task_id transcript handle, got ${first.task_id}`);
}
if (typeof first.stream_file !== "string" || !existsSync(first.stream_file) || statSync(first.stream_file).size === 0) {
  throw new Error(`expected a non-empty stream_file on disk, got ${first.stream_file}`);
}
if (!first.response?.includes(WORD)) {
  throw new Error(`response missing ${WORD}: ${first.response}`);
}
if (first.auto_approve_applied !== false) {
  throw new Error("auto_approve must not be applied on default calls");
}
for (const gone of ["tmux_session", "attach_command", "pending_prompt", "pane_tail", "pane_changed"]) {
  if (gone in first) {
    throw new Error(`pane-era field ${gone} must not appear in the headless result`);
  }
}

const second = await call("general_task", {
  prompt: `What word did I ask you to remember just now? Answer with only that word.`,
  cwd: CWD,
  conversation_id: first.conversation_id,
  effort: "low",
});
console.log(
  "second:",
  JSON.stringify({
    status: second.status,
    conversation_id: second.conversation_id,
    num_turns: second.num_turns,
    response: (second.response ?? "").trim(),
  })
);

if (second.status !== "success") {
  throw new Error(`expected status=success on the resumed call, got ${second.status} (${second.error ?? ""})`);
}
if (second.conversation_id !== first.conversation_id) {
  throw new Error("resumed call must stay in the same conversation");
}
if (typeof second.num_turns !== "number" || second.num_turns < 2) {
  throw new Error(`resumed call must show num_turns >= 2, got ${second.num_turns}`);
}
if (!second.response?.includes(WORD)) {
  throw new Error(`resumed response does not reference the first prompt (${WORD}): ${second.response}`);
}

const watched = await call("watch_task", {});
console.log(
  "watch_task:",
  JSON.stringify({
    found: watched.found,
    file: watched.file,
    bytes: watched.bytes,
    modified: watched.modified,
    running: watched.running,
    finished: watched.finished,
    content_len: (watched.content ?? "").length,
  })
);
if (
  watched.found !== true ||
  typeof watched.file !== "string" ||
  !watched.file.endsWith(".stream") ||
  typeof watched.bytes !== "number" ||
  typeof watched.modified !== "string" ||
  typeof watched.running !== "boolean" ||
  typeof watched.finished !== "boolean" ||
  typeof watched.content !== "string" ||
  watched.content.length === 0
) {
  throw new Error(`watch_task returned unexpected shape: ${JSON.stringify(watched)}`);
}

await client.close();
console.log("=== LIVE E2E PASS ===");

/**
 * Offline tests — no real agy binary, no model usage:
 * 1. Print-mode output parsing (`parseResultLine`) and quota classification.
 * 2. Headless runs against fake `agy` scripts (child processes so the AGY_*
 *    env is isolated per scenario):
 *    - argv envelope: exact minimal args, every optional flag only when set,
 *      `--print-timeout` conversion, `--dangerously-skip-permissions` allowed
 *      vs denied (AGY_MCP_DENY_AUTO_APPROVE=1);
 *    - stdout noise + stream-json result: stream events mirror to `.stream`
 *      and stay out of notes, the result event's inner object wins, plain-text
 *      lines plus stderr land in notes;
 *    - malformed output (stream with no result event) -> status error;
 *      exit 3 + 429 noise + result event -> quota_error;
 *    - timeout: SIGTERM kill, `timeout` event in the ndjson log, no zombie.
 * 3. `runTask` rejects bad cwd / escaping edit_scope before anything spawns.
 * 4. Git-based audit (`captureFilesBefore` / `auditTaskFiles`) and
 *    `resolveEditScope` boundary checks.
 * 5. Startup sweep removes stale `.ndjson` and `.stream` logs only.
 * 6. `watch_task` helpers and installed-artifact boot: `listStreamFiles` /
 *    `readStreamTail`, then `bin/mcp.mjs` -> dist build answers a real MCP
 *    handshake (npm installs must ship compiled JS — Node refuses to
 *    type-strip files under node_modules), and the MCP-advertised version
 *    matches package.json.
 * 7. Protocol parity over stdio: the whole `test/goldens/` capture scenario
 *    replayed step-by-step against `bin/mcp.mjs` (stub AGY_BIN) — every
 *    response deep-equals its golden file (initialize serverInfo.version
 *    checked against package.json), garbage lines and notifications stay
 *    silent, duplicate initialize is answered, the boot banner is exact, and
 *    stdin EOF exits cleanly.
 * 8. Zero runtime dependencies: package.json has no (empty) dependencies
 *    field, src/index.ts imports neither the MCP SDK nor zod, and a
 *    production `npm install` of the package materializes neither
 *    `@modelcontextprotocol` nor `zod`.
 */
import { execFile, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const runner = await import("../src/agy.ts");

// ---------------------------------------------------------------------------
// 1. Output parsing + quota classification
// ---------------------------------------------------------------------------
const PRINTED = [
  "notice: workspace trust handled automatically",
  '{"conversation_id":"stale-c1","status":"RUNNING","response":"partial","num_turns":0}',
  "notice two",
  '{"conversation_id":"final-c1","status":"SUCCESS","response":"hey","num_turns":1}',
].join("\n");
const parsed = runner.parseResultLine(PRINTED);
if (parsed.json?.conversation_id !== "final-c1" || parsed.json.num_turns !== 1 || parsed.json.status !== "SUCCESS") {
  throw new Error("parseResultLine must take the LAST parseable JSON object line");
}
if (parsed.noise.length !== 3 || !parsed.noise.some((l) => l.includes("stale-c1"))) {
  throw new Error(`parseResultLine must keep non-result lines as noise: ${JSON.stringify(parsed.noise)}`);
}
const parsedNone = runner.parseResultLine("artisanal boot spill\n[1,2]\n{oops");
if (parsedNone.json !== null || parsedNone.noise.length !== 3) {
  throw new Error("parseResultLine must return null JSON and keep noise when nothing parses");
}
const parsedMix = runner.parseResultLine('["array","not-object"]\n42\n{"ok":true}\n');
if (parsedMix.json?.ok !== true || parsedMix.noise.length !== 2) {
  throw new Error("parseResultLine must reject arrays/numbers as result lines");
}
console.log("parseResultLine: last-JSON-wins, noise separation, non-object rejection: ok");

if (
  !runner.looksLikeQuotaIssue("Error: quota exceeded for this project") ||
  !runner.looksLikeQuotaIssue("HTTP 429 received from model backend") ||
  runner.looksLikeQuotaIssue("command not found")
) {
  throw new Error("looksLikeQuotaIssue classifier regression");
}
console.log("looksLikeQuotaIssue: ok");

if (
  runner.renderToolStep({
    state: "ACTIVE",
    tool_name: "write_file",
    tool_info: { name: "write_file", parameters: { Path: "/tmp/opencode/agy-tmux-test/probe.txt" } },
  }).marker !== "← Write /tmp/opencode/agy-tmux-test/probe.txt" ||
  runner.renderToolStep({
    state: "DONE",
    tool_name: "write_file",
    duration_seconds: 1.816,
    tool_info: { name: "write_file", parameters: { Path: "/tmp/opencode/agy-tmux-test/probe.txt" } },
  }).done !== "  ⎿ done in 1.816s" ||
  runner.renderToolStep({
    state: "ACTIVE",
    tool_name: "read_file",
    tool_info: { name: "read_file", parameters: { Path: "/tmp/a.txt" } },
  }).marker !== "→ Read /tmp/a.txt" ||
  runner.renderToolStep({
    state: "DONE",
    tool_name: "read_file",
    duration_seconds: 0.027,
    tool_info: { name: "read_file", parameters: { Path: "/tmp/a.txt" }, output: "1 lines, 6 bytes" },
  }).done !== "  ⎿ 1 lines, 6 bytes · done in 0.027s" ||
  runner.renderToolStep({
    state: "ACTIVE",
    tool_name: "view_file",
    tool_info: { parameters: { Path: "/tmp/a.txt" } },
  }).marker !== "→ View /tmp/a.txt" ||
  runner.renderToolStep({
    state: "ACTIVE",
    tool_name: "grep_search",
    tool_info: { parameters: { Query: "needle" } },
  }).marker !== "→ Grep needle" ||
  runner.renderToolStep({
    state: "ACTIVE",
    tool_name: "list_dir",
    tool_info: { parameters: { DirectoryPath: "/tmp" } },
  }).marker !== "→ List /tmp" ||
  runner.renderToolStep({
    state: "ACTIVE",
    tool_name: "replace_file_content",
    tool_info: { parameters: { Path: "/tmp/a.txt" } },
  }).marker !== "← Edit /tmp/a.txt" ||
  runner.renderToolStep({
    state: "ACTIVE",
    tool_name: "run_command",
    tool_info: { parameters: { Command: "ls -la" } },
  }).marker !== "$ ls -la" ||
  runner.renderToolStep({
    state: "ACTIVE",
    tool_name: "run_command",
    tool_info: { parameters: {} },
  }).marker !== "● Run" ||
  runner.renderToolStep({
    state: "ACTIVE",
    tool_name: "search_web",
    tool_info: { parameters: { query: "mcp spec" } },
  }).marker !== "● Web mcp spec" ||
  runner.renderToolStep({
    state: "ACTIVE",
    tool_name: "send_message",
    tool_info: { parameters: { Message: "ping" } },
  }).marker !== "● Message ping" ||
  runner.renderToolStep({
    state: "ACTIVE",
    tool_name: "invoke_subagent",
    tool_info: { parameters: { Prompt: "audit step rendering" } },
  }).marker !== "● Subagent audit step rendering" ||
  runner.renderToolStep({
    state: "ACTIVE",
    tool_name: "browser_subagent",
    tool_info: { parameters: { Prompt: "open docs" } },
  }).marker !== "● Subagent open docs" ||
  runner.renderToolStep({
    state: "ACTIVE",
    tool_name: "browser_click",
    tool_info: { parameters: { ref: "btn" } },
  }).marker !== '● browser_click {"ref":"btn"}' ||
  runner.renderToolStep({
    state: "ACTIVE",
    tool_name: "custom_tool",
  }).marker !== "● custom_tool"
) {
  throw new Error("renderToolStep label/target/done formatting regression");
}
console.log("renderToolStep: ok");

// ---------------------------------------------------------------------------
// 2. Headless runs against fake agy binaries
// ---------------------------------------------------------------------------
const ws = mkdtempSync(path.join(os.tmpdir(), "agy-headless-"));
const tmpBase = mkdtempSync(path.join(os.tmpdir(), "agy-fakes-"));
let fakeCounter = 0;

const CHILD_SCRIPT = `
  import * as runner from "./src/agy.ts";
  const opts = JSON.parse(process.env.AGY_TEST_OPTS);
  const result = await runner.runTask(opts);
  process.stdout.write(JSON.stringify(result));
  // A fake's (or CLI's) lingering descendants may hold the stdio pipes open;
  // the run already resolved, so force the wrapper process down.
  process.exit(0);
`;

const argCap = `printf '%s\\n' "$@" > "$AGY_FAKE_ARGFILE"`;

const CANONICAL_JSON =
  '{"conversation_id":"6f0e9c2a-1111-4d6e-9d33-c71e0e8b2a10","status":"SUCCESS","response":"OK","duration_seconds":6.55,"num_turns":1}';

async function fakeRun(body: string, opts: Record<string, unknown>, extraEnv: Record<string, string> = {}) {
  const bin = path.join(tmpBase, `fake-agy-${fakeCounter++}`);
  writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  chmodSync(bin, 0o755);
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "agy-run-"));
  const res = await execFileP(process.execPath, ["--input-type=module", "-e", CHILD_SCRIPT], {
    cwd: ROOT,
    env: {
      ...process.env,
      AGY_BIN: bin,
      AGY_MCP_STATE_DIR: stateDir,
      AGY_FAKE_ARGFILE: path.join(stateDir, "argv.txt"),
      AGY_FAKE_PIDFILE: path.join(stateDir, "pid.txt"),
      AGY_TEST_OPTS: JSON.stringify(opts),
      ...extraEnv,
    },
    timeout: 30_000,
  });
  return {
    result: JSON.parse(res.stdout),
    argfile: path.join(stateDir, "argv.txt"),
    pidfile: path.join(stateDir, "pid.txt"),
    stateDir,
  };
}

function readArgv(argfile: string): string[] {
  return readFileSync(argfile, "utf8").split("\n").filter(Boolean);
}

function readEvents(stateDir: string): Array<Record<string, unknown>> {
  const ndjson = readdirSync(stateDir).find((f) => f.endsWith(".ndjson"));
  if (!ndjson) return [];
  return readFileSync(path.join(stateDir, ndjson), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
}

// 2a. Minimal argv envelope: exact array, default preset-free call (--print-timeout 0s by default).
const MIN_PROMPT = "reply with a single word";
const runMin = await fakeRun([argCap, `printf '%s\\n' '${CANONICAL_JSON}'`].join("\n"), {
  prompt: MIN_PROMPT,
  cwd: ws,
});
if (
  JSON.stringify(readArgv(runMin.argfile)) !==
  JSON.stringify(["-p", MIN_PROMPT, "--output-format", "stream-json", "--print-timeout", "0s"])
) {
  throw new Error(`unexpected minimal argv: ${readArgv(runMin.argfile).join(" ")}`);
}
if (
  runMin.result.status !== "success" ||
  runMin.result.response !== "OK" ||
  runMin.result.conversation_id !== "6f0e9c2a-1111-4d6e-9d33-c71e0e8b2a10" ||
  runMin.result.num_turns !== 1 ||
  typeof runMin.result.duration_seconds !== "number" ||
  runMin.result.auto_approve_applied !== false ||
  typeof runMin.result.stream_file !== "string" ||
  !runMin.result.stream_file.endsWith(".stream")
) {
  throw new Error(`minimal headless run mis-parsed: ${JSON.stringify(runMin.result)}`);
}
const runWallArgv = await fakeRun(
  [argCap, `printf '%s\\n' '${CANONICAL_JSON}'`].join("\n"),
  { prompt: MIN_PROMPT, cwd: ws },
  { AGY_MCP_PRINT_TIMEOUT_MS: "45000" }
);
if (
  JSON.stringify(readArgv(runWallArgv.argfile)) !==
  JSON.stringify(["-p", MIN_PROMPT, "--output-format", "stream-json", "--print-timeout", "45s"])
) {
  throw new Error(`unexpected wall-env argv: ${readArgv(runWallArgv.argfile).join(" ")}`);
}
console.log("minimal argv envelope (--print-timeout 0s default, wall env variant) + canonical SUCCESS parse: ok");

// 2b. Full flag set: each optional flag emitted exactly when set.
const FULL_PROMPT = "exercise every optional flag in one run";
const CONV = "9c0e6f2a-2222-4a6e-8d33-c71e0e8b2a99";
const runFull = await fakeRun([argCap, `printf '%s\\n' '${CANONICAL_JSON}'`].join("\n"), {
  prompt: FULL_PROMPT,
  cwd: ws,
  conversationId: CONV,
  agent: "reviewer",
  model: "gemini-x",
  effort: "high",
  mode: "plan",
  sandbox: true,
  autoApprove: true,
  addDirs: ["/tmp/alpha", "/tmp/beta"],
  project: "proj-9",
  timeoutMs: 90_000,
});
const argvFull = readArgv(runFull.argfile);
const pairFlags = ["--conversation", "--agent", "--model", "--effort", "--mode", "--add-dir", "--project"];
for (const flag of pairFlags) {
  const i = argvFull.indexOf(flag);
  if (i < 0 || i + 1 >= argvFull.length) {
    throw new Error(`full-flag run missing ${flag}: ${argvFull.join(" ")}`);
  }
}
for (const bare of ["--sandbox", "--dangerously-skip-permissions"]) {
  if (!argvFull.includes(bare)) throw new Error(`full-flag run missing ${bare}`);
}
const flagValue = (flag: string) => argvFull[argvFull.indexOf(flag) + 1];
if (flagValue("--conversation") !== CONV) throw new Error("--conversation value lost");
if (flagValue("--print-timeout") !== "0s") {
  throw new Error(`timeoutMs must not feed --print-timeout; got ${flagValue("--print-timeout")}`);
}
const addDirCount = argvFull.filter((a) => a === "--add-dir").length;
if (addDirCount !== 2 || argvFull[argvFull.lastIndexOf("--add-dir") + 1] !== "/tmp/beta") {
  throw new Error(`--add-dir must be passed twice; got: ${argvFull.join(" ")}`);
}
if (
  argvFull[0] !== "-p" ||
  argvFull[1] !== FULL_PROMPT ||
  argvFull[2] !== "--output-format" ||
  argvFull[3] !== "stream-json"
) {
  throw new Error("base argv (-p prompt --output-format stream-json) missing");
}
if (argvFull.includes("-i")) throw new Error("interactive -i flag must be gone in headless mode");
if (runFull.result.auto_approve_applied !== true) {
  throw new Error("auto_approve applied flag not reported true");
}
console.log("full-flag argv (conversation/agent/model/effort/mode/sandbox/add-dir x2/project/auto-approve): ok");

// 2c. auto_approve DENIED: env gate removes the flag and reports not-applied.
const runDeny = await fakeRun(
  [argCap, `printf '%s\\n' '${CANONICAL_JSON}'`].join("\n"),
  {
    prompt: "auto approve denied by env",
    cwd: ws,
    autoApprove: true,
  },
  { AGY_MCP_DENY_AUTO_APPROVE: "1" }
);
const argvDeny = readArgv(runDeny.argfile);
if (argvDeny.includes("--dangerously-skip-permissions")) {
  throw new Error("--dangerously-skip-permissions must not be passed when AGY_MCP_DENY_AUTO_APPROVE=1");
}
if (runDeny.result.auto_approve_applied !== false) {
  throw new Error("auto_approve_applied must be false when the env gate denies the request");
}
console.log("auto_approve denied via AGY_MCP_DENY_AUTO_APPROVE: ok");

// 2d. Streaming fixture: init event, plain-text notice, text-less thinking
// agent_response, write_file + read_file tool steps, flowed agent_response
// deltas (ACTIVE + text_delta + DONE), malformed lines mid-stream, and result.
const streamBody = [
  argCap,
  `printf '%s\\n' '{"event":"init","conversation_id":"6f0e9c2a-1111-4d6e-9d33-c71e0e8b2a10","init":{"cwd":"/work/demo","tools":["read_file","edit_file","run_command"],"permission_mode":"request-review"}}'`,
  `cat <<'EOF'`,
  `notice: workspace trust handled automatically`,
  `EOF`,
  `printf '%s\\n' '{"event":"step_update","step_update":{"conversation_id":"6f0e9c2a-1111-4d6e-9d33-c71e0e8b2a10","step_index":0,"state":"DONE","step_type":"user_input"}}'`,
  `printf '%s\\n' '{"event":"step_update","step_update":{"conversation_id":"6f0e9c2a-1111-4d6e-9d33-c71e0e8b2a10","step_index":1,"state":"DONE","step_type":"agent_response","duration_seconds":4.07,"usage":{"input_tokens":8008,"output_tokens":85,"thinking_tokens":38,"cache_read_tokens":0,"total_tokens":8093}}}'`,
  `printf '%s\\n' '{"event":"step_update","step_update":{"conversation_id":"6f0e9c2a-1111-4d6e-9d33-c71e0e8b2a10","step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"write_file","tool_info":{"name":"write_file","parameters":{"Path":"/tmp/opencode/agy-tmux-test/probe.txt"}}}}'`,
  `printf '%s\\n' '{"event":"step_update","step_update":{"conversation_id":"6f0e9c2a-1111-4d6e-9d33-c71e0e8b2a10","step_index":2,"state":"DONE","step_type":"tool","tool_name":"write_file","duration_seconds":1.816,"tool_info":{"name":"write_file","parameters":{"Path":"/tmp/opencode/agy-tmux-test/probe.txt"}}}}'`,
  `printf '%s\\n' '{"event":"step_update","step_update":{"conversation_id":"6f0e9c2a-1111-4d6e-9d33-c71e0e8b2a10","step_index":3,"state":"DONE","step_type":"tool","tool_name":"read_file","duration_seconds":0.027,"tool_info":{"name":"read_file","parameters":{"Path":"/tmp/opencode/agy-tmux-test/probe.txt"},"output":"1 lines, 6 bytes"}}}'`,
  `printf '%s\\n' '{"event":"step_update","step_update":{"conversation_id":"6f0e9c2a-1111-4d6e-9d33-c71e0e8b2a10","step_index":4,"state":"ACTIVE","step_type":"agent_response","text_delta":"Hello "}}'`,
  `echo "{malformed garbage in the middle"`,
  `printf '%s\\n' '{"event":"step_update","step_update":"not-an-object"}'`,
  `printf '%s\\n' '{"event":"step_update","step_update":{"conversation_id":"6f0e9c2a-1111-4d6e-9d33-c71e0e8b2a10","step_index":4,"state":"ACTIVE","step_type":"agent_response","text_delta":"streamed "}}'`,
  `cat <<'EOF'`,
  `jetski: no output produced — a tool required the "command" permission that headless mode`,
  `cannot prompt for, so it was auto-denied.`,
  `EOF`,
  `printf '%s\\n' '{"event":"step_update","step_update":{"conversation_id":"6f0e9c2a-1111-4d6e-9d33-c71e0e8b2a10","step_index":4,"state":"DONE","step_type":"agent_response","text_delta":"world!","duration_seconds":3.74,"usage":{"input_tokens":7993,"output_tokens":14,"thinking_tokens":9,"cache_read_tokens":0,"total_tokens":8007}}}'`,
  `printf '%s\\n' '{"event":"step_update","step_update":{"conversation_id":"6f0e9c2a-1111-4d6e-9d33-c71e0e8b2a10","step_index":5,"state":"DONE","step_type":"tool","tool_name":"run_command","duration_seconds":1.1,"tool_info":{"name":"run_command","parameters":{"Command":"git status"}}}}'`,
  `printf '%s\\n' '{"event":"step_update","step_update":{"conversation_id":"6f0e9c2a-1111-4d6e-9d33-c71e0e8b2a10","step_index":6,"state":"DONE","step_type":"tool","tool_name":"search_web","duration_seconds":0.4,"tool_info":{"name":"search_web","parameters":{"query":"mcp spec"}}}}'`,
  'echo "stderr banner: checking workspace" >&2',
  `printf '%s\\n' '{"event":"result","result":{"conversation_id":"6f0e9c2a-1111-4d6e-9d33-c71e0e8b2a10","status":"SUCCESS","response":"Hello streamed world!\\n","duration_seconds":6.55,"num_turns":1,"usage":{"input_tokens":7993,"output_tokens":14,"total_tokens":8007},"denied_actions":[{"action":"command","display_name":"RunCommand"}]}}'`,
].join("\n");
const runStream = await fakeRun(streamBody, { prompt: "stream through noise and deny", cwd: ws });
const res = runStream.result;
if (res.status !== "success" || res.response !== "Hello streamed world!\n") {
  throw new Error(`stream run mis-parsed response: ${JSON.stringify({ status: res.status, response: res.response })}`);
}
if (
  res.conversation_id !== "6f0e9c2a-1111-4d6e-9d33-c71e0e8b2a10" ||
  res.num_turns !== 1 ||
  res.duration_seconds !== 6.55
) {
  throw new Error("stream run lost the result event's inner fields");
}
if (
  !Array.isArray(res.denied_actions) ||
  res.denied_actions.length !== 1 ||
  res.denied_actions[0].action !== "command"
) {
  throw new Error(`denied_actions not surfaced: ${JSON.stringify(res.denied_actions)}`);
}
if (typeof res.usage !== "object" || res.usage?.input_tokens !== 7993) {
  throw new Error(`usage not surfaced: ${JSON.stringify(res.usage)}`);
}
const notes = String(res.notes ?? "");
if (
  !notes.includes("notice: workspace trust") ||
  !notes.includes("auto-denied") ||
  !notes.includes("{malformed garbage in the middle") ||
  !notes.includes("stderr banner")
) {
  throw new Error(`notes must carry notice/garbage/stderr lines: ${JSON.stringify(notes)}`);
}
if (notes.includes('"event"')) {
  throw new Error(`notes must NOT contain stream event lines: ${JSON.stringify(notes)}`);
}
if (res.response_truncated !== undefined) {
  throw new Error("response_truncated must be absent for a short response");
}
if (typeof res.stream_file !== "string" || !existsSync(res.stream_file)) {
  throw new Error(`stream_file missing on disk: ${res.stream_file}`);
}
const streamText = readFileSync(res.stream_file, "utf8");
const streamLines = streamText.split("\n");
if (streamText.includes("● step")) {
  throw new Error(`stream file must not contain "● step" markers:\n${streamText}`);
}
if (streamLines.some((l) => /^\[\d\d:\d\d:\d\d\]/.test(l))) {
  throw new Error(`stream file must not contain [HH:MM:SS] timestamps:\n${streamText}`);
}
if (streamLines.some((l) => l.startsWith("· "))) {
  throw new Error(`stream file must not contain "· "-prefixed lines:\n${streamText}`);
}
if (streamLines.some((l) => /^(?:●|←|→|\$)\s+[A-Za-z_]+\(/.test(l))) {
  throw new Error(`stream file must not contain parenthesized Label( markers:\n${streamText}`);
}
if (!streamLines.includes("session open · cwd=/work/demo · permission_mode=request-review · tools=3")) {
  throw new Error(`stream file missing session open line:\n${streamText}`);
}
if (!streamLines.includes("● user_input")) {
  throw new Error(`stream file missing user_input marker:\n${streamText}`);
}
if (!streamLines.includes("● agent_response")) {
  throw new Error(`stream file missing agent_response marker:\n${streamText}`);
}
if (!streamLines.some((l) => l.startsWith("  ⎿ done in 4.0") && l.endsWith("s · 8093 tokens · thinking 38"))) {
  throw new Error(`stream file missing text-less response done line with thinking tokens:\n${streamText}`);
}
if (!streamLines.includes("← Write /tmp/opencode/agy-tmux-test/probe.txt")) {
  throw new Error(`stream file missing Write tool marker:\n${streamText}`);
}
if (!streamLines.some((l) => l.startsWith("  ⎿ done in 1.8") && l.endsWith("s"))) {
  throw new Error(`stream file missing Write tool done line:\n${streamText}`);
}
if (!streamLines.includes("→ Read /tmp/opencode/agy-tmux-test/probe.txt")) {
  throw new Error(`stream file missing Read tool marker:\n${streamText}`);
}
if (!streamLines.some((l) => l.startsWith("  ⎿ 1 lines, 6 bytes · done in 0.02") && l.endsWith("s"))) {
  throw new Error(`stream file missing Read tool done line with output:\n${streamText}`);
}
if (!streamLines.includes("Hello streamed world!")) {
  throw new Error(`stream file missing flowed delta text on one line:\n${streamText}`);
}
if (!streamLines.some((l) => l.startsWith("  ⎿ done in 3.7") && l.endsWith("s · 8007 tokens · thinking 9"))) {
  throw new Error(`stream file missing flowed response done usage line:\n${streamText}`);
}
if (!streamLines.includes("$ git status")) {
  throw new Error(`stream file missing Run ($ <cmd>) tool marker:\n${streamText}`);
}
if (!streamLines.some((l) => l.startsWith("  ⎿ done in 1.1") && l.endsWith("s"))) {
  throw new Error(`stream file missing Run tool done line:\n${streamText}`);
}
if (!streamLines.includes("● Web mcp spec")) {
  throw new Error(`stream file missing neutral tool marker:\n${streamText}`);
}
if (!streamLines.some((l) => l.startsWith("  ⎿ done in 0.4") && l.endsWith("s"))) {
  throw new Error(`stream file missing neutral tool done line:\n${streamText}`);
}
if (!streamLines.includes("== done: status=SUCCESS · 6.55s")) {
  throw new Error(`stream file missing == done line:\n${streamText}`);
}
const streamEvents = readEvents(runStream.stateDir).map((e) => e.event);
for (const want of ["task_start", "spawn", "exit", "task_end"]) {
  if (!streamEvents.includes(want))
    throw new Error(`ndjson log missing ${want} event: ${JSON.stringify(streamEvents)}`);
}
console.log("streaming fixture: result unwrap, stream file mirroring, malformed-line containment, notes clean: ok");

// 2e. Malformed output: stream transcript with no result event -> honest error + notes kept.
const runBad = await fakeRun(
  [
    argCap,
    `printf '%s\\n' '{"event":"init","conversation_id":"bad-c1","init":{"cwd":"/work","tools":["a"],"permission_mode":"request-review"}}'`,
    `printf '%s\\n' '{"event":"step_update","step_update":{"conversation_id":"bad-c1","step_index":0,"state":"DONE","step_type":"user_input"}}'`,
    'echo "something went wrong during boot"',
    'echo "{not json"',
    "exit 0",
  ].join("\n"),
  { prompt: "prove stream without result event is surfaced as error", cwd: ws }
);
if (runBad.result.status !== "error") {
  throw new Error(`malformed output must yield status error, got ${runBad.result.status}`);
}
if (!/\bcode \d+\b/.test(runBad.result.error ?? "") || !(runBad.result.error ?? "").includes("no JSON result line")) {
  throw new Error(`error text must name the exit code and the missing JSON line: ${runBad.result.error}`);
}
if (!String(runBad.result.notes ?? "").includes("{not json") || String(runBad.result.notes ?? "").includes('"event"')) {
  throw new Error(`malformed run notes wrong: ${JSON.stringify(runBad.result.notes)}`);
}
console.log("malformed output (stream without result event) -> status=error with notes: ok");

// 2f. Quota classification: plain-line quota notice + non-SUCCESS result event upgrade to quota_error.
const runQuota = await fakeRun(
  [
    argCap,
    `printf '%s\\n' '{"event":"init","conversation_id":"quota-conv","init":{"cwd":"/work","tools":[],"permission_mode":"request-review"}}'`,
    `echo "Error: HTTP 429 from model backend - quota exceeded for today"`,
    `printf '%s\\n' '{"event":"result","result":{"conversation_id":"quota-conv","status":"ERROR","response":"","duration_seconds":2.2,"num_turns":1}}'`,
    "exit 3",
  ].join("\n"),
  { prompt: "probe quota classification", cwd: ws }
);
if (runQuota.result.status !== "quota_error") {
  throw new Error(`expected quota_error upgrade, got ${runQuota.result.status}`);
}
if (!runQuota.result.quota_note) throw new Error("quota_error result must carry quota_note");
if (runQuota.result.exit_code !== 3) throw new Error(`exit_code lost: ${runQuota.result.exit_code}`);
if (!String(runQuota.result.error ?? "").includes("code 3")) throw new Error(`error text: ${runQuota.result.error}`);
if (runQuota.result.conversation_id !== "quota-conv") throw new Error("conversation_id lost on quota upgrade");
console.log("quota_error upgrade from 429 noise + result event: ok");

// 2g. Timeouts:
//   - idle kill: emits init then goes silent; AGY_MCP_IDLE_TIMEOUT_MS=400 kills
//     the silent child, marks status=timeout with "idle for", logs kind="idle",
//     and leaves no zombie behind;
//   - idle reset: emits a short line every 150ms for ~1.5s (> 400ms idle timer)
//     and completes SUCCESS, proving output resets the idle timer;
//   - wall opt-in: AGY_MCP_PRINT_TIMEOUT_MS=500 kills a continuously-talking
//     child mid-output with "hard cap" and logs kind="wall".
async function assertPidGone(pidfile: string, label: string) {
  const pid = parseInt(readFileSync(pidfile, "utf8").trim(), 10);
  let gone = false;
  for (let i = 0; i < 160; i++) {
    try {
      process.kill(pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "ESRCH") gone = true;
    }
    if (gone) break;
    await sleep(50);
  }
  if (!gone) {
    throw new Error(`fake agy child ${pid} survived ${label} (zombie)`);
  }
  return pid;
}

const runIdleKill = await fakeRun(
  [
    argCap,
    `printf '%s\\n' "$$" > "$AGY_FAKE_PIDFILE"`,
    `printf '%s\\n' '{"event":"init","conversation_id":"idle-c1","init":{"cwd":"/work","tools":[],"permission_mode":"request-review"}}'`,
    'echo "boot banner while hung" >&2',
    "sleep 30",
  ].join("\n"),
  { prompt: "emit init then go silent to exercise the idle kill path", cwd: ws },
  { AGY_MCP_IDLE_TIMEOUT_MS: "400" }
);
const idleRes = runIdleKill.result;
if (idleRes.status !== "timeout") {
  throw new Error(`expected status timeout on idle kill, got ${idleRes.status}`);
}
if (!String(idleRes.error ?? "").includes("idle for 400ms")) {
  throw new Error(`idle timeout error text wrong: ${idleRes.error}`);
}
if (!String(idleRes.notes ?? "").includes("boot banner while hung")) {
  throw new Error("idle timeout result lost stderr as notes");
}
const idleTimeoutEvt = readEvents(runIdleKill.stateDir).find((e) => e.event === "timeout");
if (idleTimeoutEvt?.kind !== "idle") {
  throw new Error(`ndjson log missing timeout event with kind="idle": ${JSON.stringify(idleTimeoutEvt)}`);
}
const idlePid = await assertPidGone(runIdleKill.pidfile, "idle timeout");
console.log(`idle kill: status=timeout, kind=idle, no zombie (pid ${idlePid} gone), notes kept: ok`);

const runIdleReset = await fakeRun(
  [
    argCap,
    `printf '%s\\n' '{"event":"init","conversation_id":"6f0e9c2a-1111-4d6e-9d33-c71e0e8b2a10","init":{"cwd":"/work","tools":[],"permission_mode":"request-review"}}'`,
    "i=0; while [ $i -lt 10 ]; do sleep 0.15; i=$((i+1)); printf 'tick %d\\n' \"$i\"; done",
    `printf '%s\\n' '{"event":"result","result":${CANONICAL_JSON}}'`,
  ].join("\n"),
  { prompt: "keep talking past a single idle window so resets keep the run alive", cwd: ws },
  { AGY_MCP_IDLE_TIMEOUT_MS: "400" }
);
if (runIdleReset.result.status !== "success" || runIdleReset.result.response !== "OK") {
  throw new Error(`idle reset run should succeed while talking, got: ${JSON.stringify(runIdleReset.result)}`);
}
console.log("idle reset: active output every 150ms for ~1.5s (> 400ms idle timer) completes SUCCESS: ok");

const runWallKill = await fakeRun(
  [
    argCap,
    `printf '%s\\n' "$$" > "$AGY_FAKE_PIDFILE"`,
    "i=0; while [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); printf 'still talking %d\\n' \"$i\"; done",
  ].join("\n"),
  { prompt: "keep talking into the opt-in wall ceiling", cwd: ws },
  { AGY_MCP_IDLE_TIMEOUT_MS: "2000", AGY_MCP_PRINT_TIMEOUT_MS: "500" }
);
const wallRes = runWallKill.result;
if (wallRes.status !== "timeout") {
  throw new Error(`expected status timeout on wall cap, got ${wallRes.status}`);
}
if (!String(wallRes.error ?? "").includes("hard cap of 500ms")) {
  throw new Error(`wall timeout error text wrong: ${wallRes.error}`);
}
const wallArgv = readArgv(runWallKill.argfile);
if (wallArgv[wallArgv.indexOf("--print-timeout") + 1] !== "0.5s") {
  throw new Error(`wall env must pass --print-timeout 0.5s, got: ${wallArgv.join(" ")}`);
}
const wallTimeoutEvt = readEvents(runWallKill.stateDir).find((e) => e.event === "timeout");
if (wallTimeoutEvt?.kind !== "wall") {
  throw new Error(`ndjson log missing timeout event with kind="wall": ${JSON.stringify(wallTimeoutEvt)}`);
}
const wallPid = await assertPidGone(runWallKill.pidfile, "wall timeout");
console.log(`wall opt-in kill: status=timeout, kind=wall, killed mid-output, no zombie (pid ${wallPid} gone): ok`);

// ---------------------------------------------------------------------------
// 3. runTask validation: throws before anything spawns
// ---------------------------------------------------------------------------
for (const [label, opts, expect] of [
  ["bad cwd", { prompt: "x", cwd: "/does/not/exist-agy" }, "cwd does not exist"],
  ["edit_scope escaping cwd", { prompt: "x", cwd: ws, editScope: ["../outside"] }, "escapes task cwd"],
] as Array<[string, { prompt: string; cwd: string; editScope?: string[] }, string]>) {
  let threw = "";
  try {
    await runner.runTask(opts);
  } catch (e) {
    threw = (e as Error).message;
  }
  if (!threw.includes(expect)) {
    throw new Error(`runTask must reject ${label} with "${expect}", got: ${threw || "(no throw)"}`);
  }
}
console.log("runTask rejects bad cwd / escaping edit_scope: ok");

// ---------------------------------------------------------------------------
// 4. Git-based change audit + edit_scope validation
// ---------------------------------------------------------------------------
const repoDir = mkdtempSync(path.join(os.tmpdir(), "agy-audit-"));
spawnSync("git", ["init", repoDir]);
mkdirSync(path.join(repoDir, "src"), { recursive: true });
writeFileSync(path.join(repoDir, "src", "keep.ts"), "export const x = 1;\n");
spawnSync("git", ["-C", repoDir, "add", "."]);
spawnSync("git", ["-C", repoDir, "-c", "user.email=t@e", "-c", "user.name=t", "commit", "-m", "init"]);

const snapshot = runner.captureFilesBefore(repoDir);
if (snapshot === null) {
  throw new Error("captureFilesBefore returned null for a valid git repo");
}
writeFileSync(path.join(repoDir, "new.txt"), "hello\n");

const audit1 = runner.auditTaskFiles({ cwd: repoDir, filesBefore: snapshot, editScope: ["src"] });
console.log(
  `audit (scoped): touched=${JSON.stringify(audit1?.files_touched)} violations=${JSON.stringify(audit1?.scope_violations)}`
);
if (!audit1?.files_touched.includes("new.txt") || !audit1.scope_violations?.includes("new.txt")) {
  throw new Error("auditTaskFiles failed to report new.txt as touched and out of scope");
}

const audit2 = runner.auditTaskFiles({ cwd: repoDir, filesBefore: snapshot });
console.log(`audit (unscoped): keys=${JSON.stringify(Object.keys(audit2 ?? {}))}`);
if (!audit2?.files_touched.includes("new.txt") || "scope_violations" in audit2) {
  throw new Error("auditTaskFiles should omit scope_violations when editScope is absent");
}

const auditNone = runner.auditTaskFiles({ cwd: repoDir, filesBefore: null });
if (auditNone !== undefined) {
  throw new Error("auditTaskFiles must return undefined when filesBefore is null (not a git repo)");
}

const resolvedScope = runner.resolveEditScope(repoDir, [".", "src/keep.ts"], null);
if (resolvedScope.length !== 2 || resolvedScope[0] !== repoDir) {
  throw new Error("resolveEditScope rejected valid in-cwd entries");
}
let escapedCwdThrew = false;
try {
  runner.resolveEditScope(repoDir, ["../outside"], null);
} catch {
  escapedCwdThrew = true;
}
if (!escapedCwdThrew) {
  throw new Error("resolveEditScope failed to throw when entry escapes cwd");
}
let escapedRootThrew = false;
try {
  runner.resolveEditScope(repoDir, ["src"], path.join(repoDir, "other-root"));
} catch {
  escapedRootThrew = true;
}
if (!escapedRootThrew) {
  throw new Error("resolveEditScope failed to throw when entry escapes root");
}
console.log("captureFilesBefore + auditTaskFiles + resolveEditScope boundaries: ok");

// ---------------------------------------------------------------------------
// 5. Startup sweep (child process: STATE_DIR is fixed at import time)
// ---------------------------------------------------------------------------
const sweepDir = mkdtempSync(path.join(os.tmpdir(), "agy-sweep-"));
const oldFile = path.join(sweepDir, "task_old.ndjson");
const oldStream = path.join(sweepDir, "task_old.stream");
writeFileSync(oldFile, "{}\n");
writeFileSync(oldStream, "session open\n");
const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000);
utimesSync(oldFile, tenDaysAgo, tenDaysAgo);
utimesSync(oldStream, tenDaysAgo, tenDaysAgo);
writeFileSync(path.join(sweepDir, "task_fresh.ndjson"), "{}\n");
writeFileSync(path.join(sweepDir, "task_fresh.stream"), "session open\n");
writeFileSync(path.join(sweepDir, "note.txt"), ""); // unrelated file: untouched

await execFileP(process.execPath, ["-e", 'import("./src/agy.ts").then((m) => m.sweepStateDir())'], {
  cwd: ROOT,
  env: { ...process.env, AGY_MCP_STATE_DIR: sweepDir },
});

const staleGone = !existsSync(oldFile) && !existsSync(oldStream);
const freshKept =
  existsSync(path.join(sweepDir, "task_fresh.ndjson")) && existsSync(path.join(sweepDir, "task_fresh.stream"));
const unrelatedKept = existsSync(path.join(sweepDir, "note.txt"));
console.log(`sweep: staleGone=${staleGone} freshKept=${freshKept} unrelatedKept=${unrelatedKept}`);
if (!staleGone || !freshKept || !unrelatedKept) {
  throw new Error("sweepStateDir removed the wrong files");
}

// ---------------------------------------------------------------------------
// 6. watch_task helpers: listStreamFiles, resolveStreamFile, readStreamTail
// ---------------------------------------------------------------------------
const watchDir = mkdtempSync(path.join(os.tmpdir(), "agy-watch-"));
if (runner.listStreamFiles(path.join(watchDir, "nonexistent")).length !== 0) {
  throw new Error("listStreamFiles must return [] when stateDir does not exist");
}
const emptyWatch = runner.watchTask({ stateDir: watchDir });
if (emptyWatch.found !== false || !Array.isArray(emptyWatch.candidates) || emptyWatch.candidates.length !== 0) {
  throw new Error(
    `watchTask on empty dir must return { found: false, candidates: [] }, got ${JSON.stringify(emptyWatch)}`
  );
}

const fOld = path.join(watchDir, "task_aaaa1111.stream");
const fMid = path.join(watchDir, "task_bbbb2222.stream");
const fNew = path.join(watchDir, "task_cccc3333.stream");
writeFileSync(fOld, "session open\n● user_input\n");
writeFileSync(
  fMid,
  `${[
    "session open · cwd=/work · permission_mode=plan · tools=5",
    "● user_input",
    "● agent_response",
    "working on step 1",
    "still running",
  ].join("\n")}\n`
);
writeFileSync(
  fNew,
  `${[
    "session open · cwd=/work · permission_mode=accept-edits · tools=5",
    "● user_input",
    "← Write /work/a.txt",
    "  ⎿ done in 0.4s",
    "== done: status=SUCCESS · 1.2s",
  ].join("\n")}\n`
);
writeFileSync(path.join(watchDir, "task_aaaa1111.ndjson"), "{}\n");
writeFileSync(path.join(watchDir, "task_onlynd.ndjson"), '{"event":"task_start"}\n');
writeFileSync(path.join(watchDir, "ignore.txt"), "not a stream\n");

const nowMs = Date.now();
utimesSync(fOld, new Date(nowMs - 30_000), new Date(nowMs - 30_000));
utimesSync(fMid, new Date(nowMs - 20_000), new Date(nowMs - 20_000));
utimesSync(fNew, new Date(nowMs - 10_000), new Date(nowMs - 10_000));

const listed = runner.listStreamFiles(watchDir);
if (
  JSON.stringify(listed) !== JSON.stringify(["task_cccc3333.stream", "task_bbbb2222.stream", "task_aaaa1111.stream"])
) {
  throw new Error(`listStreamFiles wrong ordering: ${JSON.stringify(listed)}`);
}
console.log("listStreamFiles (recent-first mtime ordering, non-.stream ignored): ok");

for (const bad of [
  "/etc/passwd",
  "../outside.stream",
  path.resolve(watchDir, "..", "task_x.stream"),
  "sub/task_x.stream",
  "",
]) {
  const r = runner.resolveStreamFile(watchDir, bad);
  if (!("error" in r)) {
    throw new Error(`resolveStreamFile must reject escaping/invalid "${bad}", got: ${JSON.stringify(r)}`);
  }
}
for (const input of [
  "task_cccc3333.stream",
  "task_cccc3333",
  "cccc3333",
  path.join(watchDir, "task_cccc3333.stream"),
]) {
  const r = runner.resolveStreamFile(watchDir, input);
  if ("error" in r || r.path !== fNew) {
    throw new Error(`resolveStreamFile failed to resolve "${input}" to ${fNew}: ${JSON.stringify(r)}`);
  }
}
const twinResolved = runner.resolveStreamFile(watchDir, "onlynd");
if (
  "error" in twinResolved ||
  twinResolved.path !== path.join(watchDir, "task_onlynd.stream") ||
  !twinResolved.hint?.includes("task_onlynd.ndjson")
) {
  throw new Error(`resolveStreamFile must hint at .ndjson-only twin: ${JSON.stringify(twinResolved)}`);
}
const twinWatched = runner.watchTask({ stateDir: watchDir, streamFile: "task_onlynd" });
if (
  twinWatched.found !== false ||
  !twinWatched.hint?.includes("task_onlynd.ndjson") ||
  JSON.stringify(twinWatched.candidates) !== JSON.stringify(listed)
) {
  throw new Error(`watchTask .ndjson-only twin report wrong: ${JSON.stringify(twinWatched)}`);
}
console.log("resolveStreamFile (containment, bare-name / task-id / absolute forms, .ndjson twin hint): ok");

const liveTail = runner.readStreamTail(fMid, 400, 200_000);
if (
  liveTail.found !== true ||
  liveTail.running !== true ||
  liveTail.finished !== false ||
  liveTail.clipped !== undefined ||
  typeof liveTail.bytes !== "number" ||
  liveTail.bytes <= 0 ||
  typeof liveTail.modified !== "string" ||
  liveTail.content?.startsWith("…\n") ||
  !liveTail.content?.endsWith("still running")
) {
  throw new Error(`readStreamTail in-progress fixture wrong: ${JSON.stringify(liveTail)}`);
}

const slicedTail = runner.readStreamTail(fMid, 2, 200_000);
if (
  slicedTail.found !== true ||
  slicedTail.clipped !== true ||
  slicedTail.content !== "…\nworking on step 1\nstill running"
) {
  throw new Error(`readStreamTail tail_lines=2 wrong: ${JSON.stringify(slicedTail)}`);
}

const doneTail = runner.readStreamTail(fNew, 400, 200_000);
if (
  doneTail.found !== true ||
  doneTail.running !== false ||
  doneTail.finished !== true ||
  doneTail.clipped !== undefined ||
  !doneTail.content?.includes("== done: status=SUCCESS · 1.2s")
) {
  throw new Error(`readStreamTail finished fixture wrong: ${JSON.stringify(doneTail)}`);
}

const charClipped = runner.readStreamTail(fNew, 0, 45);
if (
  charClipped.found !== true ||
  charClipped.clipped !== true ||
  !charClipped.content?.startsWith("…\n") ||
  charClipped.content.length > 45 ||
  !charClipped.content.endsWith("== done: status=SUCCESS · 1.2s")
) {
  throw new Error(`readStreamTail charLimit clip wrong: ${JSON.stringify(charClipped)}`);
}

const latestWatched = runner.watchTask({ stateDir: watchDir });
if (latestWatched.found !== true || latestWatched.file !== fNew || latestWatched.finished !== true) {
  throw new Error(`watchTask with no streamFile must pick latest by mtime: ${JSON.stringify(latestWatched)}`);
}
console.log("readStreamTail (tail_lines, charLimit clip, running/finished detection) + watchTask: ok");

// ---------------------------------------------------------------------------
// 6. Installed artifact boots: bin shim -> dist build over a real MCP handshake
// ---------------------------------------------------------------------------
console.log("boot smoke (bin -> dist after pretest build): starting");
const pkgTest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string };

{
  const noOpBin = path.join(tmpBase, `fake-agy-${fakeCounter++}`);
  writeFileSync(noOpBin, "#!/bin/sh\nexit 0\n");
  chmodSync(noOpBin, 0o755);

  const child = spawn(process.execPath, ["bin/mcp.mjs"], {
    cwd: ROOT,
    env: { ...process.env, AGY_BIN: noOpBin },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines: string[] = [];
  let stderrText = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d: string) => lines.push(...d.split("\n").filter(Boolean)));
  child.stderr.on("data", (d: string) => {
    stderrText += d;
  });

  const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "boot-smoke", version: "0" } },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });

  const deadline = Date.now() + 10_000;
  while (!lines.some((l) => l.includes('"id":2')) && Date.now() < deadline) await sleep(100);
  child.kill("SIGTERM");
  await new Promise((r) => child.on("exit", r));

  if (!stderrText.includes("[agy-agent-mcp] starting") || !stderrText.includes("connected on stdio")) {
    throw new Error(`bin shim must boot dist with the startup banner: ${JSON.stringify(stderrText.slice(0, 200))}`);
  }
  const parsed = lines.map((l) => JSON.parse(l) as { id?: number; result?: Record<string, unknown> });
  const hello = parsed.find((j) => j.id === 1)?.result as
    | { serverInfo?: { name?: string; version?: string }; protocolVersion?: string }
    | undefined;
  if (hello?.serverInfo?.name !== "agy-agent-mcp") {
    throw new Error(`dist server must answer initialize with serverInfo: ${JSON.stringify(hello)}`);
  }
  if (hello.protocolVersion !== "2025-06-18") {
    throw new Error(`dist server must echo the client protocolVersion: ${hello.protocolVersion}`);
  }
  if (hello.serverInfo.version !== pkgTest.version) {
    throw new Error(`serverInfo.version ${hello.serverInfo.version} must match package.json ${pkgTest.version}`);
  }
  const listed = parsed.find((j) => j.id === 2)?.result as
    | { tools?: Array<{ name: string; inputSchema?: { type?: string } }> }
    | undefined;
  const want = new Set(["general_task", "explore_task", "watch_task", "list_models", "list_agents"]);
  const got = new Set((listed?.tools ?? []).map((t) => t.name));
  if (got.size !== want.size || [...want].some((n) => !got.has(n))) {
    throw new Error(`tools/list from dist must expose all 5 tools: ${[...got].join(", ")}`);
  }
  if ((listed?.tools ?? []).some((t) => t.inputSchema?.type !== "object")) {
    throw new Error("every tools/list entry must carry an object inputSchema");
  }
  console.log("boot smoke (bin -> dist handshake, version single-sourced, 5 tools): ok");
}

// ---------------------------------------------------------------------------
// 7. Protocol parity over stdio: the entire test/goldens scenario replayed
// ---------------------------------------------------------------------------
console.log("protocol parity vs test/goldens (bin -> dist): starting");
{
  const stubAgy = path.join(tmpBase, `fake-agy-${fakeCounter++}`);
  // Print exactly the two lines the goldens were captured against.
  writeFileSync(stubAgy, `#!/bin/sh\necho "cached: no models found"\necho "agi / gemini / claude"\n`);
  chmodSync(stubAgy, 0o755);

  const child = spawn(process.execPath, ["bin/mcp.mjs"], {
    cwd: ROOT,
    env: { ...process.env, AGY_BIN: stubAgy },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const chunks: string[] = [];
  let stderrText = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d: string) => chunks.push(d));
  child.stderr.on("data", (d: string) => {
    stderrText += d;
  });

  const linesSoFar = () =>
    chunks
      .join("")
      .split("\n")
      .filter((l) => l.trim() !== "");

  type JsonRpcResponse = {
    id?: string | number;
    result?: Record<string, unknown>;
    error?: { code: number; message: string };
  };

  // Paced step: one message, wait for the response with the expected id (or
  // assert silence for garbage lines / notifications — id null).
  async function step(message: unknown, wantId: number | null): Promise<JsonRpcResponse | null> {
    const before = linesSoFar().length;
    child.stdin.write(`${typeof message === "string" ? message : JSON.stringify(message)}\n`);
    if (wantId === null) {
      await sleep(120);
      const now = linesSoFar();
      if (now.length !== before) {
        child.kill("SIGKILL");
        throw new Error(`garbage line / notification must never produce a response, got: ${now[before]}`);
      }
      return null;
    }
    const deadline = Date.now() + 10_000;
    for (;;) {
      const now = linesSoFar();
      if (now.length > before) {
        const resp = JSON.parse(now[before]) as JsonRpcResponse;
        if (resp.id !== wantId) {
          child.kill("SIGKILL");
          throw new Error(`out-of-order response: wanted id ${wantId}, got line ${now[before]}`);
        }
        return resp;
      }
      if (Date.now() > deadline) {
        child.kill("SIGKILL");
        throw new Error(`timed out waiting for response id ${wantId}`);
      }
      await sleep(10);
    }
  }

  // Exact boot banner (stderr), then wait for the connect line before driving.
  const connectDeadline = Date.now() + 10_000;
  while (!stderrText.includes("connected on stdio") && Date.now() < connectDeadline) await sleep(10);
  const stderrLines = stderrText.split("\n").filter((l) => l.trim() !== "");
  const banner = `[agy-agent-mcp] starting (agy=${stubAgy}, idle_timeout_ms=${runner.DEFAULT_IDLE_TIMEOUT_MS === 0 ? "off" : runner.DEFAULT_IDLE_TIMEOUT_MS}, wall_timeout_ms=${runner.DEFAULT_PRINT_TIMEOUT_MS === 0 ? "off" : runner.DEFAULT_PRINT_TIMEOUT_MS}, auto_approve=${runner.ALLOW_AUTO_APPROVE ? "allowed" : "denied"}${runner.ROOT ? `, root=${runner.ROOT}` : ""}, retention=${runner.RETENTION_DAYS === 0 ? "off" : `${runner.RETENTION_DAYS}d`})`;
  if (stderrLines[0] !== banner) {
    child.kill("SIGKILL");
    throw new Error(`boot banner mismatch:\n  got:    ${stderrLines[0] ?? "(none)"}\n  wanted: ${banner}`);
  }
  if (stderrLines[1] !== "[agy-agent-mcp] connected on stdio") {
    child.kill("SIGKILL");
    throw new Error(`missing "connected on stdio" line: ${stderrLines[1] ?? "(none)"}`);
  }
  if (stderrLines.length !== 2) {
    child.kill("SIGKILL");
    throw new Error(`stderr must carry exactly the two boot lines, got ${stderrLines.length}: ${stderrText}`);
  }

  // Structural deep-equal over parsed JSON (key-order independent).
  function jsonDeepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return a === b;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a as Record<string, unknown>);
    const kb = Object.keys(b as Record<string, unknown>);
    if (ka.length !== kb.length) return false;
    return ka.every(
      (k) =>
        k in (b as Record<string, unknown>) &&
        jsonDeepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
    );
  }

  const INIT_PARAMS = {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "capture", version: "0" },
  };
  const scenario: Array<{ send: unknown; id: number | null; golden: string | null }> = [
    { send: { jsonrpc: "2.0", id: 99, method: "resources/list", params: {} }, id: 99, golden: "premature-request" },
    { send: "this is not json at all", id: null, golden: null },
    { send: { jsonrpc: "2.0", id: 1, method: "initialize", params: INIT_PARAMS }, id: 1, golden: "initialize" },
    { send: { jsonrpc: "2.0", method: "notifications/initialized" }, id: null, golden: null },
    {
      send: { jsonrpc: "2.0", id: 21, method: "initialize", params: INIT_PARAMS },
      id: 21,
      golden: "duplicate-initialize",
    },
    { send: { jsonrpc: "2.0", id: 7, method: "ping" }, id: 7, golden: "ping" },
    {
      send: { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "list_models", arguments: {} } },
      id: 4,
      golden: "tool-call-list-models",
    },
    {
      send: { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "list_agents", arguments: {} } },
      id: 5,
      golden: "tool-call-list-agents",
    },
    {
      send: { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nope", arguments: {} } },
      id: 6,
      golden: "tool-call-unknown-tool",
    },
    {
      send: { jsonrpc: "2.0", id: 12, method: "tools/call", params: { arguments: {} } },
      id: 12,
      golden: "tool-call-missing-name",
    },
    { send: { jsonrpc: "2.0", id: 9, method: "bogus/method" }, id: 9, golden: "method-not-found" },
    { send: { jsonrpc: "2.0", method: "notifications/cancelled", params: {} }, id: null, golden: null },
    { send: { jsonrpc: "2.0", id: 2, method: "tools/list" }, id: 2, golden: "tools-list" },
  ];

  let responses = 0;
  for (const s of scenario) {
    const resp = await step(s.send, s.id);
    if (s.golden === null) continue;
    responses++;
    const golden = JSON.parse(
      readFileSync(path.join(ROOT, "test", "goldens", `${s.golden}.json`), "utf8")
    ) as JsonRpcResponse;
    if (s.golden === "initialize" || s.golden === "duplicate-initialize") {
      const gotInfo = (resp?.result as { serverInfo?: { version?: string } } | undefined)?.serverInfo;
      const goldenInfo = (golden.result as { serverInfo?: { version?: string } }).serverInfo;
      if (gotInfo?.version !== pkgTest.version) {
        throw new Error(`initialize serverInfo.version ${gotInfo?.version} must match package.json ${pkgTest.version}`);
      }
      // Everything except the version must equal the golden exactly.
      delete gotInfo?.version;
      delete goldenInfo?.version;
    }
    if (!jsonDeepEqual(resp, golden)) {
      throw new Error(
        `response for ${s.golden} deviates from the golden:\n  got:    ${JSON.stringify(resp)}\n  golden: ${JSON.stringify(golden)}`
      );
    }
  }

  // EOF: the server exits gracefully and every request got exactly one line.
  child.stdin.end();
  const exitCode = await new Promise<number>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(-999);
    }, 10_000);
    child.on("exit", (c) => {
      clearTimeout(timer);
      resolve(c ?? -999);
    });
  });
  const all = linesSoFar();
  if (all.length !== 10) {
    throw new Error(`expected exactly 10 response lines (garbage + notifications silent), got ${all.length}`);
  }
  if (exitCode !== 0) {
    throw new Error(`stdin EOF must end the server cleanly with exit 0, got ${exitCode}`);
  }

  console.log(
    `protocol parity vs test/goldens: 10/10 golden-deep-equal (${responses} matched), 0 stray lines, banner exact, EOF exit 0: ok`
  );
}

// ---------------------------------------------------------------------------
// 8. Zero runtime dependencies: package.json, server source, production install
// ---------------------------------------------------------------------------
{
  const pkgFull = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const deps = pkgFull.dependencies ?? {};
  if (Object.keys(deps).length !== 0) {
    throw new Error(`package.json must carry zero runtime dependencies, got: ${JSON.stringify(deps)}`);
  }
  const serverSrc = readFileSync(path.join(ROOT, "src", "index.ts"), "utf8");
  if (serverSrc.includes("modelcontextprotocol")) {
    throw new Error("src/index.ts must not reference the MCP SDK anywhere");
  }
  if (serverSrc.includes(' from "zod"')) {
    throw new Error('src/index.ts must not import from "zod"');
  }
  // What a consumer install materializes: pack the package and install THAT
  // tarball without devDependencies. This mirrors the registry artifact's own
  // manifest (deps: none), so no npm version can materialize the withdrawn
  // runtime deps from a devDependencies side-list of the repo manifest.
  const probe = mkdtempSync(path.join(os.tmpdir(), "agy-prod-install-"));
  const packed = spawnSync("npm", ["pack", "--ignore-scripts", "--pack-destination", probe], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120_000,
  });
  const tgzName = packed.stdout.split("\n").filter(Boolean).pop();
  if (!tgzName?.endsWith(".tgz")) {
    throw new Error(`npm pack probe failed (exit ${packed.status}): ${packed.stderr}`);
  }
  const npm = spawnSync(
    "npm",
    [
      "install",
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
      path.join(probe, tgzName),
    ],
    { cwd: probe, encoding: "utf8", timeout: 120_000 }
  );
  if (npm.status !== 0) {
    throw new Error(`production install probe failed (exit ${npm.status}): ${npm.stderr}`);
  }
  for (const gone of ["@modelcontextprotocol", "zod"]) {
    if (existsSync(path.join(probe, "node_modules", gone))) {
      throw new Error(`production install must not materialize node_modules/${gone} (zero runtime deps)`);
    }
  }
  console.log(
    "zero runtime deps: no dependencies field, src/index.ts free of SDK/zod, production install brings no @modelcontextprotocol/zod: ok"
  );
}

closeSync(0);
console.log("=== OFFLINE TESTS PASS ===");

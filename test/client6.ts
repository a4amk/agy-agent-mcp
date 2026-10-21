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
 *    - malformed output (stream with no result event, non-zero exit) -> status
 *      error;
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
 * 9. Single-flight delegation lock over stdio (bin/mcp.mjs + slow fake agy):
 *    while one general_task runs, a second general_task is rejected
 *    immediately (never queued) with the isError envelope naming the in-flight
 *    task id and stream basename, watch_task still answers mid-run, and
 *    exactly ONE fake-agy invocation happened (argfile capture).
 * 10. Progress bridge over stdio: with `_meta.progressToken` a delegation
 *     call receives notifications/progress mirrors of its .stream transcript
 *     in raw-stdout order (>=3 before the result, progress strictly increasing
 *     from 0, every message fragment present in the final .stream file, the
 *     == done line in the last message and written before the result
 *     envelope); without a token the wire behavior stays exactly today's
 *     (zero notifications/progress); a DETACHED delegation (background: true)
 *     emits NO progress at all - no frames before or after its response, no
 *     progress_bridge in the run's receipt - while a foreground delegation on
 *     the same connection still gets its bridge.
 * 11. Live-follow companion CLI (`dist/follow.js` over the fake-agy harness):
 *     the success run exits 0 with >=2 mirrored fake stream lines before the
 *     `=== task done ===` marker, the JSON after the marker parses to a
 *     success TaskResult, stderr carries exactly the `[agy-agent-follow]`
 *     banner, `--model` reaches agy as an adjacent pair with NO `--effort`
 *     argument anywhere, mirrored lines match the on-disk .stream transcript,
 *     and stdout outside the framing/stream/result block is whitespace-only;
 *     the failure path exits 1 with a non-success status.
 * 12. Verified audit fixes (A1, A6, X1, F1):
 *     - hash-based touch detection: file dirty before run and modified during it
 *       is reported in files_touched (and scope_violations);
 *     - exit-fallback hygiene: stdio destroyed and data listeners detached on
 *       fallback settle, so no idle timer is re-armed;
 *     - cancellation over stdio: notifications/cancelled for in-flight request
 *       kills child and releases lock so next delegation is accepted;
 *     - follow CLI argument parsing: bare -- end-of-options delimiter forwards
 *       prompt containing -- verbatim to the agent.
 * 13. Handle-and-watch workflow (background delegation, polling, and cancellation):
 *     - background delegation returns in well under a second with status "running" and a task id;
 *     - polling watch_task shows running true and transcript content that grows between polls;
 *     - once finished, watch_task includes the final result with status success and response text;
 *     - a second delegation is rejected while the detached run holds the single-flight lock;
 *     - watch_task with cancel true stops a running detached task and the last report shows it stopped.
 * 14. watch_task digest: the transcript is parsed into a compact step feed
 *     (one entry per completed event with kind, label, target, duration and
 *     token usage), plus phase, elapsed_seconds and usage_latest - while the
 *     raw transcript tail stays available.
 * 15. Effort & model resolution in the MCP layer (the argv the server really
 *     spawns, driven over stdio against a fake agy):
 *     - general_task without model/effort passes --effort medium, explore_task
 *       passes --effort low (the documented defaults are real now);
 *     - a tier-carrying model id (gemini-3.8-flash-high) suppresses --effort
 *       entirely - both without an effort and with the matching one;
 *     - a tier-carrying model id with a DIFFERENT effort, an unsupported
 *       effort (xhigh) and an off-enum effort (banana) are refused locally:
 *       isError envelope with a {"error": ...} body and ZERO fake-agy
 *       invocations, and the single-flight lock is released afterwards.
 *     - tier detection is case-insensitive (the agy CLI resolves model ids
 *       case-insensitively): a case-variant tier id is refused locally on a
 *       conflicting effort (zero invocations) and suppresses --effort
 *       otherwise.
 * 16. Failure surfacing in the MCP layer (driven over stdio against a fake agy):
 *     - a failed delegation (the CLI reports status ERROR with its own error
 *       message and exits 3) comes back with isError true, status "error" and
 *       the CLI's error message verbatim in body.error, while the process exit
 *       code stays in the separate exit_code field and the stderr noise stays
 *       in notes;
 *     - a successful delegation comes back with isError false, status
 *       "success" and no error field;
 *     - a run that failed although the process exited 0 (a result event with no
 *       status field, and no result event at all) comes back with isError true
 *       and status "error", and its error text never reads like a clean exit
 *       (no "code 0").
 * 17. Input validation in the MCP layer: the schema the server advertises in
 *     tools/list is ENFORCED before anything is spawned.
 *     - a missing, empty, whitespace-only, null or wrong-typed prompt, a
 *       wrong-typed / out-of-range argument, and an unknown argument key are
 *       all refused with the house {"error": ...} envelope (isError true, one
 *       key) whose message names the offending argument - with ZERO fake-agy
 *       invocations, no task transcript, and no progress notification;
 *     - watch_task and the two list tools are validated the same way;
 *     - a valid call still succeeds afterwards (the single-flight lock was
 *       released by the refusals) and spawns exactly one agy.
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
  rmSync,
  symlinkSync,
  unlinkSync,
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
// The fake exits non-zero here, so the error names the exit code ("agy exited with code 1").
// The zero-exit twin of this scenario (a run that fails although the process exited 0, which
// must NOT be described as a clean exit) is covered in section 16.
const runBad = await fakeRun(
  [
    argCap,
    `printf '%s\\n' '{"event":"init","conversation_id":"bad-c1","init":{"cwd":"/work","tools":["a"],"permission_mode":"request-review"}}'`,
    `printf '%s\\n' '{"event":"step_update","step_update":{"conversation_id":"bad-c1","step_index":0,"state":"DONE","step_type":"user_input"}}'`,
    'echo "something went wrong during boot"',
    'echo "{not json"',
    "exit 1",
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

// ---------------------------------------------------------------------------
// 9/10 shared driver: bin/mcp.mjs over one stdio connection + a slow fake agy
// ---------------------------------------------------------------------------

type ParsedJsonRpc = {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: { progressToken?: string | number; progress?: number; message?: string; [k: string]: unknown };
  result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean; [k: string]: unknown };
  error?: { code?: number; message?: string };
};

interface McpIo {
  /** Raw stdout lines in arrival order (one JSON-RPC frame per line). */
  lines: string[];
  parsed(): ParsedJsonRpc[];
  send(message: unknown): void;
  waitUntil(pred: () => boolean, label: string): Promise<void>;
  responseFor(id: string | number): ParsedJsonRpc | undefined;
}

function parseLine(raw: string): ParsedJsonRpc {
  try {
    return JSON.parse(raw) as ParsedJsonRpc;
  } catch {
    return {};
  }
}

function contentText(resp: ParsedJsonRpc | undefined, id: string | number): string {
  const text = resp?.result?.content?.[0]?.text;
  if (typeof text !== "string") {
    throw new Error(`response ${id} must carry a text content block: ${JSON.stringify(resp)}`);
  }
  return text;
}

/**
 * Spawn bin/mcp.mjs (dist build) with a fake agy, run `drive` against the
 * collected stdout order, then end stdin and return the exit code (EOF must
 * exit cleanly: the bridge timers are unref'd). Raw stdout lines stay in
 * arrival order, one JSON-RPC frame per line.
 */
async function driveMcpStdio(
  agyBin: string,
  stateDir: string,
  drive: (io: McpIo) => Promise<void>
): Promise<{ exitCode: number; argfile: string }> {
  const argfile = path.join(stateDir, "argv.txt");
  const child = spawn(process.execPath, ["bin/mcp.mjs"], {
    cwd: ROOT,
    env: { ...process.env, AGY_BIN: agyBin, AGY_MCP_STATE_DIR: stateDir, AGY_FAKE_ARGFILE: argfile },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines: string[] = [];
  let pending = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d: string) => {
    pending += d;
    for (;;) {
      const nl = pending.indexOf("\n");
      if (nl < 0) break;
      lines.push(pending.slice(0, nl));
      pending = pending.slice(nl + 1);
    }
  });

  const io: McpIo = {
    lines,
    parsed: () => lines.map(parseLine),
    send: (message) => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    waitUntil: async (pred, label) => {
      const deadline = Date.now() + 20_000;
      while (!pred() && Date.now() < deadline) await sleep(20);
      if (!pred()) {
        child.kill("SIGKILL");
        throw new Error(`timed out waiting for ${label}`);
      }
    },
    responseFor: (id) => io.parsed().find((p) => p.id === id && ("result" in p || "error" in p)),
  };

  try {
    await drive(io);
  } catch (err) {
    child.kill("SIGKILL");
    throw err;
  }
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
  return { exitCode, argfile };
}

/**
 * Slow stream-json fixture shared by sections 9 and 10: records one "invoke"
 * marker per real invocation (argv appended), then walks init -> user_input ->
 * agent_response delta -> read_file step -> result event with 500ms pauses
 * (well above the 200ms progress coalesce window, ~2s total). The result event
 * renders the runner's `== done: status=... ` closing marker.
 */
const SLOW_STREAM_BODY = [
  `printf '%s\\n' "invoke" >> "$AGY_FAKE_ARGFILE"`,
  `printf '%s\\n' "$@" >> "$AGY_FAKE_ARGFILE"`,
  `sleep 0.05`,
  `printf '%s\\n' '{"event":"init","conversation_id":"slow-c1","init":{"cwd":"/work/slow","tools":["read_file"],"permission_mode":"plan"}}'`,
  `sleep 0.5`,
  `printf '%s\\n' '{"event":"step_update","step_update":{"conversation_id":"slow-c1","step_index":0,"state":"DONE","step_type":"user_input"}}'`,
  `sleep 0.5`,
  `printf '%s\\n' '{"event":"step_update","step_update":{"conversation_id":"slow-c1","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"working on it "}}'`,
  `printf '%s\\n' '{"event":"step_update","step_update":{"conversation_id":"slow-c1","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"hard","duration_seconds":0.5,"usage":{"total_tokens":1002}}}'`,
  `sleep 0.5`,
  `printf '%s\\n' '{"event":"step_update","step_update":{"conversation_id":"slow-c1","step_index":2,"state":"DONE","step_type":"tool","tool_name":"read_file","duration_seconds":0.2,"tool_info":{"name":"read_file","parameters":{"Path":"/tmp/slow.txt"},"output":"1 lines, 6 bytes"}}}'`,
  `sleep 0.5`,
  `printf '%s\\n' '{"event":"result","result":{"conversation_id":"slow-c1","status":"SUCCESS","response":"working on it hard\\n","duration_seconds":2.1,"num_turns":1}}'`,
].join("\n");

function writeSlowAgy(): string {
  const bin = path.join(tmpBase, `fake-agy-${fakeCounter++}`);
  writeFileSync(bin, `#!/bin/sh\n${SLOW_STREAM_BODY}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

const HANDSHAKE = (clientName: string) => ({
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: clientName, version: "0" },
});

// ---------------------------------------------------------------------------
// 9. Single-flight lock: a second delegation is rejected, never queued
// ---------------------------------------------------------------------------
{
  const slowLock = writeSlowAgy();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "agy-lock-"));
  let rejectionMsg = "";
  const { exitCode, argfile } = await driveMcpStdio(slowLock, stateDir, async (io) => {
    io.send({
      jsonrpc: "2.0",
      id: 90,
      method: "initialize",
      params: HANDSHAKE("lock-probe"),
    });
    io.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await io.waitUntil(() => !!io.responseFor(90), "initialize response (id 90)");

    // Back-to-back fire WITHOUT awaiting the first: same scenario ids 31/32.
    const deleg = { name: "general_task", arguments: { prompt: "single-flight lock probe", cwd: stateDir } };
    io.send({ jsonrpc: "2.0", id: 31, method: "tools/call", params: { ...deleg } });
    io.send({
      jsonrpc: "2.0",
      id: 32,
      method: "tools/call",
      // Progress token on the REJECTED call, to prove it emits no progress.
      params: { ...deleg, _meta: { progressToken: "tok-rejected" } },
    });
    await io.waitUntil(() => !!io.responseFor(32), "lock rejection response (id 32)");

    // watch_task must NOT be locked while the first task still runs: found and
    // running info (the fake needs ~2s to reach its == done marker).
    io.send({ jsonrpc: "2.0", id: 33, method: "tools/call", params: { name: "watch_task", arguments: {} } });
    await io.waitUntil(() => !!io.responseFor(33), "watch mid-run response (id 33)");
    const watch = JSON.parse(contentText(io.responseFor(33), 33)) as {
      found?: boolean;
      running?: boolean;
      finished?: boolean;
    };
    if (watch.found !== true || watch.running !== true || watch.finished !== false) {
      throw new Error(`watch_task must answer found/running info mid-run, got: ${JSON.stringify(watch)}`);
    }

    await io.waitUntil(() => !!io.responseFor(31), "delegation response (id 31)");

    const delegation = JSON.parse(contentText(io.responseFor(31), 31)) as {
      status?: string;
      task_id?: string;
      stream_file?: string;
    };
    if (delegation.status !== "success" || typeof delegation.task_id !== "string") {
      throw new Error(`run under the lock must succeed normally: ${JSON.stringify(delegation)}`);
    }
    if (typeof delegation.stream_file !== "string" || !delegation.stream_file.endsWith(".stream")) {
      throw new Error(`delegation result must carry stream_file: ${JSON.stringify(delegation)}`);
    }

    const busy = io.responseFor(32);
    if (busy?.result?.isError !== true) {
      throw new Error(`response 32 must be the isError rejection envelope: ${JSON.stringify(busy)}`);
    }
    const msg = contentText(busy, 32);
    rejectionMsg = msg;
    const streamBase = path.basename(delegation.stream_file);
    if (
      !msg.includes("another delegation is already running") ||
      !msg.includes("one agent at a time") ||
      !msg.includes(delegation.task_id) ||
      !msg.includes(streamBase)
    ) {
      throw new Error(
        `rejection message must name the in-flight task id + stream basename and the one-agent rule:` +
          ` task=${delegation.task_id} base=${streamBase} msg=${msg}`
      );
    }

    // 31 carries no token and 32 was rejected: zero progress on this connection.
    const notes = io.parsed().filter((p) => p.method === "notifications/progress");
    if (notes.length !== 0) {
      throw new Error(`rejected call under the lock must emit no notifications/progress: ${JSON.stringify(notes)}`);
    }
  });
  if (exitCode !== 0) {
    throw new Error(`stdin EOF must end the server cleanly with exit 0, got ${exitCode}`);
  }

  // Exactly ONE real agy invocation happened (argfile marker lines).
  const invocations = readFileSync(argfile, "utf8")
    .split("\n")
    .filter((l) => l === "invoke").length;
  if (invocations !== 1) {
    throw new Error(`under the single-flight lock only one agy invocation may happen, argfile has ${invocations}`);
  }
  // The rejected call never started a run: only one task transcript exists.
  const streamCount = readdirSync(stateDir).filter((f) => f.endsWith(".stream")).length;
  if (streamCount !== 1) {
    throw new Error(`rejected call must not create a second task, state dir has ${streamCount} .stream files`);
  }

  console.log(
    `single-flight lock: id 32 isError rejection ("${rejectionMsg}") names task + stream, watch_task id 33 found/running mid-run, 1 invocation, EOF exit 0: ok`
  );
}

// ---------------------------------------------------------------------------
// 10. Progress bridge: token-gated notifications/progress over stdio
// ---------------------------------------------------------------------------
{
  const slowBridge = writeSlowAgy();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "agy-progress-"));
  let noteCount = 0;
  const { exitCode } = await driveMcpStdio(slowBridge, stateDir, async (io) => {
    io.send({ jsonrpc: "2.0", id: 91, method: "initialize", params: HANDSHAKE("progress-probe") });
    io.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await io.waitUntil(() => !!io.responseFor(91), "initialize response (id 91)");

    io.send({
      jsonrpc: "2.0",
      id: 41,
      method: "tools/call",
      params: {
        name: "general_task",
        arguments: { prompt: "progress bridge probe", cwd: stateDir },
        _meta: { progressToken: "tok42" },
      },
    });
    await io.waitUntil(() => !!io.responseFor(41), "delegation response (id 41)");

    // Parse the raw stdout in ORDER: notifications before the result line.
    const out = io.lines;
    const resultIdx = out.findIndex((l) => {
      const p = parseLine(l);
      return p.id === 41 && ("result" in p || "error" in p);
    });
    if (resultIdx < 0) {
      throw new Error(`must receive a result response for id 41: ${JSON.stringify(out.slice(-3))}`);
    }

    const notes: Array<{ progressToken: string | number; progress: number; message: string }> = [];
    for (let i = 0; i < resultIdx; i++) {
      const p = parseLine(out[i]);
      if (p.method !== "notifications/progress") continue;
      const params = p.params ?? {};
      if (JSON.stringify(Object.keys(params).sort()) !== JSON.stringify(["message", "progress", "progressToken"])) {
        throw new Error(`progress frame params shape wrong: ${JSON.stringify(params)}`);
      }
      notes.push(params as { progressToken: string; progress: number; message: string });
    }
    noteCount = notes.length;

    // (b) progress values: strictly increasing integers starting at 0.
    if (notes.length < 3) {
      throw new Error(`(a) expected >=3 notifications/progress before the result, got ${notes.length}`);
    }
    if (notes[0].progress !== 0) {
      throw new Error(`(b) first notification must be task-started progress=0: ${JSON.stringify(notes[0])}`);
    }
    const values = notes.map((n) => n.progress);
    for (let i = 1; i < values.length; i++) {
      if (!Number.isInteger(values[i]) || values[i] <= values[i - 1]) {
        throw new Error(`(b) progress values must be strictly increasing integers: ${JSON.stringify(values)}`);
      }
    }
    for (const n of notes) {
      if (n.progressToken !== "tok42") {
        throw new Error(`(b) progress token must be echoed as received: ${JSON.stringify(n)}`);
      }
    }

    // The transcript exists and closes with the runner's == done marker.
    const streamName = readdirSync(stateDir).find((f) => f.endsWith(".stream"));
    if (typeof streamName !== "string") {
      throw new Error(`state dir fixture must contain the task's .stream transcript: ${readdirSync(stateDir)}`);
    }
    const streamText = readFileSync(path.join(stateDir, streamName), "utf8");
    if (!streamText.split("\n").some((l) => l.startsWith("== done: status="))) {
      throw new Error(`stream transcript must end with a == done: marker:\n${streamText}`);
    }

    // The task-started notice is synthetic: stream basename only.
    if (notes[0].message !== `task started · stream ${streamName}`) {
      throw new Error(`task-started message must name the stream basename only: ${JSON.stringify(notes[0].message)}`);
    }

    // (c) every mirrored-line message fragment appears in the final .stream file.
    for (const n of notes.slice(1)) {
      for (const frag of n.message.split("\n")) {
        if (frag !== "" && !streamText.includes(frag)) {
          throw new Error(
            `(c) progress fragment not present in the .stream transcript (${streamName}): ${JSON.stringify(frag)}`
          );
        }
      }
    }

    // (d) the LAST progress message includes the == done line and its stdout
    // position precedes the result response line for the same id.
    const lastMsg = notes[notes.length - 1].message;
    if (!lastMsg.includes("== done: status=SUCCESS")) {
      throw new Error(`(d) last progress message must include the == done line: ${JSON.stringify(lastMsg)}`);
    }
    let lastNoteIdx = -1;
    for (let i = resultIdx - 1; i >= 0; i--) {
      if (parseLine(out[i]).method === "notifications/progress") {
        lastNoteIdx = i;
        break;
      }
    }
    if (lastNoteIdx < 0 || lastNoteIdx >= resultIdx) {
      throw new Error(`(d) final flush must precede the result envelope (note@${lastNoteIdx}, result@${resultIdx})`);
    }

    const delegation = JSON.parse(contentText(io.responseFor(41), 41)) as { status?: string };
    if (delegation.status !== "success") {
      throw new Error(`token-gated delegation must still succeed normally: ${JSON.stringify(delegation)}`);
    }
  });
  if (exitCode !== 0) {
    throw new Error(`stdin EOF must end the server cleanly with exit 0, got ${exitCode}`);
  }

  // (e) Repeat the same delegation WITHOUT the token on a fresh child: the
  // observable behavior is exactly today's — zero notifications/progress.
  const slowNoToken = writeSlowAgy();
  const noTokenDir = mkdtempSync(path.join(os.tmpdir(), "agy-notoken-"));
  const { exitCode: exitNoToken } = await driveMcpStdio(slowNoToken, noTokenDir, async (io) => {
    io.send({ jsonrpc: "2.0", id: 92, method: "initialize", params: HANDSHAKE("no-token-probe") });
    io.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await io.waitUntil(() => !!io.responseFor(92), "initialize response (id 92)");
    io.send({
      jsonrpc: "2.0",
      id: 42,
      method: "tools/call",
      params: { name: "general_task", arguments: { prompt: "tokenless delegation", cwd: noTokenDir } },
    });
    await io.waitUntil(() => !!io.responseFor(42), "tokenless delegation response (id 42)");
    if (io.lines.some((l) => l.includes("notifications/progress"))) {
      throw new Error(`(e) tokenless delegation must emit ZERO notifications/progress: ${JSON.stringify(io.lines)}`);
    }
    const delegation = JSON.parse(contentText(io.responseFor(42), 42)) as { status?: string };
    if (delegation.status !== "success") {
      throw new Error(`(e) tokenless delegation must succeed normally: ${JSON.stringify(delegation)}`);
    }
  });
  if (exitNoToken !== 0) {
    throw new Error(`(e) stdin EOF must end the server cleanly with exit 0, got ${exitNoToken}`);
  }

  // (f) A DETACHED delegation (background: true) must emit NO
  // notifications/progress at all: it answers immediately, so the request the
  // progress frames would belong to is no longer in flight (the official MCP
  // SDK client drops its progress handler on the response and then reports
  // "unknown token" for every later frame). A FOREGROUND delegation on the
  // same connection still gets its bridge, and the detached run's receipt
  // carries no progress_bridge.
  const detachedAgy = writeSlowAgy();
  const detachedDir = mkdtempSync(path.join(os.tmpdir(), "agy-detached-progress-"));
  let foregroundFrames = 0;
  let detachedFrames = 0;
  const { exitCode: exitDetached } = await driveMcpStdio(detachedAgy, detachedDir, async (io) => {
    const progressFrames = () => io.parsed().filter((p) => p.method === "notifications/progress");

    io.send({ jsonrpc: "2.0", id: 93, method: "initialize", params: HANDSHAKE("detached-progress-probe") });
    io.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await io.waitUntil(() => !!io.responseFor(93), "initialize response (id 93)");

    // (f1) The foreground path is untouched: a token still buys a bridge.
    io.send({
      jsonrpc: "2.0",
      id: 43,
      method: "tools/call",
      params: {
        name: "general_task",
        arguments: { prompt: "foreground progress probe", cwd: detachedDir },
        _meta: { progressToken: "tok-fg-detached" },
      },
    });
    await io.waitUntil(() => !!io.responseFor(43), "foreground delegation response (id 43)");
    foregroundFrames = progressFrames().length;
    if (foregroundFrames < 1) {
      throw new Error(`(f1) a foreground delegation must still emit notifications/progress, got ${foregroundFrames}`);
    }
    for (const frame of progressFrames()) {
      if (frame.params?.progressToken !== "tok-fg-detached") {
        throw new Error(`(f1) the foreground bridge must echo its own token: ${JSON.stringify(frame.params)}`);
      }
    }
    const foregroundResult = JSON.parse(contentText(io.responseFor(43), 43)) as {
      status?: string;
      progress_bridge?: { token?: string | number; notifications?: number };
    };
    if (foregroundResult.status !== "success") {
      throw new Error(`(f1) the foreground delegation must still succeed: ${JSON.stringify(foregroundResult)}`);
    }
    if (
      foregroundResult.progress_bridge?.token !== "tok-fg-detached" ||
      (foregroundResult.progress_bridge?.notifications ?? 0) < 1
    ) {
      throw new Error(
        `(f1) the foreground receipt must carry its progress_bridge: ${JSON.stringify(foregroundResult)}`
      );
    }

    // (f2) The detached path has no bridge: the token is ignored, not echoed.
    const beforeDetached = progressFrames().length;
    io.send({
      jsonrpc: "2.0",
      id: 44,
      method: "tools/call",
      params: {
        name: "general_task",
        arguments: { prompt: "detached progress probe", cwd: detachedDir, background: true },
        _meta: { progressToken: "tok-bg-detached" },
      },
    });
    await io.waitUntil(() => !!io.responseFor(44), "detached delegation response (id 44)");
    const atResponse = progressFrames().length;
    if (atResponse !== beforeDetached) {
      throw new Error(
        `(f2) a detached delegation must emit NO notifications/progress, got ${atResponse - beforeDetached} extra frames`
      );
    }
    const handle = JSON.parse(contentText(io.responseFor(44), 44)) as { task_id?: string; status?: string };
    if (handle.status !== "running" || typeof handle.task_id !== "string") {
      throw new Error(`(f2) the detached call must return a running handle: ${JSON.stringify(handle)}`);
    }

    // (f3) The detached run finishes - and still says nothing on the wire.
    let report: { finished?: boolean; result_ready?: boolean; status?: string; progress_bridge?: unknown } | undefined;
    let pollId = 60;
    const pollDeadline = Date.now() + 20_000;
    while (Date.now() < pollDeadline) {
      const pid = pollId++;
      io.send({
        jsonrpc: "2.0",
        id: pid,
        method: "tools/call",
        params: { name: "watch_task", arguments: { stream_file: handle.task_id } },
      });
      await io.waitUntil(() => !!io.responseFor(pid), `watch poll (id ${pid})`);
      const r = JSON.parse(contentText(io.responseFor(pid), pid)) as {
        finished?: boolean;
        result_ready?: boolean;
        status?: string;
        progress_bridge?: unknown;
      };
      if (r.running === false && r.result_ready === true) {
        report = r;
        break;
      }
      await sleep(200);
    }
    if (report?.status !== "success") {
      throw new Error(`(f3) the detached run must complete successfully: ${JSON.stringify(report)}`);
    }
    detachedFrames = progressFrames().length - beforeDetached;
    if (detachedFrames !== 0) {
      throw new Error(
        `(f3) a detached run must not emit notifications/progress after its response, got ${detachedFrames}`
      );
    }
    if (report?.progress_bridge !== undefined) {
      throw new Error(`(f3) the detached run's receipt must NOT carry progress_bridge: ${JSON.stringify(report)}`);
    }
  });
  if (exitDetached !== 0) {
    throw new Error(`(f) stdin EOF must end the server cleanly with exit 0, got ${exitDetached}`);
  }

  console.log(
    `progress bridge: ${noteCount} token-gated notifications (>=3 pre-result, progress strictly increasing from 0, fragments mirrored from .stream, == done last & ahead of the envelope); tokenless delegation emits 0; a detached (background) delegation emits 0 frames and no progress_bridge (${foregroundFrames} foreground frames on the same connection): ok`
  );
}

// ---------------------------------------------------------------------------
// 11. Live-follow companion CLI: dist/follow.js delegates runTask directly
// ---------------------------------------------------------------------------
{
  // Deterministic stream fixtures (no sleeps -> the mirrored lines are exactly
  // these): quick SUCCESS for the live-mirror/argv probes, nonzero-exit ERROR
  // for the failure path. Both capture argv via the same argCap mechanism the
  // argv-envelope sections use.
  const QUICK_BODY = [
    argCap,
    `printf '%s\\n' '{"event":"init","conversation_id":"follow-c1","init":{"cwd":"/work/follow","tools":["read_file"],"permission_mode":"plan"}}'`,
    `printf '%s\\n' '{"event":"step_update","step_update":{"conversation_id":"follow-c1","step_index":0,"state":"DONE","step_type":"user_input"}}'`,
    `printf '%s\\n' '{"event":"result","result":{"conversation_id":"follow-c1","status":"SUCCESS","response":"done quickly","duration_seconds":1.2,"num_turns":1}}'`,
  ].join("\n");
  const FAIL_BODY = [
    argCap,
    `printf '%s\\n' '{"event":"init","conversation_id":"follow-f1","init":{"cwd":"/work/fail","tools":[],"permission_mode":"accept-edits"}}'`,
    `printf '%s\\n' '{"event":"result","result":{"conversation_id":"follow-f1","status":"ERROR","response":"exploded","duration_seconds":0.9,"num_turns":1}}'`,
    "exit 2",
  ].join("\n");
  const quickFollowBin = path.join(tmpBase, `fake-agy-${fakeCounter++}`);
  const failFollowBin = path.join(tmpBase, `fake-agy-${fakeCounter++}`);
  writeFileSync(quickFollowBin, `#!/bin/sh\n${QUICK_BODY}\n`);
  writeFileSync(failFollowBin, `#!/bin/sh\n${FAIL_BODY}\n`);
  chmodSync(quickFollowBin, 0o755);
  chmodSync(failFollowBin, 0o755);

  console.log("follow CLI: starting");
  const MARKER = "\n=== task done ===\n";

  /** Spawn dist/follow.js over one state dir, collect full stdio, wait for exit. */
  async function spawnFollow(
    stateDir: string,
    agyBin: string,
    args: string[]
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const argfile = path.join(stateDir, "argv.txt");
    return await new Promise((resolve) => {
      const child = spawn(process.execPath, ["dist/follow.js", ...args], {
        cwd: ROOT,
        env: {
          ...process.env,
          AGY_BIN: agyBin,
          AGY_MCP_STATE_DIR: stateDir,
          AGY_FAKE_ARGFILE: argfile,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdoutText = "";
      let stderrText = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (d: string) => {
        stdoutText += d;
      });
      child.stderr.on("data", (d: string) => {
        stderrText += d;
      });
      const killer = setTimeout(() => child.kill("SIGKILL"), 20_000);
      killer.unref?.();
      child.on("exit", (code) => {
        clearTimeout(killer);
        resolve({ code: code ?? -999, stdout: stdoutText, stderr: stderrText });
      });
    });
  }

  // (a) Success run — exit 0, live mirror before the marker, result JSON after.
  const okDir = mkdtempSync(path.join(os.tmpdir(), "agy-follow-"));
  const ok = await spawnFollow(okDir, quickFollowBin, [
    "--model",
    "gemini-3.8-flash-medium",
    "--cwd",
    okDir,
    "watch",
    "this",
    "delegation",
    "live",
  ]);
  if (ok.code !== 0) {
    throw new Error(`(11) follow success run must exit 0, got ${ok.code}\nstdout: ${ok.stdout}\nstderr: ${ok.stderr}`);
  }

  // stderr: exactly the single meta banner, nothing else.
  const okStderr = ok.stderr.split("\n").filter((l) => l.trim() !== "");
  const okBanner = `[agy-agent-follow] tool=general model=gemini-3.8-flash-medium cwd=${okDir}`;
  if (okStderr.join("\n") !== okBanner) {
    throw new Error(`(11) stderr must be exactly the meta banner, got: ${JSON.stringify(ok.stderr)}`);
  }

  // stdout framing: split at the marker; JSON result after it.
  const markerIdx = ok.stdout.indexOf(MARKER);
  if (markerIdx < 0) {
    throw new Error(`(11) stdout must contain the "=== task done ===" marker: ${JSON.stringify(ok.stdout)}`);
  }
  const front = ok.stdout.slice(0, markerIdx);
  const after = ok.stdout.slice(markerIdx + MARKER.length);
  const followed = JSON.parse(after) as { status?: string; task_id?: string; stream_file?: string };
  if (followed.status !== "success" || typeof followed.task_id !== "string") {
    throw new Error(`(11) result JSON after the marker must be a success TaskResult: ${after}`);
  }

  // Pre-marker stdout = the single --- task banner + the fake's mirrored
  // stream lines, and NOTHING else non-whitespace (stdout purity: the meta
  // banner went to stderr).
  const frontLines = front.split("\n");
  const taskStart = frontLines.filter((l) => l.startsWith("--- task "));
  const mirrored = frontLines.filter((l) => l.trim() !== "" && !l.startsWith("--- task "));
  const wantMirror = [
    "session open · cwd=/work/follow · permission_mode=plan · tools=1",
    "● user_input",
    "== done: status=SUCCESS · 1.2s",
  ];
  if (mirrored.length < 2 || JSON.stringify(mirrored) !== JSON.stringify(wantMirror)) {
    throw new Error(
      `(11) pre-marker stdout must be only the mirrored stream lines (>= 2), got: ${JSON.stringify(mirrored)}`
    );
  }
  if (
    taskStart.length !== 1 ||
    !/^--- task task_[0-9a-f]{8} · stream task_[0-9a-f]{8}\.stream ---$/.test(taskStart[0] as string)
  ) {
    throw new Error(
      `(11) --- task banner must name the in-flight task id + stream basename: ${JSON.stringify(taskStart)}`
    );
  }
  // Every mirrored line must also have reached the on-disk .stream transcript
  // the result names (bridge hook fires only after a successful file append).
  const okStream = readFileSync(followed.stream_file as string, "utf8");
  for (const line of mirrored) {
    if (!okStream.includes(line)) {
      throw new Error(`(11) mirrored line missing from the on-disk .stream transcript: ${JSON.stringify(line)}`);
    }
  }

  // (c) Model/effort flag discipline: --model reaches agy as an adjacent pair;
  // no --effort argument at all (the agy CLI rejects it next to a tiered id).
  const argvFollow = readArgv(path.join(okDir, "argv.txt"));
  const modelPos = argvFollow.indexOf("--model");
  if (modelPos < 0 || argvFollow[modelPos + 1] !== "gemini-3.8-flash-medium") {
    throw new Error(`(11) --model must reach agy as an adjacent pair, argv: ${argvFollow.join(" ")}`);
  }
  if (argvFollow.includes("--effort")) {
    throw new Error(`(11) follow must never pass --effort (model ID carries its tier), argv: ${argvFollow.join(" ")}`);
  }

  // (b) Failure path: non-success CLI result -> exit 1 and non-success status.
  const badDir = mkdtempSync(path.join(os.tmpdir(), "agy-fail-"));
  const bad = await spawnFollow(badDir, failFollowBin, ["--cwd", badDir, "probe", "the", "failure", "path"]);
  if (bad.code !== 1) {
    throw new Error(
      `(11) follow must exit 1 on a non-success run, got ${bad.code}\nstdout: ${bad.stdout}\nstderr: ${bad.stderr}`
    );
  }
  const badBanner = `[agy-agent-follow] tool=general model=default cwd=${badDir}`;
  if (
    bad.stderr
      .split("\n")
      .filter((l) => l.trim() !== "")
      .join("\n") !== badBanner
  ) {
    throw new Error(`(11) failure-run stderr must be exactly the meta banner, got: ${JSON.stringify(bad.stderr)}`);
  }
  const badIdx = bad.stdout.indexOf(MARKER);
  if (badIdx < 0) {
    throw new Error(`(11) failure-run stdout must contain the result marker: ${JSON.stringify(bad.stdout)}`);
  }
  const badResult = JSON.parse(bad.stdout.slice(badIdx + MARKER.length)) as { status?: string };
  if (badResult.status === "success" || typeof badResult.status !== "string") {
    throw new Error(
      `(11) failure-run result must carry a non-success status: ${bad.stdout.slice(badIdx + MARKER.length)}`
    );
  }

  console.log(
    `follow CLI: success exit ${ok.code}/failure exit ${bad.code}, ${mirrored.length} mirrored stream lines pre-marker + parsed result JSON after, stderr banner-only, --model pair without --effort, stdout pure: ok`
  );
}

// ---------------------------------------------------------------------------
// 12. Verified audit fixes (A1, A6, X1, F1)
// ---------------------------------------------------------------------------
{
  // 12a. Hash-based touch detection (A1):
  // A file already dirty before the run whose contents change during it must be
  // reported in files_touched (and scope_violations if out of scope).
  const auditRepo = mkdtempSync(path.join(os.tmpdir(), "agy-audit-a1-"));
  try {
    spawnSync("git", ["init", auditRepo]);
    writeFileSync(path.join(auditRepo, "clean.txt"), "clean\n");
    writeFileSync(path.join(auditRepo, "dirty-changed.txt"), "v1\n");
    writeFileSync(path.join(auditRepo, "dirty-unchanged.txt"), "same\n");
    writeFileSync(path.join(auditRepo, "dirty-committed.txt"), "c1\n");
    writeFileSync(path.join(auditRepo, "clean-deleted.txt"), "to-be-deleted\n");
    writeFileSync(path.join(auditRepo, "symlink-target1.txt"), "t1\n");
    writeFileSync(path.join(auditRepo, "symlink-target2.txt"), "t2\n");
    symlinkSync("symlink-target1.txt", path.join(auditRepo, "test-symlink"));
    spawnSync("git", ["-C", auditRepo, "add", "."]);
    spawnSync("git", ["-C", auditRepo, "-c", "user.email=t@e", "-c", "user.name=t", "commit", "-m", "init"]);

    // Make files dirty before the run
    writeFileSync(path.join(auditRepo, "dirty-changed.txt"), "v2-dirty-before\n");
    writeFileSync(path.join(auditRepo, "dirty-unchanged.txt"), "same-dirty-before\n");
    writeFileSync(path.join(auditRepo, "dirty-committed.txt"), "c2-dirty-before\n");

    const snapA1 = runner.captureFilesBefore(auditRepo);
    if (snapA1 === null) throw new Error("(12a) captureFilesBefore returned null");

    // During the run:
    // 1. modify dirty-changed.txt (dirty-unchanged.txt is untouched)
    writeFileSync(path.join(auditRepo, "dirty-changed.txt"), "v3-dirty-during\n");
    // 2. commit dirty-committed.txt (becomes clean in git status)
    spawnSync("git", ["-C", auditRepo, "add", "dirty-committed.txt"]);
    spawnSync("git", ["-C", auditRepo, "-c", "user.email=t@e", "-c", "user.name=t", "commit", "-m", "commit dirty"]);
    // 3. delete clean-deleted.txt
    unlinkSync(path.join(auditRepo, "clean-deleted.txt"));
    // 4. change symlink target
    unlinkSync(path.join(auditRepo, "test-symlink"));
    symlinkSync("symlink-target2.txt", path.join(auditRepo, "test-symlink"));

    const auditRes = runner.auditTaskFiles({ cwd: auditRepo, filesBefore: snapA1, editScope: ["clean.txt"] });
    if (!auditRes?.files_touched.includes("dirty-changed.txt")) {
      throw new Error(`(12a) files_touched missing pre-dirty changed file: ${JSON.stringify(auditRes?.files_touched)}`);
    }
    if (auditRes.files_touched.includes("dirty-unchanged.txt")) {
      throw new Error(
        `(12a) files_touched must omit pre-dirty unchanged file: ${JSON.stringify(auditRes.files_touched)}`
      );
    }
    if (!auditRes.scope_violations?.includes("dirty-changed.txt")) {
      throw new Error(
        `(12a) scope_violations missing pre-dirty changed file: ${JSON.stringify(auditRes.scope_violations)}`
      );
    }
    if (!auditRes.files_touched.includes("dirty-committed.txt")) {
      throw new Error(
        `(12a) files_touched missing pre-dirty file committed during run: ${JSON.stringify(auditRes.files_touched)}`
      );
    }
    if (!auditRes.files_touched.includes("clean-deleted.txt")) {
      throw new Error(`(12a) files_touched missing file deleted during run: ${JSON.stringify(auditRes.files_touched)}`);
    }
    if (!auditRes.files_touched.includes("test-symlink")) {
      throw new Error(`(12a) files_touched missing modified symlink: ${JSON.stringify(auditRes.files_touched)}`);
    }

    // Verify 5 MB fallback threshold (large file)
    const bigFile = "big-dirty.bin";
    const bigPath = path.join(auditRepo, bigFile);
    writeFileSync(bigPath, Buffer.alloc(5 * 1024 * 1024 + 10, 1));
    const snapBig = runner.captureFilesBefore(auditRepo);
    if (snapBig === null) throw new Error("(12a) captureFilesBefore for big file returned null");
    // Change size during run
    writeFileSync(bigPath, Buffer.alloc(5 * 1024 * 1024 + 20, 2));
    const auditBig = runner.auditTaskFiles({ cwd: auditRepo, filesBefore: snapBig });
    if (!auditBig?.files_touched.includes(bigFile)) {
      throw new Error(`(12a) large dirty file touched not detected: ${JSON.stringify(auditBig?.files_touched)}`);
    }
  } finally {
    rmSync(auditRepo, { recursive: true, force: true });
  }

  // 12b. Exit-fallback hygiene (A6):
  // When the child process exits but a descendant holds stdio open, the 2s
  // exit fallback settles the task and destroys stdio streams so no idle timer
  // can re-arm.
  const FALLBACK_PROBE_SCRIPT = `
    import * as runner from "./src/agy.ts";
    const t0 = Date.now();
    const result = await runner.runTask({
      prompt: "fallback probe",
      cwd: process.cwd(),
      timeoutMs: 400,
    });
    const elapsed = Date.now() - t0;
    await new Promise((r) => setTimeout(r, 1200));
    process.stdout.write(JSON.stringify({ result, elapsed }));
    process.exit(0);
  `;
  const fbDir = mkdtempSync(path.join(os.tmpdir(), "agy-fb-"));
  const fbBin = path.join(tmpBase, `fake-agy-${fakeCounter++}`);
  try {
    writeFileSync(
      fbBin,
      [
        "#!/bin/sh",
        "(",
        "  sleep 2.5",
        '  echo "descendant late chatter"',
        ") &",
        `echo "$!" > "${path.join(fbDir, "descendant.pid")}"`,
        `printf '%s\\n' '{"event":"result","result":{"status":"SUCCESS","response":"quick","duration_seconds":0.1}}'`,
        "exit 0",
      ].join("\n") + "\n"
    );
    chmodSync(fbBin, 0o755);

    const fbRes = await execFileP(process.execPath, ["--input-type=module", "-e", FALLBACK_PROBE_SCRIPT], {
      cwd: ROOT,
      env: {
        ...process.env,
        AGY_BIN: fbBin,
        AGY_MCP_STATE_DIR: fbDir,
      },
      timeout: 10_000,
    });
    const fbOut = JSON.parse(fbRes.stdout) as {
      result: { status: string; error?: string };
      elapsed: number;
    };
    if (fbOut.result.status !== "success") {
      throw new Error(`(12b) exit-fallback task failed: ${fbOut.result.status} error: ${fbOut.result.error}`);
    }
    if (fbOut.elapsed < 1800) {
      throw new Error(`(12b) exit-fallback must wait ~2s before settling, took ${fbOut.elapsed}ms`);
    }
  } finally {
    try {
      const pidFile = path.join(fbDir, "descendant.pid");
      if (existsSync(pidFile)) {
        const dPid = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
        if (dPid > 0) process.kill(dPid, "SIGKILL");
      }
    } catch {
      /* process already exited */
    }
    rmSync(fbDir, { recursive: true, force: true });
    try {
      unlinkSync(fbBin);
    } catch {
      /* ignore unlink error */
    }
  }

  // 12c. Cancellation support (X1):
  // notifications/cancelled for the in-flight request kills the child and releases
  // the lock, so a subsequent delegation is accepted rather than rejected.
  const cancelDir = mkdtempSync(path.join(os.tmpdir(), "agy-cancel-"));
  const cancelPidfile = path.join(cancelDir, "pid.txt");
  const cancelAgyBin = path.join(tmpBase, `fake-agy-${fakeCounter++}`);
  writeFileSync(
    cancelAgyBin,
    ["#!/bin/sh", `printf '%s\\n' "$$" > "${cancelPidfile}"`, SLOW_STREAM_BODY].join("\n") + "\n"
  );
  chmodSync(cancelAgyBin, 0o755);

  try {
    await driveMcpStdio(cancelAgyBin, cancelDir, async (io) => {
      io.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: HANDSHAKE("cancel-probe"),
      });
      io.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      await io.waitUntil(() => !!io.responseFor(1), "initialize response");

      // Launch first delegation (id 50)
      io.send({
        jsonrpc: "2.0",
        id: 50,
        method: "tools/call",
        params: { name: "general_task", arguments: { prompt: "task to cancel", cwd: cancelDir } },
      });

      // Wait for task 50 to spawn and start streaming
      await io.waitUntil(
        () => existsSync(cancelPidfile) && readdirSync(cancelDir).some((f) => /^task_.+\.stream$/.test(f)),
        "task 50 start and stream creation"
      );

      io.send({ jsonrpc: "2.0", id: 51, method: "tools/call", params: { name: "watch_task", arguments: {} } });
      await io.waitUntil(() => !!io.responseFor(51), "watch response 51");
      const watch51 = JSON.parse(contentText(io.responseFor(51), 51)) as { running?: boolean };
      if (watch51.running !== true) {
        throw new Error(`(12c) task 50 should be running, got: ${JSON.stringify(watch51)}`);
      }

      // Cancellation for an unknown / unrelated request id is ignored
      io.send({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 99999 },
      });

      // Send cancellation for id 50
      io.send({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 50 },
      });

      // Immediately send second delegation (id 52)
      io.send({
        jsonrpc: "2.0",
        id: 52,
        method: "tools/call",
        params: { name: "general_task", arguments: { prompt: "second task after cancel", cwd: cancelDir } },
      });

      // Wait for response 50: must be answered (not hung) and reflect termination
      await io.waitUntil(() => !!io.responseFor(50), "cancelled task 50 response");
      const resp50 = io.responseFor(50);
      const text50 = contentText(resp50, 50);
      if (!text50.includes("cancelled") && !text50.includes("signal") && resp50?.result?.isError !== true) {
        throw new Error(`(12c) task 50 response should reflect cancellation: ${JSON.stringify(resp50)}`);
      }

      // Prove that task 50 child process was actually terminated
      await assertPidGone(cancelPidfile, "cancelled task 50 child process");

      // Wait for response 52: must succeed (not rejected with "another delegation is already running")
      await io.waitUntil(() => !!io.responseFor(52), "delegation 52 response");
      const resp52 = io.responseFor(52);
      if (resp52?.result?.isError === true) {
        throw new Error(`(12c) task 52 was rejected under lock; cancellation failed: ${JSON.stringify(resp52)}`);
      }
      const text52 = contentText(resp52, 52);
      if (text52.includes("another delegation is already running")) {
        throw new Error(`(12c) task 52 hit single-flight lock rejection: ${text52}`);
      }

      // Cancellation arriving after run finished is harmless
      io.send({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 52 },
      });

      // Ensure no spurious response was answered for notifications/cancelled
      const spurious = io.parsed().find((p) => p.id === undefined && ("result" in p || "error" in p));
      if (spurious) {
        throw new Error(`(12c) notification must receive no response, got: ${JSON.stringify(spurious)}`);
      }
    });
  } finally {
    rmSync(cancelDir, { recursive: true, force: true });
    try {
      unlinkSync(cancelAgyBin);
    } catch {
      /* ignore unlink error */
    }
  }

  // 12d. POSIX -- delimiter in follow CLI (F1):
  // Prompt containing -- reaches the agent verbatim, and options before -- are parsed normally.
  const followDelimDir = mkdtempSync(path.join(os.tmpdir(), "agy-follow-delim-"));
  const quickBin = path.join(tmpBase, `fake-agy-${fakeCounter++}`);
  try {
    writeFileSync(
      quickBin,
      [
        "#!/bin/sh",
        argCap,
        `printf '%s\\n' '{"event":"init","conversation_id":"f-quick","init":{"cwd":"/work","tools":[],"permission_mode":"plan"}}'`,
        `printf '%s\\n' '{"event":"result","result":{"conversation_id":"f-quick","status":"SUCCESS","response":"ok","duration_seconds":0.1}}'`,
      ].join("\n") + "\n"
    );
    chmodSync(quickBin, 0o755);

    const spawnFollowLocal = (
      stateDir: string,
      agyBin: string,
      args: string[]
    ): Promise<{ code: number; stdout: string; stderr: string }> => {
      const argfile = path.join(stateDir, "argv.txt");
      return new Promise((resolve) => {
        const child = spawn(process.execPath, ["dist/follow.js", ...args], {
          cwd: ROOT,
          env: {
            ...process.env,
            AGY_BIN: agyBin,
            AGY_MCP_STATE_DIR: stateDir,
            AGY_FAKE_ARGFILE: argfile,
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdoutText = "";
        let stderrText = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (d: string) => {
          stdoutText += d;
        });
        child.stderr.on("data", (d: string) => {
          stderrText += d;
        });
        const killer = setTimeout(() => child.kill("SIGKILL"), 15_000);
        killer.unref?.();
        child.on("exit", (code) => {
          clearTimeout(killer);
          resolve({ code: code ?? -999, stdout: stdoutText, stderr: stderrText });
        });
      });
    };

    const followDelimRes = await spawnFollowLocal(followDelimDir, quickBin, [
      "--cwd",
      followDelimDir,
      "--",
      "run",
      "tests",
      "--",
      "--watch",
      "prompt-end",
    ]);
    if (followDelimRes.code !== 0) {
      throw new Error(`(12d) follow CLI with -- failed: code ${followDelimRes.code}\nstderr: ${followDelimRes.stderr}`);
    }
    const followArgv = readArgv(path.join(followDelimDir, "argv.txt"));
    const promptIdx = followArgv.indexOf("-p");
    if (promptIdx < 0) {
      throw new Error(`(12d) fake agy argv missing -p: ${followArgv.join(" ")}`);
    }
    const passedPrompt = followArgv[promptIdx + 1];
    const wantPrompt = "run tests -- --watch prompt-end";
    if (passedPrompt !== wantPrompt) {
      throw new Error(
        `(12d) prompt with -- delimiter mismatch: got ${JSON.stringify(passedPrompt)}, want ${JSON.stringify(wantPrompt)}`
      );
    }

    // Also verify that an unknown option before -- is rejected with exit 2
    const badOptRes = await spawnFollowLocal(followDelimDir, quickBin, ["--unknown-opt", "value", "--", "prompt"]);
    if (badOptRes.code !== 2) {
      throw new Error(`(12d) follow CLI must reject unknown option before -- with exit 2, got ${badOptRes.code}`);
    }
    if (!badOptRes.stderr.includes("unknown option: --unknown-opt")) {
      throw new Error(`(12d) follow CLI stderr must report unknown option: ${badOptRes.stderr}`);
    }

    // 12e. Model and effort are two separate knobs: a bare model id plus
    // --effort reaches agy verbatim, and a model id that already carries a
    // tier must not repeat a different effort (refused locally, before any
    // spawn).
    const modelEffortRes = await spawnFollowLocal(followDelimDir, quickBin, [
      "--model",
      "gemini-3.8-flash",
      "--effort",
      "high",
      "--cwd",
      followDelimDir,
      "prompt",
    ]);
    if (modelEffortRes.code !== 0) {
      throw new Error(
        `(12e) follow CLI with --model/--effort failed: code ${modelEffortRes.code}\nstderr: ${modelEffortRes.stderr}`
      );
    }
    const modelEffortArgv = readArgv(path.join(followDelimDir, "argv.txt"));
    const modelIdx = modelEffortArgv.indexOf("--model");
    const effortIdx = modelEffortArgv.indexOf("--effort");
    if (modelIdx < 0 || modelEffortArgv[modelIdx + 1] !== "gemini-3.8-flash") {
      throw new Error(`(12e) fake agy argv missing --model gemini-3.8-flash: ${modelEffortArgv.join(" ")}`);
    }
    if (effortIdx < 0 || modelEffortArgv[effortIdx + 1] !== "high") {
      throw new Error(`(12e) fake agy argv missing --effort high: ${modelEffortArgv.join(" ")}`);
    }

    const tierConflictRes = await spawnFollowLocal(followDelimDir, quickBin, [
      "--model",
      "gemini-3.8-flash-high",
      "--effort",
      "low",
      "--cwd",
      followDelimDir,
      "prompt",
    ]);
    if (tierConflictRes.code !== 2) {
      throw new Error(
        `(12e) follow CLI must reject a tier-carrying model with a different --effort, got exit ${tierConflictRes.code}`
      );
    }
    if (!tierConflictRes.stderr.includes("conflicts with --effort")) {
      throw new Error(`(12e) follow CLI stderr must explain the tier conflict: ${tierConflictRes.stderr}`);
    }
  } finally {
    rmSync(followDelimDir, { recursive: true, force: true });
    try {
      unlinkSync(quickBin);
    } catch {
      /* ignore unlink error */
    }
  }

  console.log(
    "verified audit fixes: hash-based touch detection, exit-fallback hygiene, cancellation lock release, -- CLI delimiter: ok"
  );
}

// ---------------------------------------------------------------------------
// 13. Handle-and-watch workflow (background delegation, polling, and cancellation)
// ---------------------------------------------------------------------------
{
  const slowAgy = writeSlowAgy();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "agy-watch-workflow-"));
  const { exitCode } = await driveMcpStdio(slowAgy, stateDir, async (io) => {
    io.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: HANDSHAKE("handle-and-watch-probe"),
    });
    io.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await io.waitUntil(() => !!io.responseFor(1), "initialize response (id 1)");

    // 1. A backgrounded delegation returns in well under a second with status "running" and a task id.
    const t0 = Date.now();
    io.send({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "general_task",
        arguments: { prompt: "detached delegation task", cwd: stateDir, background: true },
      },
    });
    await io.waitUntil(() => !!io.responseFor(10), "background delegation response (id 10)");
    const elapsed = Date.now() - t0;
    if (elapsed >= 1000) {
      throw new Error(`backgrounded delegation must return in well under a second, took ${elapsed}ms`);
    }
    const bgReceipt = JSON.parse(contentText(io.responseFor(10), 10)) as {
      task_id?: string;
      status?: string;
      stream_file?: string;
      transcript_file?: string;
      started?: boolean;
      note?: string;
    };
    if (
      bgReceipt.status !== "running" ||
      typeof bgReceipt.task_id !== "string" ||
      !bgReceipt.task_id.startsWith("task_")
    ) {
      throw new Error(`background receipt must have status "running" and a task_id: ${JSON.stringify(bgReceipt)}`);
    }
    if (bgReceipt.started !== true) {
      throw new Error(`background receipt must report started: true: ${JSON.stringify(bgReceipt)}`);
    }
    if (typeof bgReceipt.stream_file !== "string" || typeof bgReceipt.transcript_file !== "string") {
      throw new Error(`background receipt must include stream_file and transcript_file: ${JSON.stringify(bgReceipt)}`);
    }

    // 2. A second delegation is rejected while the detached run holds the single-flight lock.
    io.send({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: {
        name: "explore_task",
        arguments: { prompt: "second task while detached is in flight", cwd: stateDir },
      },
    });
    await io.waitUntil(() => !!io.responseFor(11), "rejection response (id 11)");
    const busy = io.responseFor(11);
    if (busy?.result?.isError !== true) {
      throw new Error(`second delegation must be rejected while detached run is in flight: ${JSON.stringify(busy)}`);
    }
    const rejMsg = contentText(busy, 11);
    if (!rejMsg.includes("another delegation is already running") || !rejMsg.includes(bgReceipt.task_id)) {
      throw new Error(`rejection message must name the in-flight task id (${bgReceipt.task_id}): ${rejMsg}`);
    }

    // 3. Polling watch_task on it shows running true and content that grows between two polls.
    io.send({
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: { name: "watch_task", arguments: { stream_file: bgReceipt.task_id } },
    });
    await io.waitUntil(() => !!io.responseFor(12), "watch poll 1 (id 12)");
    const poll1 = JSON.parse(contentText(io.responseFor(12), 12)) as {
      found?: boolean;
      running?: boolean;
      finished?: boolean;
      content?: string;
    };
    if (poll1.found !== true || poll1.running !== true || poll1.finished !== false) {
      throw new Error(`watch poll 1 must show running true and finished false: ${JSON.stringify(poll1)}`);
    }
    const content1 = poll1.content ?? "";

    // Wait for the slow fake agy to emit its next step (sleep 0.5s in SLOW_STREAM_BODY)
    await sleep(650);

    io.send({
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: { name: "watch_task", arguments: { stream_file: bgReceipt.task_id } },
    });
    await io.waitUntil(() => !!io.responseFor(13), "watch poll 2 (id 13)");
    const poll2 = JSON.parse(contentText(io.responseFor(13), 13)) as {
      content?: string;
    };
    const content2 = poll2.content ?? "";
    if (content2.length <= content1.length) {
      throw new Error(
        `transcript content must grow between two polls: poll1=${content1.length} chars, poll2=${content2.length} chars`
      );
    }

    // 4. Once the task finishes, watch_task includes the final result with status success and response text.
    let finishedReport:
      | {
          running?: boolean;
          finished?: boolean;
          result_ready?: boolean;
          status?: string;
          response?: string;
          duration_seconds?: number;
        }
      | undefined;
    let pollId = 20;
    const pollDeadline = Date.now() + 20_000;
    while (!finishedReport && Date.now() < pollDeadline) {
      const pid = pollId++;
      io.send({
        jsonrpc: "2.0",
        id: pid,
        method: "tools/call",
        params: { name: "watch_task", arguments: { stream_file: bgReceipt.task_id } },
      });
      await io.waitUntil(() => !!io.responseFor(pid), `poll id ${pid}`);
      const r = JSON.parse(contentText(io.responseFor(pid), pid)) as {
        running?: boolean;
        finished?: boolean;
        result_ready?: boolean;
        status?: string;
        response?: string;
      };
      // result_ready (the durable receipt carries the final result) is the
      // authoritative completion signal - the stream's "== done:" line lands
      // slightly earlier, before the server finishes the file-scope audit.
      if (r.running === false && r.result_ready === true) {
        finishedReport = r;
        break;
      }
      await sleep(200);
    }

    if (finishedReport?.status !== "success") {
      throw new Error(`finished watch report must include status "success", got: ${JSON.stringify(finishedReport)}`);
    }
    if (typeof finishedReport.response !== "string" || !finishedReport.response.includes("working on it hard")) {
      throw new Error(`finished watch report must include response text: ${JSON.stringify(finishedReport)}`);
    }
    if (typeof finishedReport.duration_seconds !== "number" || finishedReport.duration_seconds <= 0) {
      throw new Error(`finished watch report must include duration_seconds: ${JSON.stringify(finishedReport)}`);
    }

    // 5. watch_task with cancel true stops a running detached task and the last report shows it stopped.
    io.send({
      jsonrpc: "2.0",
      id: 30,
      method: "tools/call",
      params: {
        name: "general_task",
        arguments: { prompt: "detached task to cancel", cwd: stateDir, background: true },
      },
    });
    await io.waitUntil(() => !!io.responseFor(30), "background delegation response for cancel (id 30)");
    const bgCancelReceipt = JSON.parse(contentText(io.responseFor(30), 30)) as { task_id?: string; status?: string };
    if (bgCancelReceipt.status !== "running" || typeof bgCancelReceipt.task_id !== "string") {
      throw new Error(`task to cancel must start running: ${JSON.stringify(bgCancelReceipt)}`);
    }

    io.send({
      jsonrpc: "2.0",
      id: 31,
      method: "tools/call",
      params: {
        name: "watch_task",
        arguments: { stream_file: bgCancelReceipt.task_id, cancel: true },
      },
    });
    await io.waitUntil(() => !!io.responseFor(31), "watch cancel response (id 31)");
    const cancelReport = JSON.parse(contentText(io.responseFor(31), 31)) as {
      running?: boolean;
      finished?: boolean;
      status?: string;
      content?: string;
    };
    if (cancelReport.running !== false || cancelReport.finished !== true) {
      throw new Error(
        `cancelled watch report must show stopped (running: false, finished: true): ${JSON.stringify(cancelReport)}`
      );
    }
    if (cancelReport.status !== "error") {
      throw new Error(`cancelled watch report status must be "error", got: ${JSON.stringify(cancelReport)}`);
    }
    if (!cancelReport.content?.includes("CANCELLED")) {
      throw new Error(
        `cancelled watch report content must reflect cancellation marker: ${JSON.stringify(cancelReport)}`
      );
    }

    // Verify lock release: a new delegation immediately succeeds (not rejected under lock)
    io.send({
      jsonrpc: "2.0",
      id: 32,
      method: "tools/call",
      params: {
        name: "general_task",
        arguments: { prompt: "run after cancel", cwd: stateDir, background: true },
      },
    });
    await io.waitUntil(() => !!io.responseFor(32), "delegation after cancel response (id 32)");
    const afterCancel = io.responseFor(32);
    if (afterCancel?.result?.isError === true) {
      throw new Error(`delegation after cancel was rejected under lock: ${JSON.stringify(afterCancel)}`);
    }
  });

  if (exitCode !== 0) {
    throw new Error(`handle-and-watch suite must exit 0, got ${exitCode}`);
  }

  console.log(
    "handle-and-watch: background delegation returns running handle <1s, watch_task content grows, final result enriched on finish, lock held while running, cancel stops detached run: ok"
  );
}

// ---------------------------------------------------------------------------
// 14. watch_task digest: the compact step feed parsed out of the transcript
// ---------------------------------------------------------------------------
{
  const digestRun = await fakeRun(streamBody, { prompt: "digest probe", cwd: ws });
  const digestStream = path.join(digestRun.stateDir, `${digestRun.result.task_id}.stream`);
  const report = runner.readStreamTail(digestStream);

  const steps = report.steps ?? [];
  if (!Array.isArray(steps) || steps.length !== 6) {
    throw new Error(`digest must expose one step per completed event, got ${JSON.stringify(steps)}`);
  }
  if (report.step_count !== steps.length) {
    throw new Error(`step_count must match the step list: ${report.step_count} vs ${steps.length}`);
  }

  const first = steps[0];
  if (first?.kind !== "phase" || first.label !== "agent_response" || first.dur_seconds !== 4.07) {
    throw new Error(`digest step 0 must be the agent_response phase with its duration: ${JSON.stringify(first)}`);
  }
  if (first.total_tokens !== 8093 || first.thinking_tokens !== 38) {
    throw new Error(`digest step 0 must carry the step token usage: ${JSON.stringify(first)}`);
  }

  const writeStep = steps[1];
  if (
    writeStep?.kind !== "write" ||
    writeStep.label !== "Write" ||
    writeStep.target !== "/tmp/opencode/agy-tmux-test/probe.txt" ||
    writeStep.dur_seconds !== 1.816
  ) {
    throw new Error(`digest step 1 must be the write step with target and duration: ${JSON.stringify(writeStep)}`);
  }

  const readStep = steps[2];
  if (
    readStep?.kind !== "read" ||
    readStep.label !== "Read" ||
    readStep.target !== "/tmp/opencode/agy-tmux-test/probe.txt" ||
    readStep.dur_seconds !== 0.027 ||
    readStep.output !== "1 lines, 6 bytes"
  ) {
    throw new Error(`digest step 2 must be the read step with output excerpt: ${JSON.stringify(readStep)}`);
  }

  const runStep = steps[4];
  if (runStep?.kind !== "run" || runStep.target !== "git status" || runStep.dur_seconds !== 1.1) {
    throw new Error(`digest step 4 must be the run step with its command: ${JSON.stringify(runStep)}`);
  }

  if (report.phase !== "Web") {
    throw new Error(`digest phase must be the last phase marker: ${report.phase}`);
  }
  if (report.elapsed_seconds !== 6.55) {
    throw new Error(`digest elapsed_seconds must come from the done marker: ${report.elapsed_seconds}`);
  }
  if (report.usage_latest?.total_tokens !== 8007 || report.usage_latest?.thinking_tokens !== 9) {
    throw new Error(`digest usage_latest must be the newest step usage: ${JSON.stringify(report.usage_latest)}`);
  }
  if (typeof report.content !== "string" || !report.content.includes("== done:")) {
    throw new Error("the raw transcript tail must stay available next to the digest");
  }
  console.log(
    "watch digest: 6 structured steps (phase/write/read/run) with targets, durations and token usage, phase + elapsed + usage_latest, raw tail retained: ok"
  );
}

// ---------------------------------------------------------------------------
// 15. Effort & model resolution in the MCP layer (real argv over stdio)
// ---------------------------------------------------------------------------
{
  // One fake invocation per delegation: an "invoke" marker line followed by
  // the argv the server actually spawned.
  const EFFORT_BODY = [
    `printf '%s\\n' "invoke" >> "$AGY_FAKE_ARGFILE"`,
    `printf '%s\\n' "$@" >> "$AGY_FAKE_ARGFILE"`,
    `printf '%s\\n' '{"event":"init","conversation_id":"effort-c1","init":{"cwd":"/work/effort","tools":[],"permission_mode":"accept-edits"}}'`,
    `printf '%s\\n' '{"event":"result","result":{"conversation_id":"effort-c1","status":"SUCCESS","response":"effort probe ok","duration_seconds":0.2,"num_turns":1}}'`,
  ].join("\n");
  const effortBin = path.join(tmpBase, `fake-agy-${fakeCounter++}`);
  writeFileSync(effortBin, `#!/bin/sh\n${EFFORT_BODY}\n`);
  chmodSync(effortBin, 0o755);
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "agy-effort-"));

  /** The fake's argv log, split into one argv array per real invocation. */
  const invocations = (): string[][] => {
    const argfile = path.join(stateDir, "argv.txt");
    if (!existsSync(argfile)) return [];
    const out: string[][] = [];
    let current: string[] | null = null;
    for (const line of readFileSync(argfile, "utf8").split("\n").filter(Boolean)) {
      if (line === "invoke") {
        current = [];
        out.push(current);
        continue;
      }
      current?.push(line);
    }
    return out;
  };

  const flagValue = (argv: string[], flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i < 0 ? undefined : argv[i + 1];
  };

  type EffortBody = { status?: string; error?: string; [k: string]: unknown };

  let nextId = 200;
  const { exitCode } = await driveMcpStdio(effortBin, stateDir, async (io) => {
    io.send({ jsonrpc: "2.0", id: 199, method: "initialize", params: HANDSHAKE("effort-probe") });
    io.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await io.waitUntil(() => !!io.responseFor(199), "initialize response (id 199)");

    /** One delegation call; returns the wire envelope plus its parsed body. */
    const call = async (name: string, args: Record<string, unknown>) => {
      nextId += 1;
      const id = nextId;
      io.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
      await io.waitUntil(() => !!io.responseFor(id), `response (id ${id})`);
      const resp = io.responseFor(id);
      return {
        id,
        isError: resp?.result?.isError === true,
        body: JSON.parse(contentText(resp, id)) as EffortBody,
      };
    };

    // (a) general_task without model/effort: the documented default effort
    //     (medium) must reach the CLI as --effort medium.
    const a = await call("general_task", { prompt: "default effort probe", cwd: stateDir });
    if (a.isError || a.body.status !== "success") {
      throw new Error(`(15a) general_task without effort must succeed: ${JSON.stringify(a.body)}`);
    }
    const argvA = invocations()[0] ?? [];
    if (flagValue(argvA, "--effort") !== "medium") {
      throw new Error(`(15a) general_task must pass --effort medium, argv: ${argvA.join(" ")}`);
    }
    if (flagValue(argvA, "--mode") !== "accept-edits") {
      throw new Error(`(15a) general_task must keep its mode preset, argv: ${argvA.join(" ")}`);
    }

    // (b) explore_task without model/effort: its preset is low.
    const b = await call("explore_task", { prompt: "default effort probe", cwd: stateDir });
    if (b.isError || b.body.status !== "success") {
      throw new Error(`(15b) explore_task without effort must succeed: ${JSON.stringify(b.body)}`);
    }
    const argvB = invocations()[1] ?? [];
    if (flagValue(argvB, "--effort") !== "low") {
      throw new Error(`(15b) explore_task must pass --effort low, argv: ${argvB.join(" ")}`);
    }
    if (flagValue(argvB, "--mode") !== "plan") {
      throw new Error(`(15b) explore_task must keep its mode preset, argv: ${argvB.join(" ")}`);
    }

    // (c) A tier-carrying model id wins over the default effort: no --effort
    //     flag at all (the id already encodes the tier).
    const c = await call("general_task", {
      prompt: "tiered model probe",
      cwd: stateDir,
      model: "gemini-3.8-flash-high",
    });
    if (c.isError || c.body.status !== "success") {
      throw new Error(`(15c) a tier-carrying model id must run fine: ${JSON.stringify(c.body)}`);
    }
    const argvC = invocations()[2] ?? [];
    if (argvC.includes("--effort")) {
      throw new Error(`(15c) a tier-carrying model id must not get --effort, argv: ${argvC.join(" ")}`);
    }
    if (flagValue(argvC, "--model") !== "gemini-3.8-flash-high") {
      throw new Error(`(15c) the model id must reach agy verbatim, argv: ${argvC.join(" ")}`);
    }

    // (d) Same tier-carrying model + the MATCHING effort: still no --effort
    //     (the id already says "high"), and the run succeeds.
    const d = await call("general_task", {
      prompt: "tiered model probe",
      cwd: stateDir,
      model: "gemini-3.8-flash-high",
      effort: "high",
    });
    if (d.isError || d.body.status !== "success") {
      throw new Error(`(15d) a matching effort on a tier-carrying id must succeed: ${JSON.stringify(d.body)}`);
    }
    const argvD = invocations()[3] ?? [];
    if (argvD.includes("--effort")) {
      throw new Error(`(15d) a matching effort must not add --effort, argv: ${argvD.join(" ")}`);
    }

    // (e) Tier-carrying model + a DIFFERENT effort: refused locally - the
    //     error envelope, and NOTHING is spawned.
    const beforeE = invocations().length;
    const e = await call("general_task", {
      prompt: "conflicting effort probe",
      cwd: stateDir,
      model: "gemini-3.8-flash-high",
      effort: "low",
    });
    if (e.isError !== true) {
      throw new Error(`(15e) a conflicting effort must be an isError result: ${JSON.stringify(e.body)}`);
    }
    if (Object.keys(e.body).join(",") !== "error") {
      throw new Error(`(15e) the local error must use the {"error": ...} envelope: ${JSON.stringify(e.body)}`);
    }
    const eMsg = e.body.error ?? "";
    if (
      !eMsg.includes("gemini-3.8-flash-high") ||
      !eMsg.includes("high") ||
      !eMsg.includes("low") ||
      !/conflict/i.test(eMsg)
    ) {
      throw new Error(`(15e) the conflict message must name the model, both tiers and the clash: ${eMsg}`);
    }
    if (invocations().length !== beforeE) {
      throw new Error(`(15e) a conflicting effort must spawn nothing, argv log grew to ${invocations().length}`);
    }

    // (f) An effort level no model supports (xhigh): refused locally.
    const beforeF = invocations().length;
    const f = await call("general_task", { prompt: "xhigh probe", cwd: stateDir, effort: "xhigh" });
    if (f.isError !== true) {
      throw new Error(`(15f) effort "xhigh" must be an isError result: ${JSON.stringify(f.body)}`);
    }
    if (Object.keys(f.body).join(",") !== "error") {
      throw new Error(`(15f) the local error must use the {"error": ...} envelope: ${JSON.stringify(f.body)}`);
    }
    if (!(f.body.error ?? "").includes("xhigh")) {
      throw new Error(`(15f) the error must name the rejected effort: ${f.body.error ?? ""}`);
    }
    if (invocations().length !== beforeF) {
      throw new Error(`(15f) effort "xhigh" must spawn nothing, argv log grew to ${invocations().length}`);
    }

    // (g) An effort outside the schema enum (banana): refused locally.
    const beforeG = invocations().length;
    const g = await call("general_task", { prompt: "banana probe", cwd: stateDir, effort: "banana" });
    if (g.isError !== true) {
      throw new Error(`(15g) effort "banana" must be an isError result: ${JSON.stringify(g.body)}`);
    }
    if (Object.keys(g.body).join(",") !== "error") {
      throw new Error(`(15g) the local error must use the {"error": ...} envelope: ${JSON.stringify(g.body)}`);
    }
    if (!(g.body.error ?? "").includes("banana")) {
      throw new Error(`(15g) the error must name the rejected effort: ${g.body.error ?? ""}`);
    }
    if (invocations().length !== beforeG) {
      throw new Error(`(15g) effort "banana" must spawn nothing, argv log grew to ${invocations().length}`);
    }

    // (h) A bare model id takes the caller's effort (both flags reach agy).
    const h = await call("general_task", {
      prompt: "bare model probe",
      cwd: stateDir,
      model: "gemini-3.8-flash",
      effort: "high",
    });
    if (h.isError || h.body.status !== "success") {
      throw new Error(`(15h) a bare model id plus an effort must succeed: ${JSON.stringify(h.body)}`);
    }
    const argvH = invocations()[invocations().length - 1] ?? [];
    if (flagValue(argvH, "--model") !== "gemini-3.8-flash" || flagValue(argvH, "--effort") !== "high") {
      throw new Error(`(15h) a bare model id must keep both --model and --effort, argv: ${argvH.join(" ")}`);
    }

    // (i) The lock is released after a local validation failure: the very
    //     next delegation is accepted and runs.
    const i = await call("general_task", { prompt: "after rejection probe", cwd: stateDir });
    if (i.isError || i.body.status !== "success") {
      throw new Error(`(15i) a delegation after a validation failure must succeed: ${JSON.stringify(i.body)}`);
    }
    const argvI = invocations()[invocations().length - 1] ?? [];
    if (flagValue(argvI, "--effort") !== "medium") {
      throw new Error(`(15i) the default effort must still apply afterwards, argv: ${argvI.join(" ")}`);
    }

    // (j) The agy CLI resolves model ids CASE-INSENSITIVELY, so tier
    //     detection must be too: a case-variant tier id + a conflicting
    //     effort is refused locally (nothing spawned) ...
    const caseVariants = ["GEMINI-3.8-FLASH-HIGH", "gemini-3.8-flash-HIGH", "Gemini-3.8-Flash-High"];
    for (const model of caseVariants) {
      const before = invocations().length;
      const r = await call("general_task", {
        prompt: "case-variant tier probe",
        cwd: stateDir,
        model,
        effort: "medium",
      });
      if (r.isError !== true) {
        throw new Error(`(15j) a case-variant tier id + a conflicting effort must be refused: ${model}`);
      }
      if (Object.keys(r.body).join(",") !== "error") {
        throw new Error(`(15j) the local error must use the {"error": ...} envelope: ${JSON.stringify(r.body)}`);
      }
      const msg = r.body.error ?? "";
      if (!msg.includes(model) || !msg.includes("high") || !/conflict/i.test(msg)) {
        throw new Error(`(15j) the conflict message must name the model and its tier: ${msg}`);
      }
      if (invocations().length !== before) {
        throw new Error(`(15j) a case-variant tier conflict must spawn nothing: ${model}`);
      }
    }

    // ... and a case-variant tier id with the MATCHING effort is not a
    //     conflict: the id wins and no --effort is passed for it.
    const j = await call("general_task", {
      prompt: "case-variant tier probe",
      cwd: stateDir,
      model: "gemini-3.8-flash-HIGH",
      effort: "high",
    });
    if (j.isError || j.body.status !== "success") {
      throw new Error(`(15j) a case-variant tier id + the matching effort must succeed: ${JSON.stringify(j.body)}`);
    }
    const argvJ = invocations()[invocations().length - 1] ?? [];
    if (argvJ.includes("--effort")) {
      throw new Error(`(15j) a case-variant tier id must not get --effort, argv: ${argvJ.join(" ")}`);
    }

    // (k) A case-variant tier id with NO effort: it carries its tier, so it
    //     runs fine and still gets no --effort.
    const k = await call("general_task", {
      prompt: "case-variant tier probe",
      cwd: stateDir,
      model: "GEMINI-3.8-FLASH-HIGH",
    });
    if (k.isError || k.body.status !== "success") {
      throw new Error(`(15k) a case-variant tier id without an effort must succeed: ${JSON.stringify(k.body)}`);
    }
    const argvK = invocations()[invocations().length - 1] ?? [];
    if (argvK.includes("--effort")) {
      throw new Error(`(15k) a case-variant tier id must not get --effort, argv: ${argvK.join(" ")}`);
    }
    if (flagValue(argvK, "--model") !== "GEMINI-3.8-FLASH-HIGH") {
      throw new Error(`(15k) the model id must reach agy verbatim, argv: ${argvK.join(" ")}`);
    }
  });
  if (exitCode !== 0) {
    throw new Error(`effort/model suite must exit 0, got ${exitCode}`);
  }

  console.log(
    "effort & model resolution: general_task --effort medium, explore_task --effort low, tier-carrying id suppresses --effort, conflicting/unsupported/off-enum efforts refused locally with 0 invocations, case-variant tier ids detected: ok"
  );
}

// ---------------------------------------------------------------------------
// 16. Failure surfacing in the MCP layer: isError + the CLI's own error message
// ---------------------------------------------------------------------------
{
  /** A fake whose CLI reports a failure with a machine-readable error, then exits 3. */
  const FAIL_BODY = [
    `printf '%s\\n' '{"event":"init","conversation_id":"fail-c1","init":{"cwd":"/work/fail","tools":[],"permission_mode":"accept-edits"}}'`,
    `printf '%s\\n' '{"event":"result","result":{"conversation_id":"fail-c1","status":"ERROR","response":"","error":"boom: something went wrong","duration_seconds":0.3,"num_turns":1}}'`,
    `echo "fake agy stderr noise" >&2`,
    "exit 3",
  ].join("\n");
  /** The same fake, but the run succeeds. */
  const OK_BODY = [
    `printf '%s\\n' '{"event":"init","conversation_id":"ok-c1","init":{"cwd":"/work/ok","tools":[],"permission_mode":"accept-edits"}}'`,
    `printf '%s\\n' '{"event":"result","result":{"conversation_id":"ok-c1","status":"SUCCESS","response":"all good","duration_seconds":0.3,"num_turns":1}}'`,
  ].join("\n");
  /** A result event with NO status field at all; the process exits 0. */
  const NO_STATUS_BODY = [
    `printf '%s\\n' '{"event":"init","conversation_id":"nostatus-c1","init":{"cwd":"/work/nostatus","tools":[],"permission_mode":"accept-edits"}}'`,
    `printf '%s\\n' '{"event":"result","result":{"conversation_id":"nostatus-c1","response":"","duration_seconds":0.3,"num_turns":1}}'`,
    "exit 0",
  ].join("\n");
  /** No result event at all; the process exits 0. */
  const NO_RESULT_BODY = [`echo "fake agy produced nothing" >&2`, "exit 0"].join("\n");
  const writeFake = (body: string): string => {
    const bin = path.join(tmpBase, `fake-agy-${fakeCounter++}`);
    writeFileSync(bin, `#!/bin/sh\n${body}\n`);
    chmodSync(bin, 0o755);
    return bin;
  };

  /** One general_task over stdio; returns the wire envelope plus its parsed body. */
  const delegate = async (bin: string, stateDir: string, id: number) => {
    const captured: { isError: boolean; body: Record<string, unknown> } = { isError: false, body: {} };
    const { exitCode } = await driveMcpStdio(bin, stateDir, async (io) => {
      io.send({ jsonrpc: "2.0", id: id - 1, method: "initialize", params: HANDSHAKE("fail-probe") });
      io.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      await io.waitUntil(() => !!io.responseFor(id - 1), `initialize response (id ${id - 1})`);
      io.send({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "general_task", arguments: { prompt: "failure surfacing probe", cwd: stateDir } },
      });
      await io.waitUntil(() => !!io.responseFor(id), `tools/call response (id ${id})`);
      const resp = io.responseFor(id);
      captured.isError = resp?.result?.isError === true;
      captured.body = JSON.parse(contentText(resp, id)) as Record<string, unknown>;
    });
    if (exitCode !== 0) {
      throw new Error(`failure-surfacing suite must exit 0, got ${exitCode}`);
    }
    return captured;
  };

  // (a) A failed delegation: the tool envelope is flagged AND the CLI's own
  //     error message reaches the caller (not just the exit code).
  const failStateDir = mkdtempSync(path.join(os.tmpdir(), "agy-failsurf-"));
  const failed = await delegate(writeFake(FAIL_BODY), failStateDir, 302);
  if (failed.isError !== true) {
    throw new Error(`(16a) a failed delegation must be flagged isError: ${JSON.stringify(failed.body)}`);
  }
  if (failed.body.status !== "error") {
    throw new Error(`(16a) a failed delegation must report status=error: ${JSON.stringify(failed.body)}`);
  }
  if (failed.body.error !== "boom: something went wrong") {
    throw new Error(`(16a) the CLI's error message must be surfaced verbatim: ${JSON.stringify(failed.body.error)}`);
  }
  if (failed.body.exit_code !== 3) {
    throw new Error(`(16a) the exit code must stay in exit_code: ${JSON.stringify(failed.body)}`);
  }
  if (!String(failed.body.notes ?? "").includes("fake agy stderr noise")) {
    throw new Error(`(16a) the stderr noise must stay in notes: ${JSON.stringify(failed.body.notes)}`);
  }

  // (b) A successful delegation is NOT flagged as an error.
  const okStateDir = mkdtempSync(path.join(os.tmpdir(), "agy-failsurf-ok-"));
  const ok = await delegate(writeFake(OK_BODY), okStateDir, 304);
  if (ok.isError !== false) {
    throw new Error(`(16b) a successful delegation must not be flagged isError: ${JSON.stringify(ok.body)}`);
  }
  if (ok.body.status !== "success") {
    throw new Error(`(16b) a successful delegation must report status=success: ${JSON.stringify(ok.body)}`);
  }
  if (ok.body.error !== undefined) {
    throw new Error(`(16b) a successful delegation must not carry an error: ${JSON.stringify(ok.body)}`);
  }

  // (c) A result event with NO status field, process exit 0: the run failed, so
  //     the error must not read like a clean exit ("code 0").
  const noStatusStateDir = mkdtempSync(path.join(os.tmpdir(), "agy-failsurf-nostatus-"));
  const noStatus = await delegate(writeFake(NO_STATUS_BODY), noStatusStateDir, 306);
  if (noStatus.isError !== true) {
    throw new Error(`(16c) a status-less failed delegation must be flagged isError: ${JSON.stringify(noStatus.body)}`);
  }
  if (noStatus.body.status !== "error") {
    throw new Error(`(16c) a status-less failed delegation must report status=error: ${JSON.stringify(noStatus.body)}`);
  }
  const noStatusErr = String(noStatus.body.error ?? "");
  if (noStatusErr.length === 0 || /code 0/.test(noStatusErr)) {
    throw new Error(`(16c) a failed run must never be described as a clean exit: ${JSON.stringify(noStatusErr)}`);
  }
  if (!/status/i.test(noStatusErr)) {
    throw new Error(`(16c) the error must name the missing result status: ${JSON.stringify(noStatusErr)}`);
  }

  // (d) No result event at all, process exit 0: same rule, and the missing
  //     JSON result line stays named.
  const noResultStateDir = mkdtempSync(path.join(os.tmpdir(), "agy-failsurf-noresult-"));
  const noResult = await delegate(writeFake(NO_RESULT_BODY), noResultStateDir, 308);
  if (noResult.isError !== true) {
    throw new Error(`(16d) a result-less failed delegation must be flagged isError: ${JSON.stringify(noResult.body)}`);
  }
  if (noResult.body.status !== "error") {
    throw new Error(`(16d) a result-less failed delegation must report status=error: ${JSON.stringify(noResult.body)}`);
  }
  const noResultErr = String(noResult.body.error ?? "");
  if (noResultErr.length === 0 || /code 0/.test(noResultErr)) {
    throw new Error(`(16d) a failed run must never be described as a clean exit: ${JSON.stringify(noResultErr)}`);
  }
  if (!noResultErr.includes("no JSON result line in output")) {
    throw new Error(`(16d) the error must name the missing JSON result line: ${JSON.stringify(noResultErr)}`);
  }
  if (!String(noResult.body.notes ?? "").includes("fake agy produced nothing")) {
    throw new Error(`(16d) the stderr noise must stay in notes: ${JSON.stringify(noResult.body.notes)}`);
  }

  console.log(
    "failure surfacing: a failed delegation is flagged isError and carries the CLI's own error message (exit_code separate), a successful one stays isError=false, and a run that failed despite exit 0 is never described as a clean exit: ok"
  );
}

// ---------------------------------------------------------------------------
// 17. Input validation: the advertised schema is enforced before anything runs
// ---------------------------------------------------------------------------
{
  // One fake invocation per delegation: an "invoke" marker line followed by
  // the argv the server actually spawned.
  const VALIDATE_BODY = [
    `printf '%s\\n' "invoke" >> "$AGY_FAKE_ARGFILE"`,
    `printf '%s\\n' "$@" >> "$AGY_FAKE_ARGFILE"`,
    `printf '%s\\n' '{"event":"init","conversation_id":"validate-c1","init":{"cwd":"/work/validate","tools":[],"permission_mode":"accept-edits"}}'`,
    `printf '%s\\n' '{"event":"result","result":{"conversation_id":"validate-c1","status":"SUCCESS","response":"validated","duration_seconds":0.2,"num_turns":1}}'`,
  ].join("\n");
  const validateBin = path.join(tmpBase, `fake-agy-${fakeCounter++}`);
  writeFileSync(validateBin, `#!/bin/sh\n${VALIDATE_BODY}\n`);
  chmodSync(validateBin, 0o755);
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "agy-validate-"));
  const argfile = path.join(stateDir, "argv.txt");

  /** How many times the fake agy was really spawned. */
  const invocations = (): number =>
    existsSync(argfile)
      ? readFileSync(argfile, "utf8")
          .split("\n")
          .filter((l) => l === "invoke").length
      : 0;

  let nextId = 300;
  const { exitCode } = await driveMcpStdio(validateBin, stateDir, async (io) => {
    io.send({ jsonrpc: "2.0", id: 299, method: "initialize", params: HANDSHAKE("validate-probe") });
    io.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await io.waitUntil(() => !!io.responseFor(299), "initialize response (id 299)");

    /** One tool call over stdio; returns the wire envelope plus its body. */
    const call = async (name: string, args: Record<string, unknown>, meta?: unknown) => {
      nextId += 1;
      const id = nextId;
      io.send({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) },
      });
      await io.waitUntil(() => !!io.responseFor(id), `response (id ${id})`);
      const resp = io.responseFor(id);
      return {
        isError: resp?.result?.isError === true,
        body: JSON.parse(contentText(resp, id)) as Record<string, unknown>,
      };
    };

    /**
     * A call that must be refused locally: the house {"error": ...} envelope
     * (isError true, one key) naming the offending argument, no spawn, and no
     * raw TypeError in the message.
     */
    const expectRefused = async (label: string, name: string, args: Record<string, unknown>, offending: string) => {
      const before = invocations();
      // A progress token on the refused call: it must not produce a single
      // notifications/progress frame.
      const r = await call(name, args, { progressToken: `tok-${label}` });
      if (r.isError !== true) {
        throw new Error(`(17) ${label}: the call must be refused, got ${JSON.stringify(r.body)}`);
      }
      if (Object.keys(r.body).join(",") !== "error") {
        throw new Error(
          `(17) ${label}: the refusal must use the {"error": ...} envelope, got ${JSON.stringify(r.body)}`
        );
      }
      const msg = String(r.body.error ?? "");
      if (!msg.includes(offending)) {
        throw new Error(`(17) ${label}: the message must name "${offending}", got ${msg}`);
      }
      if (/Cannot read propert|undefined is not|reading '/.test(msg)) {
        throw new Error(`(17) ${label}: a raw TypeError must not escape, got ${msg}`);
      }
      if (invocations() !== before) {
        throw new Error(`(17) ${label}: a refused call must spawn nothing (${invocations() - before} invocations)`);
      }
    };

    // (a) The prompt: missing, empty, whitespace only, wrong type, null.
    await expectRefused("missing prompt", "general_task", { cwd: stateDir }, "prompt");
    await expectRefused("empty prompt", "general_task", { prompt: "", cwd: stateDir }, "prompt");
    await expectRefused("blank prompt", "general_task", { prompt: "   ", cwd: stateDir }, "prompt");
    await expectRefused("typed prompt", "general_task", { prompt: 123, cwd: stateDir }, "prompt");
    await expectRefused("null prompt", "explore_task", { prompt: null, cwd: stateDir }, "prompt");

    // (b) Wrong-typed and out-of-range arguments.
    await expectRefused(
      "typed timeout",
      "general_task",
      { prompt: "x", cwd: stateDir, timeout_ms: "soon" },
      "timeout_ms"
    );
    await expectRefused(
      "range timeout",
      "general_task",
      { prompt: "x", cwd: stateDir, timeout_ms: 999_999_999 },
      "timeout_ms"
    );
    await expectRefused(
      "typed boolean",
      "general_task",
      { prompt: "x", cwd: stateDir, auto_approve: "true" },
      "auto_approve"
    );
    await expectRefused("typed array", "general_task", { prompt: "x", cwd: stateDir, add_dirs: [1, 2] }, "add_dirs");
    await expectRefused(
      "empty edit scope",
      "general_task",
      { prompt: "x", cwd: stateDir, edit_scope: [] },
      "edit_scope"
    );
    await expectRefused("typed effort", "general_task", { prompt: "x", cwd: stateDir, effort: 5 }, "effort");

    // (c) An unknown argument key: a typo must be visible, not ignored.
    await expectRefused(
      "unknown key",
      "general_task",
      { prompt: "x", cwd: stateDir, totally_bogus: 1 },
      "totally_bogus"
    );
    await expectRefused("unknown mode", "general_task", { prompt: "x", cwd: stateDir, mode: "plan" }, "mode");

    // (d) watch_task and the two list tools are validated the same way.
    await expectRefused("watch tail", "watch_task", { tail_lines: "abc" }, "tail_lines");
    await expectRefused("watch unknown", "watch_task", { nope: 1 }, "nope");
    await expectRefused("list_models unknown", "list_models", { anything: 1 }, "anything");
    await expectRefused("list_agents unknown", "list_agents", { anything: 1 }, "anything");

    // Not one refused call produced a progress notification.
    const progress = io.parsed().filter((p) => p.method === "notifications/progress");
    if (progress.length !== 0) {
      throw new Error(`(17) a refused call must emit no notifications/progress, got ${JSON.stringify(progress)}`);
    }

    // (e) A valid call still succeeds - the refusals released the lock.
    const before = invocations();
    const ok = await call("general_task", { prompt: "a valid prompt", cwd: stateDir, timeout_ms: 0 });
    if (ok.isError || ok.body.status !== "success") {
      throw new Error(`(17) a valid call must still succeed, got ${JSON.stringify(ok.body)}`);
    }
    if (invocations() - before !== 1) {
      throw new Error(`(17) a valid call must spawn exactly one agy, got ${invocations() - before}`);
    }
  });
  if (exitCode !== 0) {
    throw new Error(`validation suite must exit 0, got ${exitCode}`);
  }

  // The refused calls left no task behind: exactly one transcript exists.
  const stateFiles = readdirSync(stateDir);
  const streams = stateFiles.filter((f) => f.endsWith(".stream"));
  const transcripts = stateFiles.filter((f) => f.endsWith(".ndjson"));
  if (streams.length !== 1 || transcripts.length !== 1) {
    throw new Error(
      `(17) the refused calls must not create a task transcript, state dir has ${streams.length} .stream and ${transcripts.length} .ndjson files`
    );
  }

  console.log(
    'input validation: missing/empty/blank/typed prompt, typed+out-of-range arguments, unknown keys and watch/list tools refused with the {"error": ...} envelope naming the argument (0 spawns, no transcript, no progress); a valid call still succeeds: ok'
  );
}

// ---------------------------------------------------------------------------
// 18. watch_task report completeness: the COMPLETE final result
// ---------------------------------------------------------------------------
{
  /** A fake whose CLI reports a failure with a machine-readable error, then exits 3. */
  const WATCH_FAIL_BODY = [
    `printf '%s\\n' '{"event":"init","conversation_id":"watchfail-c1","init":{"cwd":"/work/watchfail","tools":[],"permission_mode":"accept-edits"}}'`,
    `printf '%s\\n' '{"event":"step_update","step_update":{"conversation_id":"watchfail-c1","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"partial answer","duration_seconds":0.2,"usage":{"total_tokens":7}}}'`,
    `printf '%s\\n' '{"event":"result","result":{"conversation_id":"watchfail-c1","status":"ERROR","response":"","error":"boom: something went wrong","duration_seconds":0.3,"num_turns":1,"usage":{"total_tokens":7}}}'`,
    `echo "fake agy stderr noise" >&2`,
    "exit 3",
  ].join("\n");
  /** The same fake, but the run succeeds. */
  const WATCH_OK_BODY = [
    `printf '%s\\n' '{"event":"init","conversation_id":"watchok-c1","init":{"cwd":"/work/watchok","tools":[],"permission_mode":"accept-edits"}}'`,
    `printf '%s\\n' '{"event":"step_update","step_update":{"conversation_id":"watchok-c1","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"all good","duration_seconds":0.2,"usage":{"total_tokens":11}}}'`,
    `printf '%s\\n' '{"event":"result","result":{"conversation_id":"watchok-c1","status":"SUCCESS","response":"all good","duration_seconds":0.3,"num_turns":2,"usage":{"total_tokens":11}}}'`,
  ].join("\n");
  const writeFake = (body: string): string => {
    const bin = path.join(tmpBase, `fake-agy-${fakeCounter++}`);
    writeFileSync(bin, `#!/bin/sh\n${body}\n`);
    chmodSync(bin, 0o755);
    return bin;
  };

  /**
   * One delegation followed by one watch poll over stdio. The delegation has
   * ended, so its durable receipt exists: the watch report must carry the
   * COMPLETE final result, not a hand-picked subset of it.
   */
  const delegateThenWatch = async (bin: string, stateDir: string, id: number) => {
    const captured: {
      delegation: { isError: boolean; body: Record<string, unknown> };
      watch: { isError: boolean; body: Record<string, unknown> };
    } = {
      delegation: { isError: false, body: {} },
      watch: { isError: false, body: {} },
    };
    const { exitCode } = await driveMcpStdio(bin, stateDir, async (io) => {
      io.send({ jsonrpc: "2.0", id: id - 1, method: "initialize", params: HANDSHAKE("watch-complete-probe") });
      io.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      await io.waitUntil(() => !!io.responseFor(id - 1), `initialize response (id ${id - 1})`);
      io.send({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "general_task", arguments: { prompt: "watch completeness probe", cwd: stateDir } },
      });
      await io.waitUntil(() => !!io.responseFor(id), `delegation response (id ${id})`);
      const dresp = io.responseFor(id);
      captured.delegation.isError = dresp?.result?.isError === true;
      captured.delegation.body = JSON.parse(contentText(dresp, id)) as Record<string, unknown>;
      const taskId = String(captured.delegation.body.task_id ?? "");
      if (!taskId) {
        throw new Error(`the delegation must report a task_id: ${JSON.stringify(captured.delegation.body)}`);
      }
      io.send({
        jsonrpc: "2.0",
        id: id + 1,
        method: "tools/call",
        params: { name: "watch_task", arguments: { stream_file: taskId } },
      });
      await io.waitUntil(() => !!io.responseFor(id + 1), `watch response (id ${id + 1})`);
      const wresp = io.responseFor(id + 1);
      captured.watch.isError = wresp?.result?.isError === true;
      captured.watch.body = JSON.parse(contentText(wresp, id + 1)) as Record<string, unknown>;
    });
    if (exitCode !== 0) {
      throw new Error(`watch-completeness suite must exit 0, got ${exitCode}`);
    }
    return captured;
  };

  /** Every field of the final result must be in the watch report, unchanged. */
  const assertCompleteResult = (label: string, delegation: Record<string, unknown>, watch: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(delegation)) {
      if (JSON.stringify(watch[key]) !== JSON.stringify(value)) {
        throw new Error(
          `(18) ${label}: the watch report must carry ${key}=${JSON.stringify(value)}, got ${JSON.stringify(watch[key])}`
        );
      }
    }
  };

  // (a) A FAILED run: the watch report carries the failure reason - the CLI's
  //     own error message, its notes and the process exit code.
  const failStateDir = mkdtempSync(path.join(os.tmpdir(), "agy-watchfail-"));
  const failed = await delegateThenWatch(writeFake(WATCH_FAIL_BODY), failStateDir, 402);
  if (failed.watch.isError !== false) {
    throw new Error(`(18a) watch_task must not be flagged as an error: ${JSON.stringify(failed.watch.body)}`);
  }
  const fw = failed.watch.body;
  if (fw.status !== "error") {
    throw new Error(`(18a) the watch report must carry status=error: ${JSON.stringify(fw)}`);
  }
  if (fw.error !== "boom: something went wrong") {
    throw new Error(`(18a) the watch report must carry the CLI's error message: ${JSON.stringify(fw.error)}`);
  }
  if (!String(fw.notes ?? "").includes("fake agy stderr noise")) {
    throw new Error(`(18a) the watch report must carry the CLI's notes: ${JSON.stringify(fw.notes)}`);
  }
  if (fw.exit_code !== 3) {
    throw new Error(`(18a) the watch report must carry the exit code: ${JSON.stringify(fw)}`);
  }
  assertCompleteResult("18a", failed.delegation.body, fw);

  // (b) A SUCCESSFUL run: the watch report carries the COMPLETE result.
  const okStateDir = mkdtempSync(path.join(os.tmpdir(), "agy-watchok-"));
  const ok = await delegateThenWatch(writeFake(WATCH_OK_BODY), okStateDir, 404);
  if (ok.watch.isError !== false) {
    throw new Error(`(18b) watch_task must not be flagged as an error: ${JSON.stringify(ok.watch.body)}`);
  }
  const ow = ok.watch.body;
  if (ow.status !== "success" || ow.error !== undefined) {
    throw new Error(`(18b) the watch report must carry the successful status: ${JSON.stringify(ow)}`);
  }
  for (const key of [
    "task_id",
    "status",
    "response",
    "duration_seconds",
    "usage",
    "conversation_id",
    "num_turns",
    "cwd",
    "prompt",
    "auto_approve_applied",
    "resume_hint",
    "exit_code",
    "transcript_file",
    "stream_file",
  ]) {
    if (ow[key] === undefined) {
      throw new Error(`(18b) the watch report must carry ${key}: ${JSON.stringify(ow)}`);
    }
  }
  if (ow.response !== "all good" || ow.conversation_id !== "watchok-c1" || ow.num_turns !== 2) {
    throw new Error(`(18b) the watch report must carry the CLI's result fields: ${JSON.stringify(ow)}`);
  }
  if (ow.exit_code !== 0) {
    throw new Error(`(18b) the watch report must carry the exit code of a successful run: ${JSON.stringify(ow)}`);
  }
  assertCompleteResult("18b", ok.delegation.body, ow);

  // (c) The watch-specific fields are still there, with their own types and
  //     values - the result does not clobber them.
  for (const report of [fw, ow]) {
    for (const key of [
      "found",
      "file",
      "bytes",
      "modified",
      "running",
      "finished",
      "result_ready",
      "content",
      "content_len",
      "steps",
      "step_count",
      "phase",
      "elapsed_seconds",
      "usage_latest",
    ]) {
      if (report[key] === undefined) {
        throw new Error(`(18c) the watch report must carry ${key}: ${JSON.stringify(report)}`);
      }
    }
    if (report.found !== true || report.running !== false || report.finished !== true || report.result_ready !== true) {
      throw new Error(`(18c) the watch report must classify the finished run: ${JSON.stringify(report)}`);
    }
    if (
      typeof report.content !== "string" ||
      !Array.isArray(report.steps) ||
      report.step_count !== report.steps.length
    ) {
      throw new Error(`(18c) the watch fields must keep their types: ${JSON.stringify(report)}`);
    }
    if (report.phase !== "agent_response" || report.elapsed_seconds !== 0.3) {
      throw new Error(`(18c) the digest must survive the merge: ${JSON.stringify(report)}`);
    }
  }

  // (d) Unit level: the receipt is merged WHOLE and can never clobber a
  //     watch-specific field; a run without a receipt carries NO result fields.
  const mergeDir = mkdtempSync(path.join(os.tmpdir(), "agy-watchmerge-"));
  const mergeStream = path.join(mergeDir, "task_merge01.stream");
  const mergeReceipt = path.join(mergeDir, "task_merge01.ndjson");
  writeFileSync(
    mergeStream,
    `${[
      "session open · cwd=/work · permission_mode=accept-edits · tools=1",
      "● agent_response",
      "  ⎿ done in 0.5s · 3 tokens",
      "== done: status=ERROR · 0.5s",
    ].join("\n")}\n`
  );
  writeFileSync(
    mergeReceipt,
    `${JSON.stringify({
      ts: Date.now(),
      event: "result",
      result: {
        task_id: "task_merge01",
        status: "error",
        error: "boom: merge probe",
        notes: "stderr noise",
        exit_code: 3,
        conversation_id: "merge-c1",
        num_turns: 2,
        usage: { total_tokens: 3 },
        denied_actions: ["run_command"],
        response: "",
        prompt: "merge probe",
        cwd: "/work",
        auto_approve_applied: false,
        transcript_file: mergeReceipt,
        stream_file: mergeStream,
        // A receipt that tries to overwrite the watch-owned fields:
        found: false,
        running: true,
        finished: false,
        result_ready: false,
        content: "hijacked",
        content_len: 999,
        file: "/etc/passwd",
        bytes: 0,
        modified: "1999-01-01T00:00:00.000Z",
        steps: [],
        step_count: 99,
        phase: "hijack",
        elapsed_seconds: -1,
        usage_latest: { total_tokens: 999 },
        clipped: true,
        hint: "hijack",
        candidates: ["hijack"],
      },
    })}\n`
  );
  const merged = runner.readStreamTail(mergeStream);
  if (
    merged.found !== true ||
    merged.running !== false ||
    merged.finished !== true ||
    merged.result_ready !== true ||
    merged.file !== mergeStream ||
    merged.content === "hijacked" ||
    typeof merged.bytes !== "number" ||
    merged.bytes <= 0 ||
    !Array.isArray(merged.steps) ||
    merged.steps.length !== 1 ||
    merged.step_count !== 1
  ) {
    throw new Error(`(18d) a receipt must never clobber the watch-specific fields: ${JSON.stringify(merged)}`);
  }
  // The conditionally-set watch fields keep the WATCHER's values, never the
  // receipt's - and the ones the transcript does not carry stay ABSENT (the
  // key is not even present, so a consumer can tell "absent" from "empty").
  if (
    merged.phase !== "agent_response" ||
    merged.elapsed_seconds !== 0.5 ||
    JSON.stringify(merged.usage_latest) !== JSON.stringify({ total_tokens: 3 }) ||
    merged.content_len !== (merged.content ?? "").length ||
    merged.modified === "1999-01-01T00:00:00.000Z"
  ) {
    throw new Error(`(18d) the watch fields must keep the watcher's own values: ${JSON.stringify(merged)}`);
  }
  for (const key of ["clipped", "hint", "candidates"]) {
    if (Object.hasOwn(merged, key)) {
      throw new Error(`(18d) ${key} must be absent when the transcript does not carry it: ${JSON.stringify(merged)}`);
    }
  }
  if (
    merged.error !== "boom: merge probe" ||
    merged.notes !== "stderr noise" ||
    merged.exit_code !== 3 ||
    merged.conversation_id !== "merge-c1" ||
    merged.num_turns !== 2 ||
    merged.task_id !== "task_merge01" ||
    merged.cwd !== "/work" ||
    merged.prompt !== "merge probe" ||
    merged.auto_approve_applied !== false ||
    merged.transcript_file !== mergeReceipt ||
    merged.stream_file !== mergeStream ||
    JSON.stringify(merged.usage) !== JSON.stringify({ total_tokens: 3 }) ||
    JSON.stringify(merged.denied_actions) !== JSON.stringify(["run_command"])
  ) {
    throw new Error(`(18d) the whole receipt must be carried: ${JSON.stringify(merged)}`);
  }

  // (18e) The same hostile receipt against a transcript WITHOUT phase markers:
  //      the watch fields that the watcher does not compute must be ABSENT
  //      (not undefined-valued) even though the receipt injects them.
  const bareStream = path.join(mergeDir, "task_merge03.stream");
  const bareReceipt = path.join(mergeDir, "task_merge03.ndjson");
  writeFileSync(bareStream, "session open · cwd=/work · permission_mode=accept-edits · tools=1\n");
  writeFileSync(
    bareReceipt,
    `${JSON.stringify({
      ts: Date.now(),
      event: "result",
      result: {
        task_id: "task_merge03",
        status: "success",
        response: "ok",
        duration_seconds: 1,
        phase: "hijack",
        elapsed_seconds: -1,
        usage_latest: { total_tokens: 999 },
        clipped: true,
        hint: "hijack",
        candidates: ["hijack"],
        content: "hijacked",
        content_len: 999,
        found: false,
        running: true,
        finished: false,
        result_ready: false,
        file: "/etc/passwd",
        bytes: 0,
        modified: "1999-01-01T00:00:00.000Z",
        steps: [],
        step_count: 99,
      },
    })}\n`
  );
  const bare = runner.readStreamTail(bareStream);
  for (const key of ["phase", "elapsed_seconds", "usage_latest", "clipped", "hint", "candidates"]) {
    if (Object.hasOwn(bare, key)) {
      throw new Error(`(18e) ${key} must be absent, not taken from the receipt: ${JSON.stringify(bare)}`);
    }
  }
  if (
    bare.found !== true ||
    bare.running !== false ||
    bare.finished !== true ||
    bare.result_ready !== true ||
    bare.file !== bareStream ||
    bare.content === "hijacked" ||
    bare.content_len !== (bare.content ?? "").length ||
    typeof bare.bytes !== "number" ||
    bare.bytes <= 0 ||
    bare.step_count !== 0
  ) {
    throw new Error(`(18e) a receipt must never clobber the watch-specific fields: ${JSON.stringify(bare)}`);
  }
  // The result fields are still carried in full.
  if (bare.task_id !== "task_merge03" || bare.status !== "success" || bare.response !== "ok") {
    throw new Error(`(18e) the receipt's result fields must still be carried: ${JSON.stringify(bare)}`);
  }

  const runningStream = path.join(mergeDir, "task_run0002.stream");
  writeFileSync(runningStream, "session open · cwd=/work · permission_mode=accept-edits · tools=1\n● agent_response\n");
  const runningReport = runner.readStreamTail(runningStream);
  if (runningReport.running !== true || runningReport.result_ready !== false) {
    throw new Error(
      `(18d) a run without a receipt must still be reported as running: ${JSON.stringify(runningReport)}`
    );
  }
  for (const key of ["status", "response", "error", "notes", "exit_code", "task_id", "conversation_id", "usage"]) {
    if (runningReport[key] !== undefined) {
      throw new Error(`(18d) a running task must carry no result field (${key}): ${JSON.stringify(runningReport)}`);
    }
  }

  console.log(
    "watch_task completeness: a failed run's watch report carries the CLI's error message, its notes and the exit code, a successful run's carries the complete result, the watch-owned fields are never clobbered by a hostile receipt (the conditional ones stay absent), and a running task still carries no result fields: ok"
  );
}

// ---------------------------------------------------------------------------
// 19. Discovery failures are ERRORS: list_models / list_agents must never
//     dress a crash up as a result
// ---------------------------------------------------------------------------
{
  /** A discovery command that fails with a non-zero exit. */
  const DISCOVERY_FAIL_BODY = [`echo "agy exploded" >&2`, "exit 7"].join("\n");
  /** A discovery command that succeeds and prints a TAB-separated model list. */
  const DISCOVERY_OK_BODY = [
    `printf '%s\\n' 'Fetching available models...'`,
    `printf 'gemini-4-argon-medium\\tGemini 4 Argon (Medium)\\n'`,
    `printf 'gemini-3.8-flash-high\\tGemini 3.8 Flash (High)\\n'`,
  ].join("\n");
  /** A discovery command that never finishes. */
  const DISCOVERY_HANG_BODY = ["sleep 5"].join("\n");
  const writeDiscoveryFake = (body: string): string => {
    const bin = path.join(tmpBase, `fake-agy-${fakeCounter++}`);
    writeFileSync(bin, `#!/bin/sh\n${body}\n`);
    chmodSync(bin, 0o755);
    return bin;
  };

  // (a) A FAILING discovery command is an error, not a result.
  {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "agy-discovery-fail-"));
    const captured: Record<string, { isError: boolean; body: Record<string, unknown> }> = {};
    const { exitCode } = await driveMcpStdio(writeDiscoveryFake(DISCOVERY_FAIL_BODY), stateDir, async (io) => {
      io.send({ jsonrpc: "2.0", id: 501, method: "initialize", params: HANDSHAKE("discovery-fail-probe") });
      io.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      await io.waitUntil(() => !!io.responseFor(501), "initialize response (id 501)");
      let id = 502;
      for (const tool of ["list_models", "list_agents"]) {
        id += 1;
        io.send({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: tool, arguments: {} },
        });
        await io.waitUntil(() => !!io.responseFor(id), `response (id ${id})`);
        const resp = io.responseFor(id);
        captured[tool] = {
          isError: resp?.result?.isError === true,
          body: JSON.parse(contentText(resp, id)) as Record<string, unknown>,
        };
      }
    });
    if (exitCode !== 0) {
      throw new Error(`discovery-failure suite must exit 0, got ${exitCode}`);
    }
    for (const tool of ["list_models", "list_agents"]) {
      const r = captured[tool];
      if (!r) {
        throw new Error(`(19a) ${tool} must answer at all`);
      }
      if (r.isError !== true) {
        throw new Error(`(19a) a failing ${tool} must be flagged isError: ${JSON.stringify(r)}`);
      }
      // The house failure envelope: one key, "error".
      if (Object.keys(r.body).join(",") !== "error") {
        throw new Error(`(19a) a failing ${tool} must use the {"error": ...} envelope: ${JSON.stringify(r.body)}`);
      }
      const msg = String(r.body.error ?? "");
      // The message names the command, the failure mode and the exit code.
      const command = tool === "list_models" ? "agy models" : "agy agents";
      if (!msg.includes(command)) {
        throw new Error(`(19a) the ${tool} error must name the command "${command}": ${msg}`);
      }
      if (!/\bcode 7\b/.test(msg)) {
        throw new Error(`(19a) the ${tool} error must name the exit code: ${msg}`);
      }
      // The captured output is preserved inside the message.
      if (!msg.includes("agy exploded")) {
        throw new Error(`(19a) the ${tool} error must keep the captured output: ${msg}`);
      }
      // The crash output is never presented as the result.
      if (r.body.models !== undefined || r.body.agents !== undefined) {
        throw new Error(`(19a) a failing ${tool} must not carry a result field: ${JSON.stringify(r.body)}`);
      }
    }
  }

  // (b) A SUCCESSFUL discovery command still answers, with the parsed ids.
  {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "agy-discovery-ok-"));
    const captured: Record<string, { isError: boolean; body: Record<string, unknown> }> = {};
    const { exitCode } = await driveMcpStdio(writeDiscoveryFake(DISCOVERY_OK_BODY), stateDir, async (io) => {
      io.send({ jsonrpc: "2.0", id: 511, method: "initialize", params: HANDSHAKE("discovery-ok-probe") });
      io.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      await io.waitUntil(() => !!io.responseFor(511), "initialize response (id 511)");
      let id = 512;
      for (const tool of ["list_models", "list_agents"]) {
        id += 1;
        io.send({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: tool, arguments: {} },
        });
        await io.waitUntil(() => !!io.responseFor(id), `response (id ${id})`);
        const resp = io.responseFor(id);
        captured[tool] = {
          isError: resp?.result?.isError === true,
          body: JSON.parse(contentText(resp, id)) as Record<string, unknown>,
        };
      }
    });
    if (exitCode !== 0) {
      throw new Error(`discovery-success suite must exit 0, got ${exitCode}`);
    }
    const models = captured.list_models;
    if (!models) {
      throw new Error("(19b) list_models must answer at all");
    }
    if (models.isError !== false) {
      throw new Error(`(19b) a successful list_models must not be flagged: ${JSON.stringify(models)}`);
    }
    if (typeof models.body.models !== "string" || !models.body.models.includes("gemini-3.8-flash-high")) {
      throw new Error(`(19b) list_models must still answer with the raw output: ${JSON.stringify(models.body)}`);
    }
    const ids = models.body.model_ids;
    if (!Array.isArray(ids)) {
      throw new Error(`(19b) list_models must carry the parsed ids: ${JSON.stringify(models.body)}`);
    }
    if (JSON.stringify(ids) !== JSON.stringify(["gemini-4-argon-medium", "gemini-3.8-flash-high"])) {
      throw new Error(`(19b) list_models must parse the ids out of the output: ${JSON.stringify(ids)}`);
    }
    if (ids.some((id) => String(id).includes("Fetching"))) {
      throw new Error(`(19b) the header line must not be parsed as an id: ${JSON.stringify(ids)}`);
    }
    const agents = captured.list_agents;
    if (!agents) {
      throw new Error("(19b) list_agents must answer at all");
    }
    if (agents.isError !== false) {
      throw new Error(`(19b) a successful list_agents must not be flagged: ${JSON.stringify(agents)}`);
    }
    if (typeof agents.body.agents !== "string" || agents.body.agents.length === 0) {
      throw new Error(`(19b) list_agents must still answer with its output: ${JSON.stringify(agents.body)}`);
    }
  }

  // (c) Unit level: runCmd keeps the three failure modes apart, and the
  //     model ids are parsed out of the CLI's output.
  {
    const missing = await runner.runCmd("/nonexistent/agy-binary", ["models"], 1_000);
    if (missing.outcome !== "spawn" || missing.code !== null) {
      throw new Error(`(19c) a missing binary must be a spawn failure: ${JSON.stringify(missing)}`);
    }
    if (!missing.reason.includes("ENOENT")) {
      throw new Error(`(19c) a spawn failure must keep the spawn error: ${JSON.stringify(missing)}`);
    }
    const failed = await runner.runCmd(writeDiscoveryFake(DISCOVERY_FAIL_BODY), ["models"], 5_000);
    if (failed.outcome !== "exit" || failed.code !== 7) {
      throw new Error(`(19c) a non-zero exit must report its code: ${JSON.stringify(failed)}`);
    }
    if (!failed.stdout.includes("agy exploded")) {
      throw new Error(`(19c) a failed command must keep its output: ${JSON.stringify(failed)}`);
    }
    const ok = await runner.runCmd(writeDiscoveryFake(DISCOVERY_OK_BODY), ["models"], 5_000);
    if (ok.outcome !== "ok" || ok.code !== 0) {
      throw new Error(`(19c) a successful command must report success: ${JSON.stringify(ok)}`);
    }
    const hung = await runner.runCmd(writeDiscoveryFake(DISCOVERY_HANG_BODY), ["models"], 300);
    if (hung.outcome !== "timeout" || hung.code !== null) {
      throw new Error(`(19c) a hanging command must be a timeout, not an exit code: ${JSON.stringify(hung)}`);
    }
    if (!/timed out/i.test(hung.reason)) {
      throw new Error(`(19c) a timeout must name the limit: ${JSON.stringify(hung)}`);
    }
    const parsedIds = runner.parseModelIds(
      "Fetching available models...\ngemini-4-argon-medium\tGemini 4 Argon (Medium)\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\n"
    );
    if (JSON.stringify(parsedIds) !== JSON.stringify(["gemini-4-argon-medium", "gemini-3.8-flash-high"])) {
      throw new Error(`(19c) the model ids must be the text before the first TAB: ${JSON.stringify(parsedIds)}`);
    }
    if (runner.parseModelIds("Fetching available models...\nagy / gemini / claude").length !== 0) {
      throw new Error("(19c) a line without a TAB must not be parsed as an id");
    }
  }

  console.log(
    'discovery errors: a failing list_models/list_agents comes back as isError with the house {"error": ...} envelope naming the command and the exit code (the crash output stays inside the message, never as the result), a successful one still answers with the raw output and the parsed model ids: ok'
  );
}

closeSync(0);
console.log("=== OFFLINE TESTS PASS ===");

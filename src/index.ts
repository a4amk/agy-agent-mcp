/**
 * agy-agent-mcp: MCP server exposing the Google Antigravity (`agy`) CLI as
 * subagent-style delegation tools.
 *
 * Transport is a hand-rolled, zero-dependency slice of the MCP stdio
 * protocol: newline-delimited JSON-RPC 2.0 over process.stdin/process.stdout
 * with exactly the request methods this package serves (initialize, ping,
 * tools/list, tools/call); every incoming notification is swallowed and every
 * other method gets JSON-RPC "Method not found". The one notification the
 * server emits itself is notifications/progress, mirroring a delegation's
 * .stream transcript to clients that opted in with a _meta.progressToken;
 * delegations are single-flight — a second general_task/explore_task while one
 * runs is rejected, not queued. Run: `npm run build` then
 * `node dist/index.js` (bin/mcp.mjs wraps this; npm installs need compiled
 * JavaScript — Node won't type-strip under node_modules).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  AGY_BIN,
  ALLOW_AUTO_APPROVE,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_PRINT_TIMEOUT_MS,
  RETENTION_DAYS,
  ROOT,
  resolveStreamFile,
  runCmd,
  runTask,
  STATE_DIR,
  shutdownRunner,
  sweepStateDir,
  type TaskOptions,
  watchTask,
} from "./agy.ts";

const SERVER_NAME = "agy-agent-mcp";
// Single source of truth: package.json (always present next to dist/ or src/).
const { version: SERVER_VERSION } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

// ---------------------------------------------------------------------------
// Tool schemas + metadata (verbatim from the SDK-era capture in
// test/goldens/tools-list.json — the compliance contract for tools/list)
// ---------------------------------------------------------------------------

type Args = Record<string, unknown>;
type InputSchema = Record<string, unknown>;

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
}

interface ToolSpec {
  name: string;
  title: string;
  description: string;
  inputSchema: InputSchema;
  handler: (args: Args, params: Args, signal?: AbortSignal) => Promise<ToolResult>;
}

const DELEGATION_INPUT_SCHEMA: InputSchema = {
  type: "object",
  properties: {
    prompt: {
      type: "string",
      minLength: 1,
      description:
        "Full, self-contained task description for the sub-agent. Include all needed context and file paths.",
    },
    conversation_id: {
      type: "string",
      description:
        "Existing agy conversation ID to continue/resume instead of starting a new conversation. Returned by previous task results.",
    },
    cwd: {
      type: "string",
      description:
        "Working directory for the delegated task (project the sub-agent operates on). Defaults to the server's cwd.",
    },
    model: {
      type: "string",
      description:
        "Model for the task, e.g. gemini-3.8-flash (pair it with the effort field) or a tier-carrying id such as gemini-3.8-flash-high (see list_models). Never combine a tier-carrying id with a different effort - the agy CLI rejects that combination.",
    },
    agent: {
      type: "string",
      description: "Antigravity agent profile to use (see list_agents)",
    },
    effort: {
      type: "string",
      enum: ["low", "medium", "high", "xhigh", "max"],
      description: "Reasoning effort for the task",
    },
    auto_approve: {
      type: "boolean",
      description:
        "Expert switch: pass --dangerously-skip-permissions so headless runs stop auto-denying gated tools. Pair it with sandbox when granting it. Allowed by this server.",
    },
    sandbox: {
      type: "boolean",
      description: "Run the task with Antigravity's terminal sandbox flag enabled (--sandbox)",
    },
    add_dirs: {
      type: "array",
      items: { type: "string" },
      description: "Extra directories to add to the task's workspace (--add-dir, repeatable)",
    },
    edit_scope: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      description:
        "Give the sub-agent an edit boundary (files and directories relative to cwd, or absolute). Out-of-scope changes are surfaced in the result's files_touched/scope_violations audit; it is an audit-and-replay control, not a sandbox — the CLI writes files itself.",
    },
    project: {
      type: "string",
      description: "Antigravity project ID or name for the task",
    },
    timeout_ms: {
      type: "integer",
      minimum: 0,
      maximum: 3600000,
      description:
        "Idle timeout for the run in ms (0..3600000; 0 disables the idle kill for this run). Resets on every stdout/stderr chunk from the child; kicks in after this much child silence and kills the child (SIGTERM, then SIGKILL after 5s). Default: 900000 (AGY_MCP_IDLE_TIMEOUT_MS).",
    },
    background: {
      type: "boolean",
      description:
        "When true, start the task headlessly in the background and return immediately with a task handle. Poll watch_task to follow progress and retrieve the final result. Default: false.",
    },
  },
  required: ["prompt"],
  additionalProperties: false,
  $schema: "http://json-schema.org/draft-07/schema#",
};

const WATCH_INPUT_SCHEMA: InputSchema = {
  type: "object",
  properties: {
    stream_file: {
      type: "string",
      minLength: 1,
      description:
        'Stream transcript to read. Omit for the latest task_<id>.stream in AGY_MCP_STATE_DIR. Accepted forms: an absolute path under AGY_MCP_STATE_DIR, a bare file name like "task_f8870173.stream", or a task id like "task_f8870173" / "f8870173".',
    },
    tail_lines: {
      type: "integer",
      minimum: 0,
      maximum: 2000,
      description:
        "Number of trailing lines to return (1..2000, default 400; 0 returns the full transcript, hard-capped at 200,000 chars).",
    },
    cancel: {
      type: "boolean",
      description:
        "When true and the watched task is still running, stop that run immediately (kill the child process, release the delegation lock, and report the run as cancelled).",
    },
  },
  additionalProperties: false,
  $schema: "http://json-schema.org/draft-07/schema#",
};

const EMPTY_INPUT_SCHEMA: InputSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {},
};

// ---------------------------------------------------------------------------
// Typed accesses over loose tool-call arguments
// ---------------------------------------------------------------------------

function stringArg(args: Args, key: string): string | undefined {
  return typeof args[key] === "string" ? (args[key] as string) : undefined;
}

function boolArg(args: Args, key: string): boolean | undefined {
  return typeof args[key] === "boolean" ? (args[key] as boolean) : undefined;
}

function stringArrayArg(args: Args, key: string): string[] | undefined {
  const v = args[key];
  return Array.isArray(v) ? v.filter((e): e is string => typeof e === "string") : undefined;
}

function intArg(args: Args, key: string, min: number, max: number): number | undefined {
  const v = args[key];
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : undefined;
}

function toOptions(
  args: Args,
  sessionID?: string,
  presets?: { mode?: TaskOptions["mode"]; effort?: TaskOptions["effort"] }
): TaskOptions {
  return {
    // Runner-level validation reports honest error results for bad calls; the
    // schema literals above are advisory for clients only.
    prompt: stringArg(args, "prompt") as string,
    cwd: stringArg(args, "cwd"),
    conversationId: stringArg(args, "conversation_id"),
    agent: stringArg(args, "agent"),
    model: stringArg(args, "model"),
    effort: stringArg(args, "effort") as TaskOptions["effort"],
    // No `mode` argument: each tool's preset is fixed by its registration so a
    // read-only explore_task cannot be weakened at call time.
    mode: presets?.mode,
    autoApprove: boolArg(args, "auto_approve"),
    sandbox: boolArg(args, "sandbox"),
    addDirs: stringArrayArg(args, "add_dirs"),
    editScope: stringArrayArg(args, "edit_scope"),
    project: stringArg(args, "project"),
    timeoutMs: intArg(args, "timeout_ms", 0, 3_600_000),
    sessionID,
  };
}

/** OpenCode attaches its session ID (`ses_...`) to every tool call in params _meta. */
function opencodeSessionID(params: Args): string | undefined {
  const meta = params._meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined;
  const v = (meta as Args)["ai.opencode/sessionID"];
  return typeof v === "string" && v ? v : undefined;
}

function textResult(value: unknown, isError = false): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    isError,
  };
}

// ---------------------------------------------------------------------------
// Single-flight delegation lock + notifications/progress bridge
// ---------------------------------------------------------------------------

const DELEGATION_TOOLS = new Set(["general_task", "explore_task"]);

/**
 * At most one delegation may run at a time (the tool call IS the wait, so a
 * blocked caller already serializes itself per session); a second
 * general_task/explore_task arriving while one runs is rejected immediately —
 * not queued — while watch_task, list_models, list_agents, and ping are never
 * blocked. taskId/streamPath are filled by the runner's onTaskStart hook so a
 * rejection can point at the live run before anything streams.
 */
let activeDelegation: {
  tool: string;
  requestId: JsonRpcId;
  taskId?: string;
  streamPath?: string;
  abort?: () => void;
  detached?: boolean;
  promise?: Promise<unknown>;
} | null = null;

/** House tool-error envelope naming the in-flight run (or the tool if it has not reported a task yet). */
function delegationRejectedResult(): ToolResult {
  const running = activeDelegation;
  const detail =
    running?.taskId && running.streamPath
      ? `task ${running.taskId}, stream ${running.streamPath}`
      : `tool ${running?.tool ?? "delegation"}`;
  return {
    content: [
      {
        type: "text",
        text: `MCP error: another delegation is already running (${detail}); one agent at a time - retry after it completes`,
      },
    ],
    isError: true,
  };
}

/** notifications/progress emissions for a delegation are coalesced to this window. */
const PROGRESS_COALESCE_MS = 200;
/** Every mirrored line inside a progress message is clipped to this many chars. */
const PROGRESS_LINE_CHARS = 160;
/** The whole progress message is clipped to this many chars (plain truncation, so every fragment stays a substring of the mirrored line). */
const PROGRESS_MESSAGE_CHARS = 400;
/** Last N completed mirrored lines carried in a progress message. */
const PROGRESS_TAIL_LINES = 2;

function clipChars(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max);
}

/** Read optional `params._meta.progressToken` (string or number; presence means the client opted in). */
function progressTokenArg(params: Args): string | number | undefined {
  const meta = params._meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined;
  const token = (meta as Args).progressToken;
  if (typeof token === "string") return token;
  if (typeof token === "number" && Number.isFinite(token)) return token;
  return undefined;
}

/**
 * Progress bridge for one accepted delegation call that carried a
 * _meta.progressToken. It accumulates the mirrored `.stream` lines fed by
 * runTask's onStreamLine hook (each fired in the same event-loop turn as the
 * file append) and emits notifications/progress at most every
 * PROGRESS_COALESCE_MS with a monotonic completed-line counter. Without a
 * token this factory is never called, so the observable wire behavior is
 * byte-for-byte the pre-bridge one.
 */
function progressBridgeFor(token: string | number) {
  const bridge = {
    sent: 0, // last progress value emitted (0 = the task-started notification)
    notifications: 0, // how many notifications/progress frames were written
    started: false,
    finished: false,
    count: 0, // completed mirrored lines so far (the strictly increasing counter)
    buffer: "", // mirrored text whose line has not been terminated yet
    tail: [] as string[], // last PROGRESS_TAIL_LINES completed mirrored lines
    timer: null as ReturnType<typeof setTimeout> | null,
  };

  const sendProgress = (progress: number, message: string): void => {
    writeLine({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progressToken: token, progress, message },
    });
    bridge.sent = progress;
    bridge.notifications += 1;
  };

  const messageText = () =>
    clipChars(bridge.tail.map((l) => clipChars(l, PROGRESS_LINE_CHARS)).join("\n"), PROGRESS_MESSAGE_CHARS);

  const flush = (): void => {
    bridge.timer = null;
    if (bridge.count > bridge.sent) sendProgress(bridge.count, messageText());
  };

  return {
    onTaskStart(_taskId: string, streamPath: string): void {
      if (bridge.started) return;
      bridge.started = true;
      sendProgress(0, `task started · stream ${path.basename(streamPath)}`);
    },
    onStreamLine(text: string): void {
      if (bridge.finished || !text) return;
      bridge.buffer += text;
      for (let nl = bridge.buffer.indexOf("\n"); nl >= 0; nl = bridge.buffer.indexOf("\n")) {
        bridge.count++;
        bridge.tail.push(bridge.buffer.slice(0, nl));
        if (bridge.tail.length > PROGRESS_TAIL_LINES) bridge.tail.shift();
        bridge.buffer = bridge.buffer.slice(nl + 1);
      }
      // Coalesce bursts: at most one notification per window, armed by the
      // first line seen since the last flush. Unref'd so it never holds the
      // process open.
      if (bridge.timer === null) {
        bridge.timer = setTimeout(flush, PROGRESS_COALESCE_MS);
        bridge.timer.unref?.();
      }
    },
    /**
     * Synchronous final flush, called from the delegation task's finally
     * before the result envelope for this call is written, so the last
     * mirrored line (the == done: ... line) reaches the client ahead of the
     * response. The coalesce timer was unref'd at creation; nothing is left
     * armed when the flush clears it, so stdin EOF still exits cleanly.
     */
    finish(): void {
      bridge.finished = true;
      if (bridge.timer !== null) {
        clearTimeout(bridge.timer);
        bridge.timer = null;
      }
      if (bridge.count > bridge.sent) sendProgress(bridge.count, messageText());
    },
    /**
     * What the bridge actually did for this call. Reported in the task receipt
     * so a client (or a reviewer reading the receipt) can see whether the
     * client opted into progress at all and how many notifications were
     * written - the difference between "the server streamed" and "the client
     * rendered it".
     */
    stats(): { token: string | number; notifications: number; mirrored_lines: number } {
      return { token, notifications: bridge.notifications, mirrored_lines: bridge.count };
    },
  };
}

/**
 * Shared delegation path behind general_task / explore_task: builds the runner
 * options, wires the progress bridge only when the request carried a
 * _meta.progressToken, and flushes the bridge synchronously in finally. The
 * single-flight lock was already engaged by the dispatcher before this runs.
 */
async function runDelegation(
  args: Args,
  params: Args,
  presets: { mode?: TaskOptions["mode"]; effort?: TaskOptions["effort"] },
  signal?: AbortSignal
): Promise<ToolResult> {
  const token = progressTokenArg(params);
  const bridge = token === undefined ? null : progressBridgeFor(token);
  if (bridge) {
    // Visible in the server log: the client opted into progress for this call.
    process.stderr.write(`[${SERVER_NAME}] progress bridge active (token=${String(token)})\n`);
  }
  const opts = toOptions(args, opencodeSessionID(params), presets);
  if (signal) opts.signal = signal;

  const background = boolArg(args, "background") ?? false;
  // A holder rather than a plain variable: the receipt is filled by the
  // onTaskStart callback (which fires synchronously inside runTask, before its
  // first await), and TypeScript's control-flow analysis cannot see an
  // assignment made from inside a closure.
  const started: {
    receipt: {
      task_id: string;
      status: "running";
      stream_file: string;
      transcript_file: string;
      started: true;
      note: string;
    } | null;
  } = { receipt: null };

  opts.onTaskStart = (taskId, streamPath, transcriptPath) => {
    if (activeDelegation) {
      activeDelegation.taskId = taskId;
      activeDelegation.streamPath = streamPath;
    }
    const transcript = transcriptPath ?? streamPath.replace(/\.stream$/, ".ndjson");
    started.receipt = {
      task_id: taskId,
      status: "running",
      stream_file: streamPath,
      transcript_file: transcript,
      started: true,
      note: "poll watch_task with this task_id until running is false - the final result is included in the last poll",
    };
    bridge?.onTaskStart(taskId, streamPath);
  };
  if (bridge) {
    opts.onStreamLine = (text) => bridge.onStreamLine(text);
    opts.getProgressBridge = () => {
      bridge.finish();
      return bridge.stats();
    };
  }

  if (background) {
    try {
      const runPromise = runTask(opts);
      if (activeDelegation) {
        activeDelegation.detached = true;
        activeDelegation.promise = runPromise;
      }
      const taskId = started.receipt ? started.receipt.task_id : activeDelegation?.taskId;
      runPromise
        .then((result) => {
          if (bridge) result.progress_bridge = bridge.stats();
          return result;
        })
        .catch((err) => {
          process.stderr.write(`[${SERVER_NAME}] detached run error: ${(err as Error).message}\n`);
        })
        .finally(() => {
          bridge?.finish();
          if (activeDelegation?.taskId === taskId) {
            activeDelegation = null;
          }
        });

      if (started.receipt) {
        return textResult(started.receipt);
      }
      const result = await runPromise;
      if (bridge) result.progress_bridge = bridge.stats();
      return textResult(result, result.status !== "success");
    } catch (err) {
      if (activeDelegation) activeDelegation = null;
      return textResult({ error: (err as Error).message }, true);
    }
  }

  try {
    const runPromise = runTask(opts);
    if (activeDelegation) {
      activeDelegation.promise = runPromise;
    }
    const result = await runPromise;
    // The receipt says whether the client asked for progress and how much was
    // streamed, so "the server streamed but the client showed nothing" is
    // distinguishable from "the client never opted in".
    if (bridge) result.progress_bridge = bridge.stats();
    return textResult(result);
  } catch (err) {
    return textResult({ error: (err as Error).message }, true);
  } finally {
    // Final progress flush precedes the result envelope for this call.
    bridge?.finish();
  }
}

// ---------------------------------------------------------------------------
// The five tools (same handler bodies as the SDK-era server)
// ---------------------------------------------------------------------------

const TOOLS: ToolSpec[] = [
  {
    name: "general_task",
    title: "Run general-purpose Antigravity sub-agent task",
    description:
      "Delegate a general-purpose coding task to the Antigravity (agy) CLI and block until the headless run " +
      "exits (synchronous; the tool call IS the wait). Defaults: mode accept-edits, effort medium. The result " +
      "carries the agent's final response, the resumable conversation_id, token usage, denied_actions, and the " +
      "git-based files_touched/scope_violations audit when cwd is a git repo. Headless runs auto-DENY tool " +
      "requests that would prompt instead of hanging (surfaced in denied_actions); permission to allow them is " +
      "granted by the user via permissions.allow rules in their own Antigravity settings.json (e.g. " +
      "command(<target>)), which this server never edits. File edits inside the task cwd never prompt; set " +
      "edit_scope so out-of-scope changes are flagged in the audit. auto_approve is the expert full-auto switch " +
      "(--dangerously-skip-permissions); pair it with sandbox when granting it.",
    inputSchema: DELEGATION_INPUT_SCHEMA,
    handler: async (args, params, signal) =>
      runDelegation(args, params, { mode: "accept-edits", effort: "medium" }, signal),
  },
  {
    name: "explore_task",
    title: "Run read-only Antigravity exploration task",
    description:
      "Delegate a fast read-only exploration and diagnosis task to the Antigravity (agy) CLI and block until " +
      "the headless run exits (synchronous; the tool call IS the wait). Defaults: mode plan (read-only), " +
      "effort low; the mode preset is fixed, so callers cannot weaken the read-only posture. Produces answers " +
      "and summaries without modifying files. Returns the same report as general_task, including the git-based " +
      "files_touched/scope_violations audit. Headless runs auto-DENY tool requests that would prompt instead of " +
      "hanging (surfaced in denied_actions); permission to allow them is granted by the user via " +
      "permissions.allow rules in their own Antigravity settings.json (e.g. command(<target>)), which this " +
      "server never edits. auto_approve is the expert full-auto switch (--dangerously-skip-permissions); pair " +
      "it with sandbox when granting it.",
    inputSchema: DELEGATION_INPUT_SCHEMA,
    handler: async (args, params, signal) => runDelegation(args, params, { mode: "plan", effort: "low" }, signal),
  },
  {
    name: "watch_task",
    title: "Watch live or recent task stream transcript",
    description:
      "Tails a task's live stream transcript. No args = latest run. Call it while a general_task/explore_task " +
      "is in flight (this or any session) to watch the sub-agent work; the returned 'running' field plus " +
      "'modified' tell a live run from an abandoned one. For a live feed prefer the compact digest: 'steps' " +
      "(one entry per read/write/run/phase with its target, duration and token cost), 'step_count', 'phase', " +
      "'elapsed_seconds' and 'usage_latest'. 'content' is the raw transcript tail - read it for detail, not " +
      "for a status display. Once the run ends, the report also carries the final result (status, response, " +
      "usage, files_touched, scope_violations); 'result_ready' says the durable receipt has it.",
    inputSchema: WATCH_INPUT_SCHEMA,
    handler: async (args) => {
      try {
        const streamFile = stringArg(args, "stream_file");
        const tailLines = intArg(args, "tail_lines", 0, 2000);
        const cancel = boolArg(args, "cancel") ?? false;
        if (cancel && activeDelegation) {
          let shouldCancel = false;
          if (!streamFile) {
            shouldCancel = true;
          } else {
            const resolved = resolveStreamFile(STATE_DIR, streamFile);
            if (!("error" in resolved)) {
              if (
                activeDelegation.streamPath === resolved.path ||
                activeDelegation.taskId === streamFile ||
                (activeDelegation.taskId && resolved.path.includes(activeDelegation.taskId))
              ) {
                shouldCancel = true;
              }
            }
          }
          if (shouldCancel) {
            try {
              activeDelegation.abort?.();
            } catch {
              /* abort callback error swallowed */
            }
            if (activeDelegation.promise) {
              try {
                await activeDelegation.promise;
              } catch {
                /* promise rejection swallowed */
              }
            }
            activeDelegation = null;
          }
        }
        return textResult(
          watchTask({
            streamFile,
            tailLines,
            cancel,
          })
        );
      } catch (err) {
        return textResult({ error: (err as Error).message }, true);
      }
    },
  },
  {
    name: "list_models",
    title: "List available agy models",
    description: "List model IDs usable for the `model` parameter of delegation tools.",
    inputSchema: EMPTY_INPUT_SCHEMA,
    handler: async () => {
      const { stdout } = await runCmd(AGY_BIN, ["models"], 30_000);
      return textResult({ models: stdout || "(no output from `agy models`)" });
    },
  },
  {
    name: "list_agents",
    title: "List available agy agents",
    description: "List agent profiles usable for the `agent` parameter of delegation tools.",
    inputSchema: EMPTY_INPUT_SCHEMA,
    handler: async () => {
      const { stdout } = await runCmd(AGY_BIN, ["agents"], 30_000);
      return textResult({
        agents: stdout || "(no custom agents configured; default agent will be used)",
      });
    },
  },
];

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t] as const));

// ---------------------------------------------------------------------------
// JSON-RPC plumbing (newline-delimited 2.0 over stdio)
// ---------------------------------------------------------------------------

type JsonRpcId = string | number;

function asObject(value: unknown): Args {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Args) : {};
}

function writeLine(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id: JsonRpcId, result: unknown): void {
  writeLine({ result, jsonrpc: "2.0", id });
}

function respondError(id: JsonRpcId, code: number, message: string): void {
  writeLine({ jsonrpc: "2.0", id, error: { code, message } });
}

/**
 * Message reproduced from the zod-shaped input error the SDK-era server sent
 * for tools/call params.name: a one-issue array pretty-printed with 2-space
 * indentation, describing exactly the missing / non-string tool name.
 */
function invalidToolNameMessage(received: unknown): string {
  return JSON.stringify(
    [
      {
        expected: "string",
        code: "invalid_type",
        path: ["params", "name"],
        message: `Invalid input: expected string, received ${received === null ? "null" : Array.isArray(received) ? "array" : typeof received}`,
      },
    ],
    null,
    2
  );
}

function toolsCall(params: Args, id: JsonRpcId): void | Promise<void> {
  const name = params.name;
  if (typeof name !== "string") {
    return respondError(id, -32603, invalidToolNameMessage(name));
  }
  const tool = TOOL_MAP.get(name);
  if (!tool) {
    return respond(id, {
      content: [{ type: "text", text: `MCP error -32602: Tool ${name} not found` }],
      isError: true,
    });
  }
  // Single-flight delegation lock, engaged at dispatch entry: a second
  // general_task/explore_task is rejected immediately (not queued), while
  // watch_task / list_models / list_agents / ping never touch it.
  const isDelegation = DELEGATION_TOOLS.has(name);
  let abortController: AbortController | undefined;
  if (isDelegation) {
    if (activeDelegation !== null) {
      return respond(id, delegationRejectedResult());
    }
    abortController = new AbortController();
    activeDelegation = {
      tool: name,
      requestId: id,
      abort: () => abortController?.abort(),
    };
  }
  return tool
    .handler(asObject(params.arguments), params, abortController?.signal)
    .then(
      (result) => respond(id, result),
      // Tool handlers catch their own runner errors; this arm is the defensive
      // SDK-era transcript for a handler that itself threw: the error message
      // verbatim in a text content block.
      (err) =>
        respond(id, {
          content: [{ type: "text", text: err instanceof Error ? err.message : "Internal error" }],
          isError: true,
        })
    )
    .finally(() => {
      // Released in finally so timeout kills and run errors release it too.
      if (isDelegation && activeDelegation?.requestId === id && !activeDelegation.detached) {
        activeDelegation = null;
      }
    });
}

function dispatch(method: string, params: Args, id: JsonRpcId): void | Promise<void> {
  switch (method) {
    case "initialize":
      // Answered every time, even twice — echoes the client's requested
      // protocolVersion verbatim (see test/goldens/initialize.json et al).
      return respond(id, {
        protocolVersion: params.protocolVersion,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    case "ping":
      return respond(id, {});
    case "tools/list":
      return respond(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          execution: { taskSupport: "forbidden" },
        })),
      });
    case "tools/call":
      return toolsCall(params, id);
    default:
      // Any unimplemented request method - before, during, or after
      // initialization alike (there is no initialization gate).
      return respondError(id, -32601, "Method not found");
  }
}

function handleMessage(line: string): void {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    // Non-JSON input line: silently ignored, no -32700 broadcast (observed).
    return;
  }
  const msg = asObject(message);
  if (msg.jsonrpc !== "2.0") return; // not envelope-shaped: ignored
  if ("result" in msg || "error" in msg) return; // a stray client-side response: nothing to do
  if (typeof msg.method !== "string") return; // not a request/notification: ignored

  if (msg.method === "notifications/cancelled") {
    const cancelParams = asObject(msg.params);
    const reqId = cancelParams.requestId;
    if (
      (typeof reqId === "string" || (typeof reqId === "number" && Number.isInteger(reqId))) &&
      activeDelegation !== null &&
      activeDelegation.requestId === reqId
    ) {
      try {
        activeDelegation.abort?.();
      } catch {
        /* abort callback error swallowed */
      }
      activeDelegation = null;
    }
    return;
  }

  const { id } = msg;
  // Requests carry a string or integer id; everything else (no id, null,
  // fractional) is a notification — answered never, even unknown methods.
  if (!(typeof id === "string" || (typeof id === "number" && Number.isInteger(id)))) return;
  try {
    const pending = dispatch(msg.method, asObject(msg.params), id);
    if (pending instanceof Promise) {
      pending.catch((err) => {
        respondError(id, -32603, err instanceof Error ? err.message : "Internal error");
      });
    }
  } catch (err) {
    respondError(id, -32603, err instanceof Error ? err.message : "Internal error");
  }
}

// ---------------------------------------------------------------------------
// Start transport: newline-splitting stdin reader -> immediate stdout writes
// ---------------------------------------------------------------------------

sweepStateDir();

process.stderr.write(
  `[${SERVER_NAME}] starting (agy=${AGY_BIN}, idle_timeout_ms=${DEFAULT_IDLE_TIMEOUT_MS === 0 ? "off" : DEFAULT_IDLE_TIMEOUT_MS}, wall_timeout_ms=${DEFAULT_PRINT_TIMEOUT_MS === 0 ? "off" : DEFAULT_PRINT_TIMEOUT_MS}, auto_approve=${ALLOW_AUTO_APPROVE ? "allowed" : "denied"}${ROOT ? `, root=${ROOT}` : ""}, retention=${RETENTION_DAYS === 0 ? "off" : `${RETENTION_DAYS}d`})\n`
);

let buffered: Buffer<ArrayBufferLike> = Buffer.alloc(0);
process.stdin.on("data", (chunk: Buffer) => {
  buffered = buffered.length > 0 ? Buffer.concat([buffered, chunk]) : chunk;
  for (;;) {
    const eol = buffered.indexOf("\n");
    if (eol < 0) break;
    const line = buffered.subarray(0, eol).toString("utf8").replace(/\r$/, "");
    buffered = buffered.subarray(eol + 1);
    handleMessage(line);
  }
});
// Stdin read errors are swallowed silently, mirroring the SDK transport.
function ignoreStdinError(): void {}
process.stdin.on("error", ignoreStdinError);
// EOF ends the server gracefully: the client is gone, kill in-flight headless
// run children the same way SIGINT/SIGTERM do below, then exit cleanly.
async function shutdownAndExit(): Promise<void> {
  await shutdownRunner();
  process.exit(0);
}
process.stdin.on("end", () => {
  void shutdownAndExit();
});
process.stdin.on("close", () => {
  void shutdownAndExit();
});

process.stderr.write(`[${SERVER_NAME}] connected on stdio\n`);

// When the MCP client dies mid-call, responses can arrive on a closed pipe and
// writes surface it as an unhandled EPIPE. Exit quietly — in-flight headless
// run children are killed on the way out; nothing else needs cleanup that the
// next boot's sweep would not do anyway.
process.on("uncaughtException", async (err) => {
  if ((err as NodeJS.ErrnoException)?.code === "EPIPE") {
    await shutdownRunner();
    process.exit(1);
  }
  throw err;
});

// On shutdown: kill in-flight headless run children. There is no pane a human
// could attach to anymore, so leaving one running would only orphan model
// usage in the background — see shutdownRunner.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await shutdownRunner();
    process.exit(0);
  });
}

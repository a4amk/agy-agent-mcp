/**
 * agy-agent-mcp: MCP server exposing the Google Antigravity (`agy`) CLI as
 * subagent-style delegation tools.
 *
 * Transport is a hand-rolled, zero-dependency slice of the MCP stdio
 * protocol: newline-delimited JSON-RPC 2.0 over process.stdin/process.stdout
 * with exactly the request methods this package serves (initialize, ping,
 * tools/list, tools/call); every notification is swallowed and every other
 * method gets JSON-RPC "Method not found". Run: `npm run build` then
 * `node dist/index.js` (bin/mcp.mjs wraps this; npm installs need compiled
 * JavaScript — Node won't type-strip under node_modules).
 */
import { readFileSync } from "node:fs";
import {
  AGY_BIN,
  ALLOW_AUTO_APPROVE,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_PRINT_TIMEOUT_MS,
  RETENTION_DAYS,
  ROOT,
  runCmd,
  runTask,
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
  handler: (args: Args, params: Args) => Promise<ToolResult>;
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
      description: "Model for the task, e.g. gemini-3.8-flash-medium, claude-opus-5-5-high (see list_models)",
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
    handler: async (args, params) => {
      try {
        const result = await runTask(
          toOptions(args, opencodeSessionID(params), { mode: "accept-edits", effort: "medium" })
        );
        return textResult(result);
      } catch (err) {
        return textResult({ error: (err as Error).message }, true);
      }
    },
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
    handler: async (args, params) => {
      try {
        const result = await runTask(toOptions(args, opencodeSessionID(params), { mode: "plan", effort: "low" }));
        return textResult(result);
      } catch (err) {
        return textResult({ error: (err as Error).message }, true);
      }
    },
  },
  {
    name: "watch_task",
    title: "Watch live or recent task stream transcript",
    description:
      "Tails a task's live stream transcript. No args = latest run. Call it while a general_task/explore_task " +
      "is in flight (this or any session) to watch the sub-agent work; the returned 'running' field plus " +
      "'modified' tell a live run from an abandoned one.",
    inputSchema: WATCH_INPUT_SCHEMA,
    handler: async (args) => {
      try {
        return textResult(
          watchTask({
            streamFile: stringArg(args, "stream_file"),
            tailLines: intArg(args, "tail_lines", 0, 2000),
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
  return tool.handler(asObject(params.arguments), params).then(
    (result) => respond(id, result),
    // Tool handlers catch their own runner errors; this arm is the defensive
    // SDK-era transcript for a handler that itself threw: the error message
    // verbatim in a text content block.
    (err) =>
      respond(id, {
        content: [{ type: "text", text: err instanceof Error ? err.message : "Internal error" }],
        isError: true,
      })
  );
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
function shutdownAndExit(): void {
  shutdownRunner();
  process.exit(0);
}
process.stdin.on("end", shutdownAndExit);
process.stdin.on("close", shutdownAndExit);

process.stderr.write(`[${SERVER_NAME}] connected on stdio\n`);

// When the MCP client dies mid-call, responses can arrive on a closed pipe and
// writes surface it as an unhandled EPIPE. Exit quietly — in-flight headless
// run children are killed on the way out; nothing else needs cleanup that the
// next boot's sweep would not do anyway.
process.on("uncaughtException", (err) => {
  if ((err as NodeJS.ErrnoException)?.code === "EPIPE") {
    shutdownRunner();
    process.exit(1);
  }
  throw err;
});

// On shutdown: kill in-flight headless run children. There is no pane a human
// could attach to anymore, so leaving one running would only orphan model
// usage in the background — see shutdownRunner.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    shutdownRunner();
    process.exit(0);
  });
}

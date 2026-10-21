/**
 * agy-agent-mcp: MCP server exposing the Google Antigravity (`agy`) CLI as
 * subagent-style delegation tools.
 *
 * Transport is a hand-rolled, zero-dependency slice of the MCP stdio
 * protocol: newline-delimited JSON-RPC 2.0 over process.stdin/process.stdout
 * with exactly the request methods this package serves (initialize, ping,
 * tools/list, tools/call); every incoming notification is swallowed - except
 * notifications/cancelled, which aborts the matching in-flight delegation -
 * and every other method gets JSON-RPC "Method not found". The one
 * notification the server emits itself is notifications/progress, mirroring a
 * delegation's .stream transcript to clients that opted in with a
 * _meta.progressToken - only while that request is still in flight, so a
 * detached (background: true) run emits none and is followed through
 * watch_task instead;
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
  type CmdResult,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_PRINT_TIMEOUT_MS,
  type EffortLevel,
  modelTier,
  parseModelIds,
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

/**
 * The JSON Schema subset this server advertises in tools/list and enforces
 * at call time. The schema literals below are the single source of truth:
 * the validator READS them, it never re-declares a rule in a second place.
 */
interface SchemaProperty {
  type?: "string" | "boolean" | "integer" | "number" | "array" | "object";
  enum?: readonly unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  minItems?: number;
  pattern?: string;
  items?: { type?: SchemaProperty["type"] };
  description?: string;
}

interface Schema {
  $schema?: string;
  type?: "object";
  properties?: Record<string, SchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
}

interface ToolSpec {
  name: string;
  title: string;
  description: string;
  inputSchema: Schema;
  handler: (args: Args, params: Args, signal?: AbortSignal) => Promise<ToolResult>;
}

const DELEGATION_INPUT_SCHEMA: Schema = {
  type: "object",
  properties: {
    prompt: {
      type: "string",
      minLength: 1,
      pattern: "\\S",
      description:
        "Full, self-contained task description for the sub-agent. Include all needed context and file paths. Must not be empty or whitespace only.",
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
        "Model for the task, e.g. gemini-3.8-flash (pair it with the effort field). Ids returned by list_models carry their tier (e.g. gemini-3.8-flash-high) and must not be combined with a different effort - the agy CLI rejects that combination. A tier-carrying id takes precedence over the default effort (its tier wins and no --effort is passed for it).",
    },
    agent: {
      type: "string",
      description: "Antigravity agent profile to use (see list_agents)",
    },
    effort: {
      type: "string",
      enum: ["low", "medium", "high"],
      description:
        "Reasoning effort for the task: low|medium|high (the only levels the available models accept). Applies to a model id that does not carry a tier - a tier-carrying id (e.g. gemini-3.8-flash-high, as returned by list_models) already encodes its tier and takes precedence over this effort.",
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
        "When true, start the task headlessly in the background and return immediately with a task handle. Poll watch_task to follow progress and retrieve the final result. A detached run emits NO notifications/progress: MCP progress notifications only apply while the request is in flight, and a detached call has already been answered - watch_task is its progress channel. Default: false.",
    },
  },
  required: ["prompt"],
  additionalProperties: false,
  $schema: "http://json-schema.org/draft-07/schema#",
};

const WATCH_INPUT_SCHEMA: Schema = {
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

const EMPTY_INPUT_SCHEMA: Schema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {},
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Schema-driven input validation
// ---------------------------------------------------------------------------

/** The JSON type of a value, named the way the schema names types. */
function jsonTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** "a string" / "an integer" ... - the article fits the type name. */
const TYPE_ARTICLE: Record<NonNullable<SchemaProperty["type"]>, string> = {
  string: "a string",
  boolean: "a boolean",
  integer: "an integer",
  number: "a number",
  array: "an array",
  object: "an object",
};

/** Whether a value satisfies a schema `type` keyword. */
function matchesType(type: SchemaProperty["type"], value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    default:
      return true;
  }
}

/**
 * Validate one property value against its schema. Returns null when the
 * value is acceptable, or a message naming the offending argument.
 */
function validateProperty(key: string, schema: SchemaProperty, value: unknown): string | null {
  // An absent property is not a violation: the tool's default applies.
  if (value === undefined) return null;
  // The enum is checked first: its message names the accepted values, and for
  // `effort` it is the message shape this server has always used
  // ("effort must be one of <the schema's levels>, got: ...").
  if (schema.enum && !schema.enum.includes(value)) {
    return `${key} must be one of ${schema.enum.join("|")}, got: ${String(value)}`;
  }
  if (schema.type && !matchesType(schema.type, value)) {
    return `${key} must be ${TYPE_ARTICLE[schema.type]}, got: ${jsonTypeOf(value)}`;
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      return `${key} must be >= ${schema.minimum}, got: ${value}`;
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      return `${key} must be <= ${schema.maximum}, got: ${value}`;
    }
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      return `${key} must be at least ${schema.minLength} character(s) long, got: ${JSON.stringify(value)}`;
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      return `${key} must match the schema pattern ${JSON.stringify(schema.pattern)}, got: ${JSON.stringify(value)}`;
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      return `${key} must contain at least ${schema.minItems} item(s), got: ${value.length}`;
    }
    if (schema.items?.type) {
      for (const [index, item] of value.entries()) {
        if (!matchesType(schema.items.type, item)) {
          return `${key}[${index}] must be ${TYPE_ARTICLE[schema.items.type]}, got: ${jsonTypeOf(item)}`;
        }
      }
    }
  }
  return null;
}

/**
 * Validate a tool call's arguments against the schema the tool advertises in
 * tools/list. Returns null when the call is acceptable, or a message naming
 * the offending argument. The schema literal is the only source of truth:
 * `type`, `enum`, `minimum`, `maximum`, `minLength`, `minItems`,
 * `items.type`, `pattern`, `required` and `additionalProperties: false` are
 * all honoured here, and a violation is reported before anything is spawned.
 */
function validateArgs(schema: Schema, args: Args): string | null {
  const properties = schema.properties ?? {};
  for (const key of schema.required ?? []) {
    if (args[key] === undefined) {
      return `missing required argument: ${key}`;
    }
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(args)) {
      // Object.hasOwn, not `in`: an argument named "constructor" or
      // "__proto__" is not a property of the schema.
      if (!Object.hasOwn(properties, key)) {
        return `unknown argument: ${key} (not part of this tool's input schema)`;
      }
    }
  }
  for (const key of Object.keys(args)) {
    const property = Object.hasOwn(properties, key) ? properties[key] : undefined;
    if (!property) continue;
    const message = validateProperty(key, property, args[key]);
    if (message) return message;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Typed accesses over loose tool-call arguments
// ---------------------------------------------------------------------------

function stringArg(args: Args, key: string): string | undefined {
  return typeof args[key] === "string" ? (args[key] as string) : undefined;
}

/**
 * A string argument, trimmed. The id-like arguments (`model`, `agent`,
 * `project`, `conversation_id`) are compared verbatim by the agy CLI, so a
 * padded value (" gemini-3.8-flash ") is an unknown model / agent / project.
 * Trimming them here means what reaches the CLI and what the error messages
 * quote are the same value. A value that is only whitespace becomes empty and
 * is treated as absent. The prompt is NOT trimmed (leading whitespace may be
 * meaningful) and `cwd` is resolved by the runner.
 */
function trimmedStringArg(args: Args, key: string): string | undefined {
  const value = stringArg(args, key);
  return value === undefined ? undefined : value.trim();
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

/**
 * Resolve the effort the runner must use (audit B1/B2/B3):
 *
 * - the effort LEVEL is validated by the schema validator (the tool's
 *   advertised enum is the single source of truth), so it is one of
 *   low|medium|high by the time it reaches this function;
 * - a model id that already carries a tier conflicts with a *different*
 *   effort (the agy CLI hard-fails on that combination), so it is rejected
 *   locally too, before anything is spawned;
 * - a tier-carrying id wins over the effort: the id already encodes the tier,
 *   so no --effort flag is emitted next to it (this also covers the case where
 *   the caller passed the very same tier);
 * - without a tier-carrying model the caller's effort applies, else the tool's
 *   preset (general_task: medium, explore_task: low).
 *
 * Tier detection and the tier/effort comparison are case-insensitive: the
 * agy CLI resolves model ids case-insensitively, so "GEMINI-3.8-FLASH-HIGH"
 * carries its tier just like "gemini-3.8-flash-high" does. The accepted
 * effort values stay lowercase-only (the schema enum).
 *
 * Throws on a rejected call; the caller turns that into the standard
 * {"error": ...} envelope without spawning a task.
 */
function resolveEffort(
  model: string | undefined,
  requested: EffortLevel | undefined,
  preset: TaskOptions["effort"]
): EffortLevel | undefined {
  const tier = modelTier(model);
  if (requested !== undefined && tier && tier.toLowerCase() !== requested.toLowerCase()) {
    throw new Error(
      `model "${model}" already carries tier "${tier}" which conflicts with effort "${requested}"; pass one or the other`
    );
  }
  // A tier-carrying model id carries its tier: never add --effort next to it.
  if (tier) return undefined;
  return requested ?? preset;
}

function toOptions(
  args: Args,
  sessionID?: string,
  presets?: { mode?: TaskOptions["mode"]; effort?: TaskOptions["effort"] }
): TaskOptions {
  const model = trimmedStringArg(args, "model");
  return {
    // The advertised schema is enforced before a call reaches this point
    // (validateArgs), so every value read here is already of the type the
    // schema declares - the accessors below never silently drop one.
    prompt: stringArg(args, "prompt") as string,
    cwd: stringArg(args, "cwd"),
    conversationId: trimmedStringArg(args, "conversation_id"),
    agent: trimmedStringArg(args, "agent"),
    model,
    // Local effort resolution: a model/effort conflict throws here, so
    // nothing is spawned for a call the CLI would reject. The effort LEVEL
    // itself is checked by the schema validator (its enum is the single
    // source of truth for the "effort must be one of ..." message).
    effort: resolveEffort(model, stringArg(args, "effort") as EffortLevel | undefined, presets?.effort),
    // No `mode` argument: each tool's preset is fixed by its registration so a
    // read-only explore_task cannot be weakened at call time.
    mode: presets?.mode,
    autoApprove: boolArg(args, "auto_approve"),
    sandbox: boolArg(args, "sandbox"),
    addDirs: stringArrayArg(args, "add_dirs"),
    editScope: stringArrayArg(args, "edit_scope"),
    project: trimmedStringArg(args, "project"),
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

/**
 * House tool-error envelope naming the in-flight run (or the tool if it has
 * not reported a task yet).
 *
 * The rejection uses the same shape as every other refusal in this server: a
 * single `{"error": "..."}` key with `isError: true`. A caller that parses the
 * body as JSON therefore gets a message, not a parse error.
 */
function delegationRejectedResult(): ToolResult {
  const running = activeDelegation;
  const detail =
    running?.taskId && running.streamPath
      ? `task ${running.taskId}, stream ${running.streamPath}`
      : `tool ${running?.tool ?? "delegation"}`;
  return textResult(
    {
      error: `another delegation is already running (${detail}); one agent at a time - retry after it completes`,
    },
    true
  );
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
 * _meta.progressToken AND the call stays in flight, and flushes the bridge
 * synchronously in finally. The single-flight lock was already engaged by the
 * dispatcher before this runs.
 */
async function runDelegation(
  args: Args,
  params: Args,
  presets: { mode?: TaskOptions["mode"]; effort?: TaskOptions["effort"] },
  signal?: AbortSignal
): Promise<ToolResult> {
  let opts: TaskOptions;
  let background: boolean;
  try {
    // The advertised input schema is enforced BEFORE anything is spawned: a
    // call that does not match it is refused with the same {"error": ...}
    // envelope the runner's own validation errors use, with isError set -
    // not as a bare message.
    const invalid = validateArgs(DELEGATION_INPUT_SCHEMA, args);
    if (invalid) throw new Error(invalid);
    opts = toOptions(args, opencodeSessionID(params), presets);
    // Read BEFORE the bridge is created: whether the call stays in flight
    // decides whether notifications/progress has anything to attach to.
    background = boolArg(args, "background") ?? false;
  } catch (err) {
    return textResult({ error: (err as Error).message }, true);
  }
  // The progress bridge is wired only for an accepted call: a refused one
  // must not emit a single progress notification.
  //
  // A DETACHED call (background: true) answers immediately with a handle, so
  // the request it belonged to is no longer in flight: notifications/progress
  // would have nothing to attach to. The official MCP SDK client drops its
  // progress handler when the response arrives and then reports "Received a
  // progress notification for an unknown token" for every later frame. A
  // detached run therefore creates NO bridge at all - no frames, no
  // "progress bridge active" log line, no progress_bridge receipt field, and
  // nothing at all from the detached run's finally. A _meta.progressToken on
  // such a call is simply ignored (not an error, not echoed). watch_task is
  // the detached run's progress channel.
  const token = background ? undefined : progressTokenArg(params);
  const bridge = token === undefined ? null : progressBridgeFor(token);
  if (bridge) {
    // Visible in the server log: the client opted into progress for this call.
    process.stderr.write(`[${SERVER_NAME}] progress bridge active (token=${String(token)})\n`);
  }
  if (signal) opts.signal = signal;

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
        // A background handle is not a failure: it says "running", so it must
        // not be flagged as an error.
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
    // A failed delegation is a failed tool call: the envelope says so, so an
    // orchestrating agent that keys off isError does not read a failed run as
    // a success. The background path above already reports it the same way.
    return textResult(result, result.status !== "success");
  } catch (err) {
    return textResult({ error: (err as Error).message }, true);
  } finally {
    // Final progress flush precedes the result envelope for this call.
    bridge?.finish();
  }
}

// ---------------------------------------------------------------------------
// Discovery failures: a discovery command that did not succeed is an error
// ---------------------------------------------------------------------------

/**
 * The house failure message for a discovery command (`agy models` /
 * `agy agents`) that did not succeed: it names the command, the failure mode
 * and the exit code when there is one, and the captured output is preserved
 * inside the message so nothing the CLI printed is lost.
 */
function discoveryFailure(command: string, result: CmdResult): string {
  const output = result.stdout ? `\noutput: ${result.stdout}` : "";
  switch (result.outcome) {
    case "spawn":
      return `\`${command}\` could not be started: ${result.reason}${output}`;
    case "timeout":
      return `\`${command}\` ${result.reason}${output}`;
    case "exit":
      return `\`${command}\` failed: ${result.reason}${output}`;
    default:
      return `\`${command}\` failed${output}`;
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
      "exits (synchronous; the tool call IS the wait). Pass background: true to detach instead: the call " +
      "returns a task handle immediately and the run keeps going - a detached run emits NO " +
      "notifications/progress (an MCP progress notification only belongs to a request that is still in " +
      "flight), so watch_task is the detached run's progress channel. Defaults: mode accept-edits, effort " +
      "medium (a model id " +
      "that already carries its tier, e.g. gemini-3.8-flash-high, overrides that default: its tier wins and no " +
      "--effort is passed for it). The result " +
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
      "the headless run exits (synchronous; the tool call IS the wait). Pass background: true to detach " +
      "instead: the call returns a task handle immediately and the run keeps going - a detached run emits NO " +
      "notifications/progress (an MCP progress notification only belongs to a request that is still in " +
      "flight), so watch_task is the detached run's progress channel. Defaults: mode plan (read-only), " +
      "effort low (a model id that already carries its tier, e.g. gemini-3.8-flash-high, overrides that " +
      "default: its tier wins and no --effort is passed for it); the mode preset is fixed, so callers cannot " +
      "weaken the read-only posture. Produces answers " +
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
      "is in flight (this or any session) to watch the sub-agent work; it is also the progress channel for a " +
      "detached (background: true) run, which never emits notifications/progress. The returned 'running' field " +
      "plus " +
      "'modified' tell a live run from an abandoned one. For a live feed prefer the compact digest: 'steps' " +
      "(a bounded window over the 50 MOST RECENT steps, oldest first - one entry per read/write/run/phase " +
      "with its target, duration and token cost), 'step_count' (the TOTAL number of steps, so " +
      "step_count > steps.length means the digest was clipped), 'phase', " +
      "'elapsed_seconds' and 'usage_latest'. 'content' is the raw transcript tail - read it for detail, not " +
      "for a status display. Once the run ends, the report carries the COMPLETE final result - the durable " +
      "receipt's every field, the same result general_task/explore_task returns, so a failed run reports WHY " +
      "it failed; 'result_ready' says the durable receipt has it.",
    inputSchema: WATCH_INPUT_SCHEMA,
    handler: async (args) => {
      try {
        // The advertised input schema is enforced here, before the watch
        // touches the state dir: a refused call never reads a transcript.
        const invalid = validateArgs(WATCH_INPUT_SCHEMA, args);
        if (invalid) throw new Error(invalid);
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
        // The cancel path above already acted on the in-flight delegation;
        // watchTask only reads the transcript (it has no cancel option).
        return textResult(
          watchTask({
            streamFile,
            tailLines,
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
    description:
      "List model IDs usable for the `model` parameter of delegation tools. The raw `agy models` output is returned in `models` and the parsed IDs in `model_ids` (a line of the CLI output is an id when it contains a TAB; the id is the text before it). A failing `agy models` (missing binary, non-zero exit, timeout) is reported as an error - `isError: true` with an `error` naming the command and the failure - never as a model list.",
    inputSchema: EMPTY_INPUT_SCHEMA,
    handler: async (args) => {
      try {
        // The advertised input schema is enforced here too: the list tools
        // take no arguments, so any key is an unknown argument.
        const invalid = validateArgs(EMPTY_INPUT_SCHEMA, args);
        if (invalid) throw new Error(invalid);
        const result = await runCmd(AGY_BIN, ["models"], 30_000);
        if (result.outcome !== "ok") {
          return textResult({ error: discoveryFailure("agy models", result) }, true);
        }
        const modelIds = parseModelIds(result.stdout);
        const body: Record<string, unknown> = {
          models: result.stdout || "(no output from `agy models`)",
          model_ids: modelIds,
        };
        if (modelIds.length === 0) {
          // Say so instead of leaving the caller with an empty id list and
          // no explanation of why it is empty.
          body.note = result.stdout
            ? "the `agy models` output could not be parsed into model ids (no TAB-separated lines)"
            : "`agy models` produced no output, so it could not be parsed into model ids";
        }
        return textResult(body);
      } catch (err) {
        return textResult({ error: (err as Error).message }, true);
      }
    },
  },
  {
    name: "list_agents",
    title: "List available agy agents",
    description:
      "List agent profiles usable for the `agent` parameter of delegation tools. A failing `agy agents` (missing binary, non-zero exit, timeout) is reported as an error - `isError: true` with an `error` naming the command and the failure - never as an agent list.",
    inputSchema: EMPTY_INPUT_SCHEMA,
    handler: async (args) => {
      try {
        const invalid = validateArgs(EMPTY_INPUT_SCHEMA, args);
        if (invalid) throw new Error(invalid);
        const result = await runCmd(AGY_BIN, ["agents"], 30_000);
        if (result.outcome !== "ok") {
          return textResult({ error: discoveryFailure("agy agents", result) }, true);
        }
        return textResult({
          agents: result.stdout || "(no custom agents configured; default agent will be used)",
        });
      } catch (err) {
        return textResult({ error: (err as Error).message }, true);
      }
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

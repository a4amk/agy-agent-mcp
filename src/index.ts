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
 * any number of delegations may run concurrently; each is an independent child
 * process with its own transcript and result. When the client disconnects, DETACHED
 * (background: true) runs are finished first — the server lingers until they end,
 * writes their receipts and only then exits, so results survive the client —
 * while an abandoned foreground call is killed as before.
 * Run: `npm run build` then
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
  listStreamFiles,
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
  type TaskResult,
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

type JsonRpcId = string | number;

type McpTaskResult = TaskResult & { audit_note?: string };

interface ActiveDelegation {
  tool: string;
  requestId: JsonRpcId;
  taskId?: string;
  streamPath?: string;
  abort?: () => void;
  detached?: boolean;
  promise?: Promise<unknown>;
  cwd?: string;
  sharedTree?: boolean;
  cwdCountDecremented?: boolean;
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
  handler: (args: Args, params: Args, signal?: AbortSignal, entry?: ActiveDelegation) => Promise<ToolResult>;
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
        "When true and the watched task is still running, stop that run immediately (kill the child process and report the run as cancelled).",
    },
    wait: {
      type: "boolean",
      description:
        "When true, wait for the named run to finish and return its complete final result in one call. Opt-in; without it watch_task answers immediately. Cannot be combined with cancel: true, and cannot await a run owned by another server process.",
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
// Concurrent delegations registry + notifications/progress bridge
// ---------------------------------------------------------------------------

const DELEGATION_TOOLS = new Set(["general_task", "explore_task"]);

/**
 * Any number of delegations may run concurrently. In-flight delegations are
 * tracked in a module-level registry keyed by request id so they are visible
 * to the cancellation and drain paths. taskId/streamPath are filled by the
 * runner's onTaskStart hook.
 */
const delegations = new Map<JsonRpcId, ActiveDelegation>();

/**
 * Note attached to a delegation result when another concurrent delegation
 * shared the same working tree during its execution.
 */
const AUDIT_NOTE_SHARED =
  "The working tree was shared with another delegation: files_touched and scope_violations may " +
  "include changes from other concurrent runs and must not be read as this run's alone.";

/**
 * Number of active delegations in flight per resolved task cwd. A delegation
 * whose cwd's counter was ever > 1 while it was running had its tree shared.
 */
const cwdActiveCounts = new Map<string, number>();

function registerDelegationCwd(entry: ActiveDelegation, cwd: string): void {
  entry.cwd = cwd;
  const count = (cwdActiveCounts.get(cwd) ?? 0) + 1;
  cwdActiveCounts.set(cwd, count);
  if (count > 1) {
    entry.sharedTree = true;
    for (const d of delegations.values()) {
      if (d.cwd === cwd) {
        d.sharedTree = true;
      }
    }
  }
}

function decrementCwdCount(entry?: ActiveDelegation): void {
  if (entry?.cwd && !entry.cwdCountDecremented) {
    entry.cwdCountDecremented = true;
    const count = (cwdActiveCounts.get(entry.cwd) ?? 1) - 1;
    if (count <= 0) {
      cwdActiveCounts.delete(entry.cwd);
    } else {
      cwdActiveCounts.set(entry.cwd, count);
    }
  }
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
 * synchronously in finally. The delegation entry was already registered by the
 * dispatcher before this runs.
 */
async function runDelegation(
  args: Args,
  params: Args,
  presets: { mode?: TaskOptions["mode"]; effort?: TaskOptions["effort"] },
  signal?: AbortSignal,
  entry?: ActiveDelegation
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
    // A detached run is the one run that survives a client disconnect: the
    // client is already answered with a handle, so the run is worth
    // finishing. The runner keeps that child out of the disconnect reaping.
    opts.detached = background;
    if (entry) {
      const taskCwd = path.resolve(opts.cwd || process.cwd());
      registerDelegationCwd(entry, taskCwd);
    }
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
    if (entry) {
      entry.taskId = taskId;
      entry.streamPath = streamPath;
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
      if (entry) {
        entry.detached = true;
        entry.promise = runPromise;
      }
      runPromise
        .then((result) => {
          if (bridge) result.progress_bridge = bridge.stats();
          if (entry?.sharedTree) (result as McpTaskResult).audit_note = AUDIT_NOTE_SHARED;
          return result;
        })
        .catch((err) => {
          process.stderr.write(`[${SERVER_NAME}] detached run error: ${(err as Error).message}\n`);
        })
        .finally(() => {
          bridge?.finish();
          if (entry) {
            if (delegations.get(entry.requestId) === entry) {
              delegations.delete(entry.requestId);
            }
            decrementCwdCount(entry);
          }
        });

      if (started.receipt) {
        // A background handle is not a failure: it says "running", so it must
        // not be flagged as an error.
        return textResult(started.receipt);
      }
      const result = await runPromise;
      if (bridge) result.progress_bridge = bridge.stats();
      if (entry?.sharedTree) (result as McpTaskResult).audit_note = AUDIT_NOTE_SHARED;
      return textResult(result, result.status !== "success");
    } catch (err) {
      if (entry) {
        if (delegations.get(entry.requestId) === entry) {
          delegations.delete(entry.requestId);
        }
        decrementCwdCount(entry);
      }
      return textResult({ error: (err as Error).message }, true);
    }
  }

  try {
    const runPromise = runTask(opts);
    if (entry) {
      entry.promise = runPromise;
    }
    const result = await runPromise;
    // The receipt says whether the client asked for progress and how much was
    // streamed, so "the server streamed but the client showed nothing" is
    // distinguishable from "the client never opted in".
    if (bridge) result.progress_bridge = bridge.stats();
    if (entry?.sharedTree) (result as McpTaskResult).audit_note = AUDIT_NOTE_SHARED;
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

/**
 * The notes a `watch_task(cancel: true)` report carries when the cancel could
 * NOT be honoured: either the run is not owned by this process (foreign run),
 * or multiple delegations are in flight and the caller did not specify which
 * run to cancel.
 */
const CANCEL_IGNORED_HINT =
  "The cancel request was IGNORED: the run is still in flight, but it is not owned by this server " +
  "process - another server process started it, and only that process can cancel it (this server " +
  "has no cross-process cancel).";

const CANCEL_AMBIGUOUS_HINT =
  "The cancel request was IGNORED: several delegations are in flight (target is ambiguous) - " +
  "pass stream_file to name the run to cancel.";

const WAIT_FOREIGN_RUN_ERROR =
  "The run is not owned by this process so its completion cannot be awaited here; poll watch_task without wait instead.";

const CANCEL_WAIT_CONFLICT_ERROR =
  "Cannot combine cancel: true and wait: true: cancelling already awaits the target's settlement, so the two together are contradictory and redundant.";

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
    handler: async (args, params, signal, entry) =>
      runDelegation(args, params, { mode: "accept-edits", effort: "medium" }, signal, entry),
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
    handler: async (args, params, signal, entry) =>
      runDelegation(args, params, { mode: "plan", effort: "low" }, signal, entry),
  },
  {
    name: "watch_task",
    title: "Watch live or recent task stream transcript",
    description:
      "Reads the current tail of a task's live stream transcript (a snapshot, not a follow). No args = latest run. Call it while a general_task/explore_task " +
      "is in flight (this or any session) to watch the sub-agent work; it is also the progress channel for a " +
      "detached (background: true) run, which never emits notifications/progress. Pass wait: true to block until " +
      "the run finishes and return its complete result in one call (cannot await a run owned by another server process). " +
      "The returned 'running' field plus " +
      "'modified' tell a live run from an abandoned one. For a live feed prefer the compact digest: 'steps' " +
      "(a bounded window over the 50 MOST RECENT steps, oldest first - one entry per read/write/run/phase " +
      "with its target, duration and token cost), 'step_count' (the TOTAL number of steps, so " +
      "step_count > steps.length means the digest was clipped), 'phase', " +
      "'elapsed_seconds' and 'usage_latest'. 'content' is the raw transcript tail - read it for detail, not " +
      "for a status display. Once the run ends, the report carries the COMPLETE final result - the durable " +
      "receipt's every field, the same result general_task/explore_task returns, so a failed run reports WHY " +
      "it failed; 'result_ready' says the durable receipt has it. 'hint' carries a note for the " +
      "caller when the report needs one - e.g. a cancel that was IGNORED because the run is owned " +
      "by another server process.",
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
        const wait = boolArg(args, "wait") ?? false;

        if (cancel && wait) {
          return textResult({ error: CANCEL_WAIT_CONFLICT_ERROR }, true);
        }

        let targetEntry: ActiveDelegation | undefined;
        if (wait) {
          let targetStreamPath: string | undefined;
          if (streamFile) {
            const resolved = resolveStreamFile(STATE_DIR, streamFile);
            if ("error" in resolved) throw new Error(resolved.error);
            targetStreamPath = resolved.path;
          } else {
            const candidates = listStreamFiles(STATE_DIR);
            if (candidates.length > 0) {
              targetStreamPath = path.join(STATE_DIR, candidates[0]);
            }
          }

          if (targetStreamPath) {
            for (const d of delegations.values()) {
              if (
                d.streamPath === targetStreamPath ||
                d.taskId === streamFile ||
                (d.taskId && targetStreamPath.includes(d.taskId))
              ) {
                targetEntry = d;
                break;
              }
            }
            if (targetEntry?.promise) {
              try {
                await targetEntry.promise;
              } catch {
                /* detached run failure is captured in the receipt on disk */
              }
            }
          }
        }

        // A cancel this process cannot honour must be VISIBLE. The cancel path
        // acts on the in-flight delegations THIS process owns — so a run started
        // by another server process is out of reach, and multiple runs without a
        // stream_file target are ambiguous. `cancelIgnored` records that the request
        // did nothing; the report then says so in its `hint` instead of leaving the
        // caller with a bare `running: true` it cannot act on.
        let cancelIgnored = false;
        let cancelHint: string | undefined;
        let isAmbiguousCancel = false;
        let target: ActiveDelegation | undefined;
        if (cancel) {
          if (streamFile) {
            const resolved = resolveStreamFile(STATE_DIR, streamFile);
            if (!("error" in resolved)) {
              for (const d of delegations.values()) {
                if (
                  d.streamPath === resolved.path ||
                  d.taskId === streamFile ||
                  (d.taskId && resolved.path.includes(d.taskId))
                ) {
                  target = d;
                  break;
                }
              }
            }
            if (!target) {
              cancelIgnored = true;
              cancelHint = CANCEL_IGNORED_HINT;
            }
          } else {
            if (delegations.size === 1) {
              target = delegations.values().next().value;
            } else if (delegations.size > 1) {
              cancelIgnored = true;
              cancelHint = CANCEL_AMBIGUOUS_HINT;
              isAmbiguousCancel = true;
            } else {
              cancelIgnored = true;
              cancelHint = CANCEL_IGNORED_HINT;
            }
          }

          if (target) {
            try {
              target.abort?.();
            } catch {
              /* abort callback error swallowed */
            }
            if (target.promise) {
              try {
                await target.promise;
              } catch {
                /* promise rejection swallowed */
              }
            }
            if (delegations.get(target.requestId) === target) {
              delegations.delete(target.requestId);
            }
            decrementCwdCount(target);
          }
        }
        // F3: When the cancel resolved a target and the caller passed no stream_file,
        // watch the target's transcript (target.streamPath).
        const watchStreamTarget =
          !streamFile && (target?.streamPath ?? targetEntry?.streamPath)
            ? (target?.streamPath ?? targetEntry?.streamPath)
            : streamFile;
        // The cancel path above already acted on the in-flight delegation;
        // watchTask only reads the transcript (it has no cancel option).
        const report = watchTask({
          streamFile: watchStreamTarget,
          tailLines,
        });
        if (wait && report.running === true) {
          return textResult({ error: WAIT_FOREIGN_RUN_ERROR }, true);
        }
        // F6: The ambiguous-cancel hint is always attached when the cancel was ignored
        // for ambiguity (the delegations are still in flight by definition).
        // For the not-owned-by-this-process hint, keep the existing running gate.
        if (isAmbiguousCancel) {
          report.hint = CANCEL_AMBIGUOUS_HINT;
        } else if (cancelIgnored && report.running === true) {
          report.hint = cancelHint ?? CANCEL_IGNORED_HINT;
        }
        return textResult(report);
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
  // Concurrent delegations: every delegation call is accepted and registered
  // under its JSON-RPC request id, while watch_task / list_models /
  // list_agents / ping never touch the registry.
  const isDelegation = DELEGATION_TOOLS.has(name);
  let abortController: AbortController | undefined;
  let entry: ActiveDelegation | undefined;
  if (isDelegation) {
    abortController = new AbortController();
    entry = {
      tool: name,
      requestId: id,
      abort: () => abortController?.abort(),
    };
    delegations.set(id, entry);
    if (delegations.size > 1) {
      process.stderr.write(`[${SERVER_NAME}] ${delegations.size} delegations in flight\n`);
    }
  }
  return tool
    .handler(asObject(params.arguments), params, abortController?.signal, entry)
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
      // Detached runs keep their entry until the run itself ends.
      if (isDelegation && entry && !entry.detached) {
        if (delegations.get(id) === entry) {
          delegations.delete(id);
        }
        decrementCwdCount(entry);
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
    if (typeof reqId === "string" || (typeof reqId === "number" && Number.isInteger(reqId))) {
      const target = delegations.get(reqId);
      if (target) {
        try {
          target.abort?.();
        } catch {
          /* abort callback error swallowed */
        }
      }
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
/** Set once the shutdown path has started: stdin EOF and close both fire it. */
let shutdownStarted = false;

/**
 * Wait for any in-flight DETACHED runs to finish so their receipts are written
 * before the server leaves. A no-op when no detached run is in flight: a
 * foreground call is abandoned instead (its child is killed by
 * shutdownRunner - nobody would read the answer anyway).
 */
async function drainDetachedRun(): Promise<void> {
  const detachedPromises: Promise<unknown>[] = [];
  for (const d of delegations.values()) {
    if (d.detached && d.promise) {
      detachedPromises.push(d.promise);
    }
  }
  if (detachedPromises.length === 0) return;
  try {
    process.stderr.write(
      `[${SERVER_NAME}] client gone: waiting for the detached run to finish so its receipt is written\n`
    );
  } catch {
    /* the client is gone - the log line is a nicety, not a contract */
  }
  try {
    await Promise.allSettled(detachedPromises);
  } catch {
    /* the runs' own failures are recorded in their receipts */
  }
}

/**
 * The client is gone (stdin EOF/close, or a broken stdout pipe). Two cases,
 * and they are different:
 *
 * - a FOREGROUND call is in flight: its answer has no reader any more, so the
 *   call is abandoned - its child is killed right away (it has no reader
 *   either) and the server exits;
 * - a DETACHED run (background: true) is in flight: the client was already
 *   answered with a handle, so the run is worth finishing. The server stays
 *   alive until the run ends and has written its receipt, and only then
 *   exits - the result is then collectable from any client that can see the
 *   state dir.
 *
 * The reaping and the drain are two separate steps: the children WITHOUT a
 * reader (an abandoned foreground call, a hanging discovery command) are
 * reaped first, at once; only the detached delegation's own child is kept
 * alive for the drain.
 *
 * The drain lasts as long as the run does - the run's idle timer resets on
 * every byte it produces, so a productive run can keep the server alive for
 * as long as it runs. SIGINT/SIGTERM is the only escape: that path never
 * waits for the drain, it kills every child (the detached one included) and
 * exits at once, so a drain can never be used to keep the process alive
 * against an operator's signal.
 */
async function shutdownAndExit(code: number): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  // Reap the children that have no reader left - now, not after the drain:
  // an abandoned foreground call and a hanging discovery command.
  await shutdownRunner({ keepDetached: true });
  // Let the detached run finish so its receipt is written.
  await drainDetachedRun();
  // Nothing should be left, but a child that outlived its run is reaped here.
  await shutdownRunner();
  process.exit(code);
}
process.stdin.on("end", () => {
  void shutdownAndExit(0);
});
process.stdin.on("close", () => {
  void shutdownAndExit(0);
});

process.stderr.write(`[${SERVER_NAME}] connected on stdio\n`);

// When the MCP client dies mid-call, responses can arrive on a closed pipe and
// writes surface it as an unhandled EPIPE. Exit quietly — in-flight headless
// run children are killed on the way out; nothing else needs cleanup that the
// next boot's sweep would not do anyway.
process.on("uncaughtException", async (err) => {
  if ((err as NodeJS.ErrnoException)?.code === "EPIPE") {
    // The client's pipe broke - it is gone for good. The SAME path the EOF
    // takes (one guard, one exit code: whichever came first), so a DETACHED
    // run still gets to finish and write its receipt.
    await shutdownAndExit(1);
    return;
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

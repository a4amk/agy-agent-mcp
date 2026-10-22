/**
 * Core runner: runs `agy` CLI prompts headlessly as synchronous delegation.
 *
 * Every task is one non-interactive child process,
 * `agy -p "<prompt>" --output-format stream-json`, spawned from an argv array
 * (no shell). The caller blocks until the child exits — the tool call IS the
 * wait, so there is no task registry, no queue, no tmux, no pane polling and
 * no permission relay. Stream events are mirrored live to a human-readable
 * `.stream` file as lines arrive on stdout. Headless mode auto-denies tool
 * requests that would prompt (reported by the CLI as denied_actions);
 * allow-rules stay owned by the user in their own settings.json.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  unlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const AGY_BIN = process.env.AGY_BIN || "agy";
/** Default idle timeout per run (15m); resets on any child stdout/stderr chunk. 0 disables. */
export const DEFAULT_IDLE_TIMEOUT_MS = intEnv("AGY_MCP_IDLE_TIMEOUT_MS", 900_000);
/** Optional hard wall-clock ceiling per run (0 = disabled), passed to the CLI as --print-timeout. */
export const DEFAULT_PRINT_TIMEOUT_MS = intEnv("AGY_MCP_PRINT_TIMEOUT_MS", 0);
export const ALLOW_AUTO_APPROVE = !boolEnv("AGY_MCP_DENY_AUTO_APPROVE", false);

/** Root dir restriction: when set, all task cwds must live under it. */
export const ROOT = process.env.AGY_MCP_ROOT ? path.resolve(process.env.AGY_MCP_ROOT) : null;

export const STATE_DIR = process.env.AGY_MCP_STATE_DIR || path.join(os.tmpdir(), "agy-agent-mcp", "tasks");

/** Response text is truncated to this size in tool results (tail kept). */
const MAX_RESPONSE_CHARS = 20_000;

/** Non-JSON CLI output (notices, warnings, stderr) retained in the report. */
const MAX_NOTES_CHARS = 4_000;

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v === "1" || v.toLowerCase() === "true";
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskStatus = "success" | "error" | "timeout" | "quota_error";

/**
 * Reasoning effort levels the available agy models actually accept
 * (`agy models` offers low/medium/high only; the CLI rejects anything else
 * with "has no \"xhigh\" effort (available: low, medium, high)").
 */
export const EFFORT_LEVELS = ["low", "medium", "high"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/**
 * Tier suffixes a model id may already carry (e.g. `gemini-3.8-flash-high`).
 * The detection list is wider than EFFORT_LEVELS on purpose: a hypothetical
 * tiered id is still recognized as tier-carrying, while only low/medium/high
 * are accepted effort values.
 */
export const MODEL_TIERS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/**
 * Case-insensitive on purpose: the agy CLI resolves model ids
 * case-insensitively (`--model GEMINI-3.8-FLASH-HIGH` is the same model as
 * `gemini-3.8-flash-high`), so a differently-cased tier suffix is still a
 * tier suffix.
 */
const MODEL_TIER_PATTERN = new RegExp(`-(${MODEL_TIERS.join("|")})$`, "i");

/**
 * The tier a model id already carries ("high" for "gemini-3.8-flash-high" and
 * for "GEMINI-3.8-FLASH-HIGH"), if any. The tier is returned lowercased so it
 * compares directly with the (lowercase-only) effort levels.
 */
export function modelTier(model?: string): ModelTier | undefined {
  if (!model) return undefined;
  const match = MODEL_TIER_PATTERN.exec(model.trim());
  return match ? (match[1].toLowerCase() as ModelTier) : undefined;
}

/** Whether a value is one of the effort levels the CLI accepts. */
export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}

export interface TaskOptions {
  prompt: string;
  cwd?: string;
  conversationId?: string;
  agent?: string;
  model?: string;
  effort?: EffortLevel;
  /**
   * Fixed per tool (general_task: accept-edits, explore_task: plan) and not
   * caller-selectable: a read-only explore_task must stay read-only.
   */
  mode?: "plan" | "accept-edits";
  autoApprove?: boolean;
  sandbox?: boolean;
  addDirs?: string[];
  editScope?: string[];
  project?: string;
  timeoutMs?: number;
  /** OpenCode session ID (`ses_...`) attached by the client in request _meta. */
  sessionID?: string;
  /**
   * True for a DETACHED delegation (`background: true`): the client was
   * already answered with a handle, so the run is worth finishing even if the
   * client goes away. A detached run's child is the ONE child a client
   * disconnect must not kill - the MCP layer drains that run instead (an
   * operator's SIGINT/SIGTERM still kills it).
   */
  detached?: boolean;
  /**
   * Progress-bridge hooks, wired server-side only (never supplied through tool
   * arguments). onTaskStart fires exactly once right after the child spawns and
   * the .stream file exists — before any mirrored line; onStreamLine fires
   * synchronously after each mirrored append (fragments may be partial lines;
   * consumers assemble lines themselves). Absent hooks keep runner behavior
   * byte-identical.
   */
  onTaskStart?: (taskId: string, streamPath: string, transcriptPath?: string) => void;
  onStreamLine?: (text: string) => void;
  getProgressBridge?: () => { token: string | number; notifications: number; mirrored_lines: number };
  signal?: AbortSignal;
}

export interface Task {
  id: string;
  prompt: string;
  cwd: string;
  args: string[];
  autoApproveApplied: boolean;
  transcriptFile: string;
  streamFile: string;
  editScope?: string[];
  filesBefore?: FilesSnapshot;
  opts: TaskOptions;
}

export interface TaskResult {
  /** Unique task identifier (`task_<8-hex-chars>`), naming the transcript files in state dir. */
  task_id: string;
  /** Terminal execution status: `"success"`, `"error"`, `"timeout"`, or `"quota_error"`. */
  status: TaskStatus;
  /** Whether `--dangerously-skip-permissions` was applied to this run. */
  auto_approve_applied: boolean;
  /** Echoed OpenCode session ID (`ses_...`) when provided in request `_meta`. */
  opencode_session_id?: string;
  /** Resumable Antigravity conversation UUID reported by CLI; pass to resume thread. */
  conversation_id?: string;
  /** Echoed task prompt, truncated to 200 characters (`…[truncated N chars]`) if longer. */
  prompt: string;
  /** Resolved working directory where the sub-agent executed. */
  cwd: string;
  /** Final response text, truncated to the last 20,000 characters (`MAX_RESPONSE_CHARS`). */
  response: string;
  /** Present and `true` when response was truncated to the last 20,000 characters. */
  response_truncated?: true;
  /** Duration in seconds from CLI result event, falling back to measured wall-clock seconds. */
  duration_seconds?: number;
  /** Total number of interaction turns completed by the agent, when reported by CLI. */
  num_turns?: number;
  /** Token usage statistics when reported by the CLI result event. */
  usage?: Record<string, unknown>;
  /** Tool actions auto-denied by headless mode because they required prompting. */
  denied_actions?: unknown[];
  /** Process exit code (0 on clean exit, non-zero on failure, null if signalled). */
  exit_code?: number | null;
  /** Error explanation for non-success runs (except quota-only overrides with quota_note). */
  error?: string;
  /** Non-JSON stdout and stderr lines, capped at 4,000 characters (`MAX_NOTES_CHARS`). */
  notes?: string;
  /** Absolute path to the machine-readable `.ndjson` transcript log in state dir. */
  transcript_file: string;
  /** Absolute path to the human-readable `.stream` transcript mirror in state dir. */
  stream_file: string;
  /** Git porcelain diff of modified/created files (capped at 50); git repos only. Shared tree adds audit_note. */
  files_touched?: string[];
  /** Touched files outside requested edit_scope (capped at 50); git repos with edit_scope only. */
  scope_violations?: string[];
  /** Advisory note attached on quota/rate-limit failure advising user notification. */
  quota_note?: string;
  /** Present and `true` on silent success (status success with empty response and no auto-denials). */
  response_empty?: true;
  /** Explanatory note attached when response_empty is true. */
  response_empty_note?: string;
  /** Guidance note on how to resume this conversation using conversation_id. */
  resume_hint?: string;
  /**
   * Present when the client opted into progress (a _meta.progressToken was
   * supplied): how many notifications/progress frames the server wrote and how
   * many transcript lines were mirrored. Filled in by the MCP layer, which owns
   * the bridge; absent for tokenless calls.
   */
  progress_bridge?: { token: string | number; notifications: number; mirrored_lines: number };
}

// ---------------------------------------------------------------------------
// Path validation + edit_scope
// ---------------------------------------------------------------------------

function resolveCwd(cwd?: string): string {
  const resolved = path.resolve(cwd || process.cwd());
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(`cwd does not exist or is not a directory: ${resolved}`);
  }
  if (ROOT && resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) {
    throw new Error(`cwd must be under AGY_MCP_ROOT (${ROOT}), got: ${resolved}`);
  }
  return resolved;
}

/**
 * Resolve and validate orchestrator-supplied edit_scope entries against the
 * task cwd (and AGY_MCP_ROOT when set). Exact cwd is allowed ("whole project");
 * entries escaping cwd or root throw before any child process spawns.
 */
export function resolveEditScope(cwd: string, entries: string[], root: string | null = ROOT): string[] {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("edit_scope must contain at least one path");
  }
  const baseCwd = path.resolve(cwd);
  const baseRoot = root ? path.resolve(root) : null;
  return entries.map((entry) => {
    const trimmed = String(entry).trim();
    if (!trimmed) throw new Error("edit_scope entries must not be empty");
    const resolved = path.resolve(baseCwd, trimmed);
    if (resolved !== baseCwd && !resolved.startsWith(baseCwd + path.sep)) {
      throw new Error(`edit_scope entry escapes task cwd (${baseCwd}): ${entry}`);
    }
    if (baseRoot && resolved !== baseRoot && !resolved.startsWith(baseRoot + path.sep)) {
      throw new Error(`edit_scope entry must be under AGY_MCP_ROOT (${baseRoot}): ${entry}`);
    }
    return resolved;
  });
}

// ---------------------------------------------------------------------------
// Git-based change audit (files_touched / scope_violations)
// ---------------------------------------------------------------------------

/** Bound hashing cost on large files: skip sha256 above 5 MB and fall back to size + mtime. */
const MAX_HASH_FILE_BYTES = 5 * 1024 * 1024;
/** Bound sha256 hashing cost on large dirty sets: at most 500 files and 50 MB total sha256 reads. */
const MAX_HASH_DIRTY_FILES = 500;
const MAX_TOTAL_HASH_BYTES = 50 * 1024 * 1024;

function hashFileContent(filePath: string, fallbackOnly = false): string | null {
  try {
    const st = lstatSync(filePath);
    if (st.isSymbolicLink()) {
      const target = readlinkSync(filePath);
      return `symlink:${target}`;
    }
    if (st.isDirectory()) {
      const gitPath = path.join(filePath, ".git");
      if (existsSync(gitPath)) {
        try {
          const rev = spawnSync("git", ["-C", filePath, "rev-parse", "HEAD"], {
            encoding: "utf8",
            timeout: 2_000,
          });
          if (rev.status === 0 && rev.stdout.trim()) {
            return `submodule:${rev.stdout.trim()}`;
          }
        } catch {
          /* fallback to mtime if git rev-parse fails */
        }
      }
      return `dir:${st.mtimeMs}`;
    }
    if (!st.isFile()) return null;
    if (fallbackOnly || st.size > MAX_HASH_FILE_BYTES) {
      return `fallback:${st.size}:${st.mtimeMs}`;
    }
    const buf = readFileSync(filePath);
    return createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  }
}

export interface FilesSnapshot {
  porcelain: string;
  hashes: Map<string, string | null>;
}

/**
 * If `cwd` is inside a git work tree, capture `git status --porcelain` and
 * content hashes for dirty files before the task spawns. Returns `null` when
 * `cwd` is not a git repo.
 */
export function captureFilesBefore(cwd: string): FilesSnapshot | null {
  try {
    const rev = spawnSync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    if (rev.status !== 0 || rev.stdout.trim() !== "true") return null;
    const st = spawnSync("git", ["-C", cwd, "status", "--porcelain"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    if (st.status !== 0) return null;
    const porcelain = st.stdout;
    const dirty = parsePorcelain(porcelain);
    const hashes = new Map<string, string | null>();
    let hashedBytes = 0;
    let fileCount = 0;
    for (const file of dirty.keys()) {
      const fullPath = path.resolve(cwd, file);
      const fallbackOnly = fileCount >= MAX_HASH_DIRTY_FILES || hashedBytes >= MAX_TOTAL_HASH_BYTES;
      const h = hashFileContent(fullPath, fallbackOnly);
      hashes.set(file, h);
      fileCount++;
      if (
        h &&
        !h.startsWith("fallback:") &&
        !h.startsWith("symlink:") &&
        !h.startsWith("submodule:") &&
        !h.startsWith("dir:")
      ) {
        try {
          hashedBytes += statSync(fullPath).size;
        } catch {
          /* ignore stat error */
        }
      }
    }
    return { porcelain, hashes };
  } catch {
    return null;
  }
}

function parsePorcelain(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of raw.split("\n")) {
    if (line.length < 4) continue;
    const status = line.slice(0, 2);
    let file = line.slice(3).trim();
    const arrow = file.indexOf(" -> ");
    if (arrow >= 0) {
      let oldFile = file.slice(0, arrow).trim();
      let newFile = file.slice(arrow + 4).trim();
      if (oldFile.startsWith('"') && oldFile.endsWith('"')) oldFile = oldFile.slice(1, -1);
      if (newFile.startsWith('"') && newFile.endsWith('"')) newFile = newFile.slice(1, -1);
      if (oldFile) map.set(oldFile, "D ");
      if (newFile) map.set(newFile, status);
      continue;
    }
    if (file.startsWith('"') && file.endsWith('"')) {
      file = file.slice(1, -1);
    }
    if (file) map.set(file, status);
  }
  return map;
}

/**
 * Diff the current `git status --porcelain` and dirty file hashes against
 * `filesBefore` (the snapshot captured by captureFilesBefore before the task
 * spawned). Returns `undefined` when the task cwd is not a git repo (filesBefore null).
 */
export function auditTaskFiles(audit: {
  cwd: string;
  filesBefore?: FilesSnapshot | string | null;
  editScope?: string[];
}): { files_touched: string[]; scope_violations?: string[] } | undefined {
  // A clean pre-task `git status --porcelain` snapshot is the empty string;
  // only null/undefined means "cwd was not a git repo".
  if (audit.filesBefore === null || audit.filesBefore === undefined) return undefined;
  let afterRaw: string;
  try {
    const st = spawnSync("git", ["-C", audit.cwd, "status", "--porcelain"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    if (st.status !== 0) return undefined;
    afterRaw = st.stdout;
  } catch {
    return undefined;
  }
  const beforeRaw = typeof audit.filesBefore === "string" ? audit.filesBefore : audit.filesBefore.porcelain;
  const beforeHashes =
    typeof audit.filesBefore === "string" ? new Map<string, string | null>() : audit.filesBefore.hashes;
  const before = parsePorcelain(beforeRaw);
  const after = parsePorcelain(afterRaw);
  const touched: string[] = [];
  const seen = new Set<string>();

  for (const [file, status] of after.entries()) {
    if (!before.has(file)) {
      touched.push(file);
      seen.add(file);
    } else {
      const beforeHash = beforeHashes.get(file);
      if (beforeHash !== undefined) {
        const fallbackOnly = beforeHash?.startsWith("fallback:") ?? false;
        const afterHash = hashFileContent(path.resolve(audit.cwd, file), fallbackOnly);
        if (beforeHash !== afterHash || before.get(file) !== status) {
          touched.push(file);
          seen.add(file);
        }
      } else if (before.get(file) !== status) {
        touched.push(file);
        seen.add(file);
      }
    }
  }

  for (const file of before.keys()) {
    if (!seen.has(file) && !after.has(file)) {
      touched.push(file);
      seen.add(file);
    }
  }

  const result: { files_touched: string[]; scope_violations?: string[] } = {
    files_touched: touched.slice(0, 50),
  };
  if (audit.editScope && audit.editScope.length > 0) {
    const scopeAbs = audit.editScope.map((entry) => path.resolve(audit.cwd, entry));
    result.scope_violations = touched
      .filter((f) => {
        const abs = path.resolve(audit.cwd, f);
        return !scopeAbs.some((sc) => abs === sc || abs.startsWith(sc + path.sep));
      })
      .slice(0, 50);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Headless run
// ---------------------------------------------------------------------------

/** How long a run may sit silent before the runner kills it (0 = disabled). */
function effectiveIdleTimeoutMs(opts: TaskOptions): number {
  return opts.timeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
}

/**
 * Build the exact argv the server spawns: `-p <prompt> --output-format stream-json`,
 * a flag per set option, and the mode preset. `--print-timeout` reflects the
 * opt-in wall ceiling (`DEFAULT_PRINT_TIMEOUT_MS`, `0s` by default so the CLI
 * waits until completion and the runner's idle timer owns termination).
 */
export function buildArgs(opts: TaskOptions): { args: string[]; autoApproveApplied: boolean } {
  const args = ["-p", opts.prompt, "--output-format", "stream-json"];
  let autoApproveApplied = false;
  // The id-like arguments are trimmed before they reach the CLI: the agy CLI
  // compares them verbatim, so " gemini-3.8-flash " is an unknown model and
  // " reviewer " is an unknown agent. A value that is only whitespace becomes
  // empty and is dropped (there is no such id). The prompt is NOT trimmed
  // (leading whitespace may be meaningful) and cwd is resolved separately.
  const conversationId = opts.conversationId?.trim();
  const agent = opts.agent?.trim();
  const model = opts.model?.trim();
  const project = opts.project?.trim();
  if (conversationId) args.push("--conversation", conversationId);
  if (agent) args.push("--agent", agent);
  if (model) args.push("--model", model);
  if (opts.effort) args.push("--effort", opts.effort);
  if (opts.mode) args.push("--mode", opts.mode);
  if (opts.sandbox) args.push("--sandbox");
  if (opts.autoApprove) {
    if (ALLOW_AUTO_APPROVE) {
      args.push("--dangerously-skip-permissions");
      autoApproveApplied = true;
    }
  }
  for (const d of opts.addDirs ?? []) args.push("--add-dir", d);
  if (project) args.push("--project", project);
  args.push("--print-timeout", `${DEFAULT_PRINT_TIMEOUT_MS / 1000}s`);
  return { args, autoApproveApplied };
}

function tryParseJsonObject(line: string): Record<string, unknown> | null {
  const t = line.trim();
  if (!t.startsWith("{")) return null;
  try {
    const v = JSON.parse(t);
    return isPlainObject(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * A "plain object" for the runner's parsers - the shape a payload must have
 * to be usable (a CLI `result` payload, a durable receipt).
 *
 * An ARRAY is NOT one: `typeof [] === "object"`, so a plain `typeof` check
 * would let an array masquerade as a receipt (and its elements would surface
 * as the numeric keys "0", "1", ...).
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Best-effort append to the `.stream` transcript; returns whether bytes were written. */
function appendStreamText(streamFile: string | undefined, text: string): boolean {
  if (!streamFile || !text) return false;
  try {
    appendFileSync(streamFile, text);
    return true;
  } catch {
    return false; /* stream mirroring is best-effort */
  }
}

const TOOL_LABELS: Record<string, string> = {
  write_file: "Write",
  read_file: "Read",
  view_file: "View",
  replace_file_content: "Edit",
  multi_replace_file_content: "Edit",
  sed_file: "Edit",
  notebook_edit: "Edit",
  run_command: "Run",
  list_dir: "List",
  find_by_name: "Grep",
  grep_search: "Grep",
  search_web: "Web",
  send_message: "Message",
  invoke_subagent: "Subagent",
  browser_subagent: "Subagent",
  define_subagent: "Subagent",
  manage_subagents: "Subagent",
};

function clipStream(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function singleStringValue(obj: Record<string, unknown>): string | undefined {
  const vals = Object.values(obj).filter((v): v is string => typeof v === "string" && v.length > 0);
  return vals.length === 1 ? vals[0] : undefined;
}

const READ_TOOL_LABELS = new Set(["Read", "View", "Grep", "List"]);
const WRITE_TOOL_LABELS = new Set(["Write", "Edit"]);

/**
 * Render the humanized marker (`→ <Label> <target>`, `← <Label> <target>`,
 * `$ <command>`, or `● <name>[ <target>]`) and nested completion
 * (`  ⎿ [<output> · ]done in <dur>s`) strings for a tool `step_update`.
 */
export function renderToolStep(
  su: Record<string, unknown>,
  fallbackLabel?: string
): { label: string; marker: string; done?: string } {
  const toolInfo =
    su.tool_info !== null && typeof su.tool_info === "object" && !Array.isArray(su.tool_info)
      ? (su.tool_info as Record<string, unknown>)
      : null;
  const toolName =
    typeof su.tool_name === "string" && su.tool_name
      ? su.tool_name
      : typeof toolInfo?.name === "string" && toolInfo.name
        ? (toolInfo.name as string)
        : "";
  const label = toolName ? (TOOL_LABELS[toolName] ?? toolName) : (fallbackLabel ?? "tool");

  const params =
    toolInfo?.parameters !== null && typeof toolInfo?.parameters === "object" && !Array.isArray(toolInfo?.parameters)
      ? (toolInfo.parameters as Record<string, unknown>)
      : null;

  let target = "";
  if (params && Object.keys(params).length > 0) {
    if (label === "Run") {
      target =
        firstString(params, ["Command", "command", "cmd", "CommandLine"]) ?? clipStream(JSON.stringify(params), 100);
    } else if (label === "Subagent") {
      const brief =
        firstString(params, [
          "Prompt",
          "prompt",
          "Brief",
          "brief",
          "Task",
          "task",
          "Description",
          "description",
          "text",
          "Role",
          "role",
          "Name",
          "name",
          "Action",
          "action",
        ]) ?? singleStringValue(params);
      target = clipStream(brief ?? JSON.stringify(params), 80);
    } else if (label === "Web") {
      target =
        firstString(params, ["query", "Query", "url", "Url", "URL", "q", "Path", "text"]) ??
        singleStringValue(params) ??
        clipStream(JSON.stringify(params), 100);
    } else if (
      label === "Write" ||
      label === "Read" ||
      label === "View" ||
      label === "Edit" ||
      label === "List" ||
      label === "Grep" ||
      label === "Message"
    ) {
      target =
        firstString(params, [
          "Path",
          "file_path",
          "path",
          "TargetFile",
          "DirectoryPath",
          "SearchPath",
          "SearchDirectory",
          "Query",
          "query",
          "Pattern",
          "pattern",
          "Message",
          "message",
          "text",
          "Recipient",
          "recipient",
        ]) ??
        singleStringValue(params) ??
        clipStream(JSON.stringify(params), 100);
    } else {
      target = clipStream(JSON.stringify(params), 100);
    }
  }

  let marker: string;
  if (READ_TOOL_LABELS.has(label)) {
    marker = target ? `→ ${label} ${target}` : `→ ${label}`;
  } else if (WRITE_TOOL_LABELS.has(label)) {
    marker = target ? `← ${label} ${target}` : `← ${label}`;
  } else if (label === "Run") {
    marker = target ? `$ ${target}` : `● ${label}`;
  } else {
    marker = target ? `● ${label} ${target}` : `● ${label}`;
  }

  let done: string | undefined;
  if (su.state === "DONE") {
    const dur = typeof su.duration_seconds === "number" ? su.duration_seconds : 0;
    const out =
      typeof toolInfo?.output === "string" && toolInfo.output.length > 0
        ? `${clipStream(toolInfo.output, 120)} · `
        : "";
    done = `  ⎿ ${out}done in ${dur}s`;
  }
  return { label, marker, done };
}

/**
 * Why a `result` event counts as "not usable" - the wording is user-visible
 * (it ends up in the run's `error` and in the `.stream` transcript).
 */
const UNUSABLE_RESULT_REASON = 'the CLI printed a result event whose "result" was not an object';

/**
 * Stateful line-by-line parser for `--output-format stream-json` (with
 * backwards-compatible fallback for `--output-format json`).
 *
 * Each complete stdout line is parsed as JSON at most once:
 * - Objects with a string `event` field are stream events: mirrored to
 *   `streamFile` and never accumulated into `noise`. When `event === "result"`,
 *   the inner `result` object becomes the run result candidate (last one wins).
 * - A `result` event whose inner `result` is NOT a plain object is NOT usable:
 *   it never becomes the result candidate, and it must not vanish either - the
 *   raw line goes to `noise` (so it reaches the run's `notes`) and the
 *   transcript carries a trace of it (`unusableResult`).
 * - Other JSON objects are legacy result candidates (last one wins; earlier
 *   superseded candidates fall back into `noise`).
 * - Non-JSON lines go to `noise`.
 */
function createStreamCollector(streamFile?: string, onStreamLine?: (text: string) => void) {
  let json: Record<string, unknown> | null = null;
  const noise: string[] = [];
  /** The raw line of a `result` event the runner could not use (if any). */
  let unusableResult: string | null = null;
  let pendingLegacy: { pos: number; line: string } | null = null;
  let openStepIndex: number | null = null;
  let openToolLabel: string | null = null;
  let midLine = false;

  /**
   * The single choke point for a running task's mirrored transcript appends:
   * every human-readable line the runner renders flows through here, so the
   * `.stream` file and the progress-bridge hook stay in lockstep. The hook
   * fires synchronously in the same event-loop turn as (and only after) a
   * successful file write.
   */
  const mirror = (text: string): void => {
    if (!appendStreamText(streamFile, text)) return;
    onStreamLine?.(text);
  };

  const supersedeLegacy = () => {
    if (pendingLegacy !== null) {
      noise.splice(pendingLegacy.pos, 0, pendingLegacy.line);
      pendingLegacy = null;
    }
  };

  const mirrorEvent = (obj: Record<string, unknown>) => {
    if (!streamFile) return;
    try {
      const ev = obj.event;
      if (ev === "init") {
        const init =
          obj.init !== null && typeof obj.init === "object" && !Array.isArray(obj.init)
            ? (obj.init as Record<string, unknown>)
            : null;
        if (!init) return;
        const cwd = typeof init.cwd === "string" ? init.cwd : "";
        const perm = typeof init.permission_mode === "string" ? init.permission_mode : "";
        const tools = Array.isArray(init.tools) ? init.tools.length : 0;
        mirror(`session open · cwd=${cwd} · permission_mode=${perm} · tools=${tools}\n`);
      } else if (ev === "step_update") {
        const su =
          obj.step_update !== null && typeof obj.step_update === "object" && !Array.isArray(obj.step_update)
            ? (obj.step_update as Record<string, unknown>)
            : null;
        if (!su || typeof su.step_index !== "number") return;
        const idx = su.step_index;
        const stepType = typeof su.step_type === "string" ? su.step_type : "unknown";
        const state = typeof su.state === "string" ? su.state : "";
        const toolRendered = stepType === "tool" ? renderToolStep(su, openToolLabel ?? undefined) : null;

        if (idx !== openStepIndex) {
          const prefix = midLine ? "\n" : "";
          const marker = toolRendered ? toolRendered.marker : `● ${stepType}`;
          mirror(`${prefix}${marker}\n`);
          openStepIndex = idx;
          openToolLabel = toolRendered ? toolRendered.label : null;
          midLine = false;
        }
        if (
          stepType === "agent_response" &&
          openStepIndex === idx &&
          typeof su.text_delta === "string" &&
          su.text_delta.length > 0
        ) {
          mirror(su.text_delta);
          midLine = !su.text_delta.endsWith("\n");
        }
        if (state === "DONE") {
          if (midLine) {
            mirror("\n");
            midLine = false;
          }
          openStepIndex = null;
          openToolLabel = null;
          if (toolRendered?.done) {
            mirror(`${toolRendered.done}\n`);
          } else if (stepType === "agent_response") {
            const dur = typeof su.duration_seconds === "number" ? su.duration_seconds : 0;
            const usage =
              su.usage !== null && typeof su.usage === "object" && !Array.isArray(su.usage)
                ? (su.usage as Record<string, unknown>)
                : null;
            if (usage && typeof usage.total_tokens === "number") {
              const thinking =
                typeof usage.thinking_tokens === "number" && usage.thinking_tokens > 0
                  ? ` · thinking ${usage.thinking_tokens}`
                  : "";
              mirror(`  ⎿ done in ${dur}s · ${usage.total_tokens} tokens${thinking}\n`);
            } else {
              mirror(`  ⎿ done in ${dur}s\n`);
            }
          }
        }
      } else if (ev === "result") {
        const inner = isPlainObject(obj.result) ? obj.result : null;
        if (!inner) {
          // The result event is not usable (its "result" is not an object):
          // leave a trace in the transcript, so a live watcher is not blind.
          // The raw line itself goes to the notes (see pushLine).
          mirror(`${midLine ? "\n" : ""}== result event: unusable (${UNUSABLE_RESULT_REASON})\n`);
          openStepIndex = null;
          openToolLabel = null;
          midLine = false;
          return;
        }
        const prefix = midLine ? "\n" : "";
        const st = typeof inner.status === "string" ? inner.status : "UNKNOWN";
        const dur = typeof inner.duration_seconds === "number" ? inner.duration_seconds : 0;
        mirror(`${prefix}== done: status=${st} · ${dur}s\n`);
        openStepIndex = null;
        openToolLabel = null;
        midLine = false;
      }
    } catch {
      /* malformed stream event: skip mirroring */
    }
  };

  return {
    pushLine(rawLine: string): void {
      const line = rawLine.replace(/\r$/, "");
      if (line.trim() === "") return;
      const obj = tryParseJsonObject(line);
      if (obj === null) {
        noise.push(line);
        return;
      }
      if (typeof obj.event === "string") {
        mirrorEvent(obj);
        if (obj.event === "result") {
          if (isPlainObject(obj.result)) {
            supersedeLegacy();
            json = obj.result;
          } else {
            // A result event the runner cannot use. It must NOT vanish: the
            // raw line goes to the notes (the caller sees exactly what the
            // CLI printed) and the transcript carries a trace of it.
            unusableResult = line;
            noise.push(line);
          }
        }
        return;
      }
      supersedeLegacy();
      pendingLegacy = { pos: noise.length, line };
      json = obj;
    },
    finish(): { json: Record<string, unknown> | null; noise: string[]; unusableResult: string | null } {
      return { json, noise, unusableResult };
    },
  };
}

/**
 * Parse complete stdout text using the same stream/legacy rules as `runTask`.
 *
 * `unusableResult` carries the raw line of a `result` event whose inner
 * `result` was not a plain object (the runner could not use it).
 */
export function parseResultLine(
  stdout: string,
  streamFile?: string
): {
  json: Record<string, unknown> | null;
  noise: string[];
  unusableResult: string | null;
} {
  const collector = createStreamCollector(streamFile);
  for (const line of stdout.split("\n")) {
    collector.pushLine(line);
  }
  return collector.finish();
}

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  const pid = child.pid;
  if (!pid || pid <= 0) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* process already gone */
    }
  }
}

/**
 * The children the runner owns: every spawned `agy` process that is still in
 * flight - a delegation run AND a discovery command (`agy models` /
 * `agy agents`). The value carries the callback that disarms that child's
 * timers, so a shutdown kills the child exactly once, and whether the child
 * belongs to a DETACHED delegation. A detached child is the one child a
 * CLIENT DISCONNECT must leave alone (the MCP layer drains that run instead:
 * the client was already answered with a handle, so the run is worth
 * finishing); every other child - an abandoned foreground call's child, a
 * hanging discovery command - has no reader left and is reaped at once. A
 * child leaves the registry when it settles.
 */
interface OwnedChild {
  /** Disarms that child's timers. */
  clearTimers: () => void;
  /** True when the child belongs to a DETACHED delegation (`background: true`). */
  detached: boolean;
}

const activeChildren = new Map<ChildProcess, OwnedChild>();

/**
 * The names of the actions the CLI auto-denied, as the caller would name them
 * ("command", "read_file", ...). The CLI reports them as objects
 * (`{action, display_name}`); a bare string is accepted too.
 */
function deniedActionNames(denied: unknown[]): string[] {
  const names: string[] = [];
  for (const item of denied) {
    if (typeof item === "string") {
      const name = item.trim();
      if (name) names.push(name);
      continue;
    }
    if (!isPlainObject(item)) continue;
    const action = typeof item.action === "string" ? item.action.trim() : "";
    const display = typeof item.display_name === "string" ? item.display_name.trim() : "";
    const name = action || display;
    if (name) names.push(name);
  }
  return names;
}

/**
 * The reason a blocked run gets. The CLI reaches the same conclusion on its
 * own - it prints "no output produced - a tool required the <x> permission that
 * headless mode cannot prompt for, so it was auto-denied" - but it still
 * reports `status: "SUCCESS"`, so the server has to say it. The fix belongs to
 * the caller: approve the tools for this run (`auto_approve: true`) or allow
 * them in the user's own Antigravity `settings.json`.
 */
function blockedRunMessage(denied: unknown[]): string {
  const names = deniedActionNames(denied);
  const named = names.length > 0 ? ` (${names.join(", ")})` : "";
  const requests = names.length === 1 ? "tool request" : "tool requests";
  const verb = names.length === 1 ? "was" : "were";
  return (
    `the sub-agent was blocked: its ${requests}${named} ${verb} auto-denied because headless mode cannot ` +
    "prompt for permission, so the run produced no output. Re-run with auto_approve: true, or add an " +
    "allow-rule under permissions.allow in your own Antigravity settings.json (e.g. command(<target>))."
  );
}

/**
 * Run one headless delegation to completion. Throws only for caller-caused
 * validation failures (cwd, edit_scope) before anything spawns; every other
 * failure of the run comes back as a TaskResult with an honest status.
 */
export async function runTask(opts: TaskOptions): Promise<TaskResult> {
  const cwd = resolveCwd(opts.cwd);
  const editScope = opts.editScope ? resolveEditScope(cwd, opts.editScope, ROOT) : undefined;
  const filesBefore = captureFilesBefore(cwd);
  const id = `task_${randomUUID().slice(0, 8)}`;
  const { args, autoApproveApplied } = buildArgs(opts);
  const task: Task = {
    id,
    prompt: opts.prompt,
    cwd,
    args,
    autoApproveApplied,
    transcriptFile: path.join(STATE_DIR, `${id}.ndjson`),
    streamFile: path.join(STATE_DIR, `${id}.stream`),
    editScope,
    filesBefore: filesBefore ?? undefined,
    opts,
  };

  mkdirSync(STATE_DIR, { recursive: true });
  try {
    appendFileSync(task.streamFile, "");
  } catch {
    /* stream file creation is best-effort */
  }
  logEvent(task, { event: "task_start", prompt: opts.prompt, cwd, args });

  const idleTimeoutMs = effectiveIdleTimeoutMs(opts);
  const wallTimeoutMs = DEFAULT_PRINT_TIMEOUT_MS;
  const t0 = Date.now();

  if (opts.signal?.aborted) {
    const error = "task was cancelled before execution started";
    logEvent(task, { event: "abort", error });
    const result: TaskResult = {
      task_id: task.id,
      status: "error",
      auto_approve_applied: task.autoApproveApplied,
      opencode_session_id: opts.sessionID,
      prompt: truncate(opts.prompt, 200),
      cwd,
      response: "",
      exit_code: null,
      error,
      transcript_file: task.transcriptFile,
      stream_file: task.streamFile,
    };
    logEvent(task, { event: "task_end", status: result.status, error: result.error });
    logEvent(task, { event: "result", result });
    return result;
  }

  let child: ChildProcess;
  try {
    child = spawn(AGY_BIN, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  } catch (err) {
    const error = `failed to spawn ${AGY_BIN}: ${(err as Error).message}`;
    logEvent(task, { event: "spawn_error", error });
    const result: TaskResult = {
      task_id: task.id,
      status: "error",
      auto_approve_applied: task.autoApproveApplied,
      opencode_session_id: opts.sessionID,
      prompt: truncate(opts.prompt, 200),
      cwd,
      response: "",
      exit_code: null,
      error,
      transcript_file: task.transcriptFile,
      stream_file: task.streamFile,
    };
    logEvent(task, { event: "task_end", status: result.status, error: result.error });
    logEvent(task, { event: "result", result });
    return result;
  }
  logEvent(task, { event: "spawn", code: 0, ms: Date.now() - t0, pid: child.pid });

  let killedKind: "idle" | "wall" | "exit" | "abort" | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let wallTimer: ReturnType<typeof setTimeout> | null = null;
  let sigkillTimer: ReturnType<typeof setTimeout> | null = null;

  const clearTimers = () => {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (wallTimer !== null) {
      clearTimeout(wallTimer);
      wallTimer = null;
    }
    if (sigkillTimer !== null) {
      clearTimeout(sigkillTimer);
      sigkillTimer = null;
    }
  };

  let onAbort: (() => void) | null = null;
  if (opts.signal) {
    onAbort = () => {
      if (killedKind === null) killedKind = "abort";
      clearTimers();
      killProcessGroup(child, "SIGKILL");
    };
    if (opts.signal.aborted) {
      onAbort();
    } else {
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  // Progress bridge start: fired exactly once, before any mirrored line, right
  // after the child spawned and the .stream file exists — the earliest point a
  // caller can associate taskId with streamPath.
  opts.onTaskStart?.(task.id, task.streamFile, task.transcriptFile);

  const triggerKill = (kind: "idle" | "wall", ms: number) => {
    if (killedKind !== null) return;
    killedKind = kind;
    clearTimers();
    logEvent(task, { event: "timeout", kind, timeout_ms: ms, signal: "SIGTERM" });
    killProcessGroup(child, "SIGTERM");
    // Backstop for a child that ignores SIGTERM; a no-op if it already died.
    sigkillTimer = setTimeout(() => killProcessGroup(child, "SIGKILL"), 5_000);
    sigkillTimer.unref?.();
  };

  const resetIdle = () => {
    if (idleTimeoutMs <= 0 || killedKind !== null) return;
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => triggerKill("idle", idleTimeoutMs), idleTimeoutMs);
    idleTimer.unref?.();
  };

  resetIdle();
  if (wallTimeoutMs > 0) {
    wallTimer = setTimeout(() => triggerKill("wall", wallTimeoutMs), wallTimeoutMs);
    wallTimer.unref?.();
  }

  activeChildren.set(child, { clearTimers, detached: opts.detached === true });

  const collector = createStreamCollector(task.streamFile, opts.onStreamLine);
  let stdoutBuf = "";
  let stderr = "";
  const onStdout = (d: Buffer | string) => {
    resetIdle();
    stdoutBuf += d.toString();
    let nl = stdoutBuf.indexOf("\n");
    while (nl >= 0) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      collector.pushLine(line);
      nl = stdoutBuf.indexOf("\n");
    }
  };
  const onStderr = (d: Buffer | string) => {
    resetIdle();
    stderr += d.toString();
  };
  child.stdout?.on("data", onStdout);
  child.stderr?.on("data", onStderr);

  const outcome = await new Promise<{
    exitCode: number | null;
    exitSignal: string | null;
    spawnError?: Error;
  }>((resolve) => {
    let settled = false;
    const done = (o: { exitCode?: number | null; exitSignal?: string | null; spawnError?: Error }) => {
      if (settled) return;
      settled = true;
      clearTimers();
      activeChildren.delete(child);
      if (onAbort && opts.signal) {
        opts.signal.removeEventListener("abort", onAbort);
      }
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      if (killedKind === null) killedKind = "exit";
      resolve({ exitCode: o.exitCode ?? null, exitSignal: o.exitSignal ?? null, spawnError: o.spawnError });
    };
    child.on("error", (err) => done({ spawnError: err }));
    child.on("close", (code, signal) => done({ exitCode: code, exitSignal: signal ?? null }));
    child.on("exit", (code, signal) => {
      // The child is gone: its idle and wall timers describe ITS liveness, so
      // disarm them right now. Marking the run as exited also stops a late
      // chunk from a lingering descendant from re-arming the idle timer
      // (audit A6): without this the idle kill fires during the 2s grace and
      // the finished run is misreported as a timeout.
      if (killedKind === null) killedKind = "exit";
      if (idleTimer !== null) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (wallTimer !== null) {
        clearTimeout(wallTimer);
        wallTimer = null;
      }
      // Print mode is one-shot, but if a descendant ever holds the stdio pipes
      // open, `close` would stall past the real exit — settle shortly after.
      setTimeout(() => {
        if (settled) return;
        child.stdout?.off("data", onStdout);
        child.stderr?.off("data", onStderr);
        child.stdout?.destroy();
        child.stderr?.destroy();
        done({ exitCode: code ?? null, exitSignal: signal ?? null });
      }, 2_000).unref?.();
    });
  });

  logEvent(task, { event: "exit", code: outcome.exitCode, ms: Date.now() - t0 });

  if (stdoutBuf.length > 0) {
    collector.pushLine(stdoutBuf);
    stdoutBuf = "";
  }
  const { json, noise, unusableResult } = collector.finish();
  const stderrLines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const notes =
    [...noise, ...stderrLines].length > 0
      ? truncate([...noise, ...stderrLines].join("\n"), MAX_NOTES_CHARS)
      : undefined;
  // A result event the runner could not use (its "result" was not an object)
  // and no usable result besides it: a JSON line WAS printed, so the failure
  // wording must not claim that there was none.
  const unusableResultEvent = unusableResult !== null && json === null;

  const cliStatus = typeof json?.status === "string" ? (json.status as string).trim().toUpperCase() : "";
  // The CLI's own error message (it rides along in the result event) is the most
  // specific explanation of a failure - it is surfaced verbatim instead of
  // being replaced by a generic process-level message. The process exit code
  // stays in the separate exit_code field.
  const cliError = typeof json?.error === "string" && json.error.trim() !== "" ? (json.error as string) : undefined;
  const rawResponse = typeof json?.response === "string" ? (json.response as string) : "";
  const truncated = rawResponse.length > MAX_RESPONSE_CHARS;

  let status: TaskStatus;
  let error: string | undefined;
  if (outcome.spawnError) {
    status = "error";
    error = `failed to spawn ${AGY_BIN}: ${outcome.spawnError.message}`;
  } else if (killedKind === "idle") {
    status = "timeout";
    error = `child idle for ${idleTimeoutMs}ms; killed (SIGTERM first, SIGKILL after 5s)`;
  } else if (killedKind === "wall") {
    status = "timeout";
    error = `task exceeded hard cap of ${wallTimeoutMs}ms; killed (SIGTERM first, SIGKILL after 5s)`;
  } else if (killedKind === "abort") {
    status = "error";
    error = "task was cancelled";
  } else if (outcome.exitCode === 0 && cliStatus === "SUCCESS") {
    status = "success";
  } else {
    status = "error";
    if (cliError) {
      // Verbatim: the CLI's own words about what went wrong. The process exit
      // code is reported separately (exit_code), never merged into this text.
      error = cliError;
    } else if (outcome.exitCode === 0) {
      // The process exited 0, but this run is a failure - it must never be
      // described as a clean exit ("code 0"). Say what is missing instead.
      if (cliStatus) {
        // The CLI reported a non-SUCCESS status but the process exited 0.
        error = `agy reported status ${cliStatus} and exited 0`;
      } else if (json) {
        // A result event arrived but it carried no usable status.
        error = "agy exited 0 without reporting a result status (the run failed)";
      } else if (unusableResultEvent) {
        // A result event arrived, but it was not usable (its "result" was not
        // an object). It is NOT the same as "no result event": a JSON line was
        // printed, and the raw line is in the notes.
        error = `agy exited 0 but its result event was not usable (the run failed; ${UNUSABLE_RESULT_REASON})`;
      } else {
        // No result event at all.
        error = "agy exited 0 without producing a result event (the run failed; no JSON result line in output)";
      }
    } else {
      const what = outcome.exitCode === null ? `signal ${outcome.exitSignal ?? "unknown"}` : `code ${outcome.exitCode}`;
      error = `agy exited with ${what}${
        json ? "" : unusableResultEvent ? ` (${UNUSABLE_RESULT_REASON})` : " (no JSON result line in output)"
      }`;
    }
  }
  // A CLI error message that arrives together with a server-side cause (a
  // kill, a cancellation) is appended, never dropped: it is the most specific
  // account of what the CLI was doing when the run ended.
  if (cliError && error && status !== "success" && error !== cliError) {
    error = `${error} (agy reported: ${cliError})`;
  }

  const result: TaskResult = {
    task_id: task.id,
    status,
    auto_approve_applied: task.autoApproveApplied,
    opencode_session_id: opts.sessionID,
    prompt: truncate(opts.prompt, 200),
    cwd,
    response: truncated ? rawResponse.slice(-MAX_RESPONSE_CHARS) : rawResponse,
    duration_seconds:
      typeof json?.duration_seconds === "number"
        ? (json.duration_seconds as number)
        : Number(((Date.now() - t0) / 1000).toFixed(1)),
    transcript_file: task.transcriptFile,
    stream_file: task.streamFile,
  };
  if (truncated) result.response_truncated = true;
  if (notes) result.notes = notes;
  if (typeof json?.conversation_id === "string" && json.conversation_id) {
    result.conversation_id = json.conversation_id as string;
  }
  if (typeof json?.num_turns === "number") result.num_turns = json.num_turns as number;
  if (json?.usage && typeof json.usage === "object" && !Array.isArray(json.usage)) {
    result.usage = json.usage as Record<string, unknown>;
  }
  if (Array.isArray(json?.denied_actions)) result.denied_actions = json.denied_actions as unknown[];
  // The process exit code belongs to EVERY final result, not only to the
  // failures: the durable receipt is mirrored in full by watch_task, so a
  // successful run's receipt has to say how the CLI exited (0).
  result.exit_code = outcome.exitCode;
  if (error) result.error = error;

  // Quota upgrade: the same classifier as before, now over error + response +
  // notes (there is no pane to scan). A run that failed or came back empty
  // while showing quota signatures is reported as quota_error.
  const failureText = [result.error, rawResponse, notes].filter(Boolean).join("\n");
  if ((status !== "success" || !rawResponse.trim()) && looksLikeQuotaIssue(failureText)) {
    result.status = "quota_error";
    result.quota_note =
      "The response/error output looks like an Antigravity quota or rate-limit issue (best-effort detection). " +
      "Tell the user; do not silently fall back to other agents unless the user asked for that.";
  }

  // A blocked run is not a success. The CLI reaches the same conclusion on its
  // own - it prints "no output produced - a tool required the <x> permission
  // that headless mode cannot prompt for, so it was auto-denied" - but it still
  // reports status: "SUCCESS", so the server would hand the caller a success
  // with an empty response. The gate is the CLI's OWN condition: a non-empty
  // denied_actions AND an empty response. A run that produced a response (the
  // agent worked around the denial) and a run that produced no response
  // without any denial stay successes.
  //
  // It runs AFTER the quota upgrade, so a quota failure keeps its quota_error.
  if (
    result.status === "success" &&
    Array.isArray(result.denied_actions) &&
    result.denied_actions.length > 0 &&
    !rawResponse.trim()
  ) {
    result.status = "error";
    result.error = blockedRunMessage(result.denied_actions);
  }

  if (result.status === "success" && !rawResponse.trim()) {
    result.response_empty = true;
    result.response_empty_note =
      "The sub-agent finished without a text response. Check denied_actions, files_touched and notes " +
      "(the transcript has the full event log) before drawing conclusions.";
  }
  if (result.conversation_id) {
    result.resume_hint = "Pass this conversation_id to general_task/explore_task to continue this conversation.";
  }

  const audit = auditTaskFiles({ cwd, filesBefore, editScope });
  if (audit) {
    logEvent(task, { event: "audit", ...audit });
    result.files_touched = audit.files_touched;
    if (audit.scope_violations) result.scope_violations = audit.scope_violations;
  }

  if (opts.getProgressBridge) {
    result.progress_bridge = opts.getProgressBridge();
  }
  if (killedKind === "abort") {
    appendStreamText(task.streamFile, `== done: status=CANCELLED · ${result.duration_seconds ?? 0}s\n`);
  }

  logEvent(task, { event: "task_end", status: result.status, error: result.error });
  logEvent(task, { event: "result", result });
  return result;
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  const pid = child.pid;
  if (pid && pid > 0) {
    try {
      process.kill(pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "ESRCH") return Promise.resolve(true);
    }
  }
  return new Promise<boolean>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      child.off("exit", onDone);
      child.off("close", onDone);
    };
    const onDone = () => {
      cleanup();
      resolve(true);
    };
    timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    child.once("exit", onDone);
    child.once("close", onDone);
  });
}

let shutdownPromise: Promise<{ killed: number }> | null = null;

/**
 * Server shutdown policy, invoked on SIGINT/SIGTERM (and before EPIPE exits):
 * kill still-running headless task children AND still-running discovery
 * children. A headless child is a one-shot process - there is no pane a human
 * could attach to, so leaving one behind would only orphan model usage in the
 * background.
 *
 * `keepDetached` leaves the child of a DETACHED delegation alone: on a client
 * disconnect the MCP layer drains that run (the client was already answered
 * with a handle, so the run is worth finishing), while every other child - an
 * abandoned foreground call's child, a hanging discovery command - has no
 * reader left and is reaped at once. Without the option EVERY child is
 * killed, which is what an operator's SIGINT/SIGTERM must do (a drain must
 * never be a way to keep the process alive against a signal).
 */
export async function shutdownRunner(options: { keepDetached?: boolean } = {}): Promise<{ killed: number }> {
  if (options.keepDetached) {
    // Deliberately NOT memoized: an in-flight disconnect shutdown must never
    // swallow a concurrent "kill everything" (an operator's signal arriving
    // while the drain runs).
    return reapChildren({ keepDetached: true });
  }
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    try {
      return await reapChildren({ keepDetached: false });
    } finally {
      shutdownPromise = null;
    }
  })();
  return shutdownPromise;
}

/**
 * Kill the in-flight children (SIGTERM, then SIGKILL after 1.5s) and report
 * how many were killed. With `keepDetached`, the child of a DETACHED
 * delegation stays running - the caller drains that run instead.
 */
async function reapChildren(options: { keepDetached: boolean }): Promise<{ killed: number }> {
  const entries = Array.from(activeChildren.entries());
  let killedCount = 0;
  await Promise.all(
    entries.map(async ([child, owned]) => {
      // The one exemption: the detached delegation's own child - the caller
      // drains that run, so killing it here would lose the result.
      if (options.keepDetached && owned.detached) return;
      owned.clearTimers();
      activeChildren.delete(child);
      killedCount++;
      killProcessGroup(child, "SIGTERM");
      const exited = await waitForChildExit(child, 1_500);
      if (!exited) {
        killProcessGroup(child, "SIGKILL");
        await waitForChildExit(child, 500);
      }
    })
  );
  if (killedCount > 0) {
    console.error(`[agy-agent-mcp] shutdown: killed ${killedCount} in-flight child process(es)`);
  }
  return { killed: killedCount };
}

/** Patterns that indicate the CLI was blocked by Antigravity quota/rate limits. */
const QUOTA_PATTERNS = [
  /quota/i,
  /rate.?limit/i,
  /\b429\b/,
  /resource.?exhaust/i,
  /credit/i,
  /billing/i,
  /usage.?limit/i,
  /daily.?limit/i,
  /fast.?forward/i,
  /model.?capacity/i,
];

/** Best-effort detection of Antigravity quota / rate-limit failures. */
export function looksLikeQuotaIssue(text: string): boolean {
  if (!text) return false;
  return QUOTA_PATTERNS.some((p) => p.test(text));
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…[truncated ${s.length - max} chars]`;
}

export function logEvent(task: Task, evt: unknown): void {
  try {
    appendFileSync(task.transcriptFile, `${JSON.stringify({ ts: Date.now(), ...(evt as object) })}\n`);
  } catch {
    /* transcript writing is best-effort */
  }
}

// ---------------------------------------------------------------------------
// Startup sweep of stale task logs
// ---------------------------------------------------------------------------

/**
 * Task event logs (.ndjson) and live stream transcripts (.stream) older than
 * this many days are swept from the state directory at startup. 0 disables the
 * sweep.
 */
export const RETENTION_DAYS = (() => {
  const v = Number(process.env.AGY_MCP_RETENTION_DAYS);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 7;
})();

/** Best-effort startup sweep of stale task event and stream logs. */
export function sweepStateDir(): void {
  if (RETENTION_DAYS <= 0 || !existsSync(STATE_DIR)) return;
  const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
  let removed = 0;
  for (const name of readdirSync(STATE_DIR)) {
    if (!/^task_.+\.(ndjson|stream)$/.test(name)) continue;
    const file = path.join(STATE_DIR, name);
    try {
      if (statSync(file).mtimeMs < cutoff) {
        unlinkSync(file);
        removed++;
      }
    } catch {
      /* per-file best effort */
    }
  }
  if (removed > 0) {
    console.error(`[agy-agent-mcp] swept ${removed} task log(s) older than ${RETENTION_DAYS}d from ${STATE_DIR}`);
  }
}

// ---------------------------------------------------------------------------
// Live stream viewer (watch_task)
// ---------------------------------------------------------------------------

const MAX_STREAM_CHARS = 200_000;
const DEFAULT_TAIL_LINES = 400;

/**
 * The digest is a BOUNDED window over the most recent steps: a long run
 * (hundreds of steps) must not cost the caller a huge report on every poll.
 * `step_count` keeps reporting the TOTAL number of steps, so the truncation
 * is self-evident (`step_count > steps.length`) - exactly as `content` /
 * `content_len` already signal the raw tail's clipping. No extra field is
 * needed to say it.
 */
const MAX_DIGEST_STEPS = 50;

/**
 * The watch report: the watch-specific view of a run (liveness, transcript
 * tail, compact digest) PLUS the COMPLETE final result once the run ended.
 *
 * The result part is `Partial<TaskResult>` on purpose: the durable receipt is
 * merged in WHOLE (see readStreamTail), so every field of the final result is
 * carried - including the ones that explain a failure (`error`, `notes`,
 * `exit_code`, `quota_note`, `denied_actions`). A field added to TaskResult
 * later is carried automatically instead of needing a second edit here.
 */
export interface WatchTaskReport extends Partial<TaskResult> {
  found: boolean;
  file?: string;
  bytes?: number;
  modified?: string;
  running?: boolean;
  finished?: boolean;
  /**
   * True once the durable receipt (task_<id>.ndjson) carries the final result.
   * The stream's "== done:" line appears when the CLI finishes, which is
   * slightly BEFORE the server writes the receipt (it audits the file scope
   * first) - so poll on result_ready, not on finished, to get the result.
   */
  result_ready?: boolean;
  /**
   * Compact digest of the run so far: one entry per step, not a text dump.
   * BOUNDED: it holds the most recent steps only (at most `MAX_DIGEST_STEPS`,
   * oldest -> newest inside the window), so a long run does not blow up the
   * report.
   */
  steps?: DigestStep[];
  /** The TOTAL number of steps of the run - larger than steps.length when the digest was clipped. */
  step_count?: number;
  /** The last phase marker seen in the transcript (e.g. "agent_response"). */
  phase?: string;
  /** Total run duration, once the transcript carries the "== done:" line. */
  elapsed_seconds?: number;
  /** Token usage reported by the most recent completed step. */
  usage_latest?: { total_tokens?: number; thinking_tokens?: number };
  clipped?: true;
  content?: string;
  content_len?: number;
  hint?: string;
  candidates?: string[];
}

/**
 * Every report key that is NOT a result field - i.e. the names the watch
 * report OWNS. The watcher computes them itself, and they are never taken
 * from the durable receipt.
 */
export type WatchOwnedField = Exclude<keyof WatchTaskReport, keyof TaskResult>;

/**
 * The watch-owned field names, as the single source of truth for the merge
 * rule: the receipt is stripped of exactly these names before it is merged
 * into the report, so a receipt can never overwrite a watch field - not even
 * one the watcher sets only conditionally (`phase`, `elapsed_seconds`,
 * `usage_latest`, `clipped`, `hint`, `candidates`), which stay ABSENT when
 * the transcript does not carry them.
 */
export const WATCH_OWN_FIELDS = [
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
  "clipped",
  "hint",
  "candidates",
] as const satisfies readonly WatchOwnedField[];

/**
 * Compile-time proof that WATCH_OWN_FIELDS lists EVERY watch-owned field: a
 * watch field added to the report without adding it to the constant makes
 * this type resolve to `never` and the line below stops compiling.
 */
export type WatchFieldsComplete =
  Exclude<WatchOwnedField, (typeof WATCH_OWN_FIELDS)[number]> extends never ? true : never;

export const WATCH_OWN_FIELDS_COMPLETE: WatchFieldsComplete = true;

/**
 * List `task_<id>.stream` file names in `stateDir` sorted most-recent-first
 * by mtime.
 */
export function listStreamFiles(stateDir: string = STATE_DIR): string[] {
  if (!existsSync(stateDir)) return [];
  const entries: Array<{ name: string; mtimeMs: number }> = [];
  for (const name of readdirSync(stateDir)) {
    if (!/^task_.+\.stream$/.test(name)) continue;
    try {
      const st = statSync(path.join(stateDir, name));
      if (st.isFile()) {
        entries.push({ name, mtimeMs: st.mtimeMs });
      }
    } catch {
      /* file may disappear concurrently */
    }
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
  return entries.map((e) => e.name);
}

/**
 * Resolve a caller-supplied `stream_file` handle (an absolute path under
 * `stateDir`, a bare `task_<id>.stream` name, or a task ID like `task_<id>` /
 * `<id>`) into a contained absolute `.stream` path. Rejects paths escaping
 * `stateDir`. When the `.stream` file is missing on disk but a twin `.ndjson`
 * log exists for that task ID, attaches a `hint` naming the `.ndjson` twin.
 */
export function resolveStreamFile(
  stateDir: string,
  streamFile: string
): { path: string; hint?: string } | { error: string } {
  const baseDir = path.resolve(stateDir);
  const raw = String(streamFile ?? "").trim();
  if (!raw) {
    return { error: "stream_file must not be empty" };
  }

  let candidate: string;
  if (raw.includes("/") || raw.includes("\\") || raw === "." || raw === "..") {
    candidate = raw;
  } else if (raw.endsWith(".stream")) {
    candidate = raw.startsWith("task_") ? raw : `task_${raw}`;
  } else if (raw.endsWith(".ndjson")) {
    return { error: `stream_file must target a .stream transcript (not .ndjson): ${streamFile}` };
  } else {
    const idPart = raw.startsWith("task_") ? raw : `task_${raw}`;
    candidate = `${idPart}.stream`;
  }

  const resolved = path.resolve(baseDir, candidate);
  if (!resolved.startsWith(baseDir + path.sep) || path.dirname(resolved) !== baseDir) {
    return { error: `stream_file escapes state directory (${baseDir}): ${streamFile}` };
  }
  const baseName = path.basename(resolved);
  if (!/^task_.+\.stream$/.test(baseName)) {
    return { error: `stream_file must be a task_<id>.stream file under ${baseDir}: ${streamFile}` };
  }

  const ndjsonTwin = resolved.replace(/\.stream$/, ".ndjson");
  if (!existsSync(resolved) && existsSync(ndjsonTwin)) {
    const taskId = baseName.slice(0, -".stream".length);
    return {
      path: resolved,
      hint: `No .stream transcript found for ${taskId}, but its machine transcript exists: ${ndjsonTwin}`,
    };
  }
  return { path: resolved };
}

/**
 * Read the final TaskResult from a .ndjson receipt if present.
 *
 * Only a PLAIN OBJECT counts as a receipt: `typeof [] === "object"`, so an
 * array (or any other non-object) would otherwise be accepted and its
 * elements would surface in the watch report as the numeric keys "0", "1", …
 */
export function readNdjsonResult(ndjsonPath: string): TaskResult | null {
  if (!existsSync(ndjsonPath)) return null;
  try {
    const raw = readFileSync(ndjsonPath, "utf8");
    const lines = raw.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]?.trim();
      if (!line) continue;
      const parsed = tryParseJsonObject(line);
      if (parsed && parsed.event === "result" && isPlainObject(parsed.result)) {
        return parsed.result as unknown as TaskResult;
      }
    }
  } catch {
    /* receipt read is best-effort */
  }
  return null;
}

/**
 * Read the tail of a `.stream` file (`tailLines` = 0 returns all lines),
 * cap the returned content at `charLimit` characters from the newest end, and
 * classify `finished` / `running` by the presence of a `== done:` line.
 */
export function readStreamTail(
  filePath: string,
  tailLines: number = DEFAULT_TAIL_LINES,
  charLimit: number = MAX_STREAM_CHARS
): WatchTaskReport {
  let st: ReturnType<typeof statSync>;
  let raw: string;
  try {
    st = statSync(filePath);
    if (!st.isFile()) return { found: false, file: filePath };
    raw = readFileSync(filePath, "utf8");
  } catch {
    return { found: false, file: filePath };
  }

  const normalized = raw.replace(/\r\n/g, "\n");
  const body = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  const lines = body.length === 0 ? [] : body.split("\n");
  const ndjsonPath = filePath.replace(/\.stream$/, ".ndjson");
  const receipt = readNdjsonResult(ndjsonPath);
  const finished = lines.some((l) => l.startsWith("== done:")) || receipt !== null;
  const running = !finished;

  let clipped = false;
  let selected = lines;
  if (tailLines > 0 && lines.length > tailLines) {
    selected = lines.slice(-tailLines);
    clipped = true;
  }

  let content = selected.join("\n");
  if (clipped) {
    content = `…\n${content}`;
  }
  if (charLimit > 0 && content.length > charLimit) {
    clipped = true;
    const bodyAfterPrefix = content.startsWith("…\n") ? content.slice(2) : content;
    content = charLimit > 2 ? `…\n${bodyAfterPrefix.slice(-(charLimit - 2))}` : bodyAfterPrefix.slice(-charLimit);
  }

  const watchFields: WatchTaskReport = {
    found: true,
    file: filePath,
    bytes: st.size,
    modified: st.mtime.toISOString(),
    running,
    finished,
    result_ready: receipt !== null,
    content,
    content_len: content.length,
  };
  // The compact digest: one entry per step, so a watching client renders a
  // feed instead of dumping the raw transcript. The feed is a BOUNDED window
  // over the MOST RECENT steps (oldest -> newest inside the window): the
  // digest must not grow with the length of the run, or every poll of a long
  // run would cost the caller a lot for what should be a status check.
  // `step_count` keeps the TOTAL, so the clipping is self-evident.
  const digest = buildDigest(lines);
  watchFields.steps = digest.steps.slice(-MAX_DIGEST_STEPS);
  watchFields.step_count = digest.step_count;
  if (digest.phase) watchFields.phase = digest.phase;
  if (digest.elapsed_seconds !== undefined) watchFields.elapsed_seconds = digest.elapsed_seconds;
  if (digest.usage_latest) watchFields.usage_latest = digest.usage_latest;
  if (clipped) watchFields.clipped = true;

  if (finished && receipt) {
    // The durable receipt IS the complete final result: merge EVERY field of
    // it into the report, so a failed run says WHY it failed (error, notes,
    // exit_code, quota_note, denied_actions, ...) instead of only its status.
    //
    // The watch-owned names are the watcher's own, so they are stripped from
    // the receipt FIRST: a receipt (a tampered or foreign one) can never
    // overwrite them - not even the conditionally-set ones (phase,
    // elapsed_seconds, usage_latest, clipped, hint, candidates), which stay
    // absent when the transcript does not carry them.
    const resultFields: Record<string, unknown> = { ...receipt };
    for (const key of WATCH_OWN_FIELDS) delete resultFields[key];
    return { ...resultFields, ...watchFields };
  }
  // Still running: there is no receipt yet, so the report carries no result
  // fields at all.
  return watchFields;
}

/**
 * One compact step of a run, parsed out of the human-readable transcript:
 * what the sub-agent did, what it touched, how long it took and what it
 * cost. This is the digest a watching client renders - the raw transcript
 * stays available as `content`.
 */
export interface DigestStep {
  /** read (a file read), write (a file edit), run (a command), phase (a turn). */
  kind: "read" | "write" | "run" | "phase";
  /** The tool or phase label, e.g. "Read", "agent_response". */
  label?: string;
  /** What was touched or executed, when the step names one. */
  target?: string;
  dur_seconds?: number;
  /** Short excerpt of the step output, when there was any. */
  output?: string;
  total_tokens?: number;
  thinking_tokens?: number;
}

const DIGEST_OUTPUT_CHARS = 120;

/**
 * Parse the mirrored transcript into a compact step list. The runner renders
 * one line per event: "→ Read <path>" / "← Write <path>" / "$ <command>" /
 * "● <phase>", each followed by a "⎿ …done in <dur>s" completion line that
 * carries the output excerpt and the token usage.
 */
export function buildDigest(lines: string[]): {
  steps: DigestStep[];
  step_count: number;
  phase?: string;
  elapsed_seconds?: number;
  usage_latest?: { total_tokens?: number; thinking_tokens?: number };
} {
  const steps: DigestStep[] = [];
  let pending: DigestStep | null = null;
  let phase: string | undefined;
  let elapsed_seconds: number | undefined;
  let usage_latest: { total_tokens?: number; thinking_tokens?: number } | undefined;

  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("→ ") || line.startsWith("← ")) {
      const kind = line.startsWith("→ ") ? "read" : "write";
      const rest = line.slice(2).trim();
      const sp = rest.indexOf(" ");
      pending = {
        kind,
        label: sp > 0 ? rest.slice(0, sp) : rest,
        ...(sp > 0 ? { target: rest.slice(sp + 1).trim() } : {}),
      };
      continue;
    }
    if (line.startsWith("$ ")) {
      pending = { kind: "run", target: line.slice(2).trim() };
      continue;
    }
    if (line.startsWith("● ")) {
      const rest = line.slice(2).trim();
      const sp = rest.indexOf(" ");
      const label = sp > 0 ? rest.slice(0, sp) : rest;
      phase = label;
      pending = { kind: "phase", label, ...(sp > 0 ? { target: rest.slice(sp + 1).trim() } : {}) };
      continue;
    }
    if (line.startsWith("== done:")) {
      const dur = line.match(/·\s*([\d.]+)s/);
      if (dur) elapsed_seconds = Number(dur[1]);
      continue;
    }
    if (line.trimStart().startsWith("⎿") && pending) {
      const dur = line.match(/done in ([\d.]+)s/);
      const tokens = line.match(/·\s*(\d+)\s*tokens/);
      const thinking = line.match(/thinking\s+(\d+)/);
      const output = line
        .replace(/^[\s⎿]+/, "")
        .replace(/\s*·?\s*done in [\d.]+s.*$/, "")
        .trim();
      if (dur) pending.dur_seconds = Number(dur[1]);
      if (tokens) pending.total_tokens = Number(tokens[1]);
      if (thinking) pending.thinking_tokens = Number(thinking[1]);
      if (output) pending.output = output.slice(0, DIGEST_OUTPUT_CHARS);
      if (pending.total_tokens !== undefined || pending.thinking_tokens !== undefined) {
        usage_latest = {
          ...(pending.total_tokens !== undefined ? { total_tokens: pending.total_tokens } : {}),
          ...(pending.thinking_tokens !== undefined ? { thinking_tokens: pending.thinking_tokens } : {}),
        };
      }
      steps.push(pending);
      pending = null;
    }
  }
  return {
    steps,
    step_count: steps.length,
    ...(phase ? { phase } : {}),
    ...(elapsed_seconds !== undefined ? { elapsed_seconds } : {}),
    ...(usage_latest ? { usage_latest } : {}),
  };
}

/**
 * High-level `watch_task` reader: picks the latest `.stream` file when
 * `streamFile` is omitted, or resolves `streamFile` within `stateDir`. Throws
 * only on path-validation errors (escaping paths).
 *
 * It only READS. The cancel path lives in the MCP layer (`src/index.ts`),
 * which owns the in-flight delegation it can stop; the runner cannot see that
 * state, so it has no cancel option.
 */
export function watchTask(opts?: { streamFile?: string; tailLines?: number; stateDir?: string }): WatchTaskReport {
  const stateDir = path.resolve(opts?.stateDir ?? STATE_DIR);
  const tailLines = opts?.tailLines ?? DEFAULT_TAIL_LINES;
  const candidates = listStreamFiles(stateDir).slice(0, 5);

  if (!opts?.streamFile) {
    if (candidates.length === 0) {
      return { found: false, candidates: [] };
    }
    const target = path.join(stateDir, candidates[0]);
    const report = readStreamTail(target, tailLines, MAX_STREAM_CHARS);
    if (!report.found) {
      return { found: false, candidates };
    }
    return report;
  }

  const resolved = resolveStreamFile(stateDir, opts.streamFile);
  if ("error" in resolved) {
    throw new Error(resolved.error);
  }
  const report = readStreamTail(resolved.path, tailLines, MAX_STREAM_CHARS);
  if (!report.found) {
    const miss: WatchTaskReport = {
      found: false,
      file: resolved.path,
      candidates,
    };
    if (resolved.hint) miss.hint = resolved.hint;
    return miss;
  }
  return report;
}

// ---------------------------------------------------------------------------
// One-shot helper commands (list models / agents)
// ---------------------------------------------------------------------------

/**
 * How a helper command ended. The three failure modes mean different things
 * to a caller, so they are never collapsed into one another: "spawn" = the
 * command could not be started at all (e.g. a missing binary), "exit" = it
 * ran and exited non-zero, "timeout" = it never finished.
 */
export type CmdOutcome = "ok" | "spawn" | "exit" | "timeout";

/** The result of one helper command: its exit code, its combined output and how it ended. */
export interface CmdResult {
  /** Process exit code; null when the process never ran or was killed before it could report one. */
  code: number | null;
  /** Combined stdout + stderr of the command, trimmed. */
  stdout: string;
  /** "ok" when the command succeeded; the failure mode otherwise. */
  outcome: CmdOutcome;
  /** Failure detail: the spawn error, the timeout limit, or the exit code / signal. */
  reason: string;
}

/**
 * Spawn a helper command and collect its combined output. Only used for
 * discovery (`agy models` / `agy agents`), never for delegation runs.
 *
 * The outcome is reported, never swallowed: a caller can tell a missing
 * binary from a non-zero exit from a timeout, and the captured output is
 * carried along so a failure is not dressed up as a result.
 *
 * The child joins the runner's child registry (`activeChildren`), so a
 * shutdown - the MCP client disconnecting, SIGINT or SIGTERM - reaps it
 * (SIGTERM, then SIGKILL) exactly like a delegation child instead of leaving
 * a hanging `agy models` orphaned; it leaves the registry when it settles.
 */
export function runCmd(bin: string, args: string[], timeoutMs = 10_000): Promise<CmdResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      // Detached, like a delegation child: the child leads its own process
      // group, so shutdownRunner's group kill reaches it and its descendants.
      child = spawn(bin, args, { env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch (err) {
      resolve({ code: null, stdout: "", outcome: "spawn", reason: `${bin}: ${(err as Error).message}` });
      return;
    }
    let out = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (out += d.toString()));
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clearTimer = () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
    const settle = (result: CmdResult) => {
      if (settled) return;
      settled = true;
      clearTimer();
      // The child is done with the runner's registry: it must not be reaped
      // twice (and must not be counted as in-flight) after it settled.
      activeChildren.delete(child);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(result);
    };
    const timedOut = (): CmdResult => ({
      code: null,
      stdout: out.trim(),
      outcome: "timeout",
      reason: `timed out after ${timeoutMs} ms`,
    });
    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* child already gone */
      }
      // A timeout is reported as a timeout, not as an exit code: the old
      // `code ?? 127` made it indistinguishable from a missing binary.
      settle(timedOut());
    }, timeoutMs);
    timer.unref?.();
    // Registered before the child can settle: shutdownRunner reaps every
    // registered child (SIGTERM, then SIGKILL after 1.5s). A discovery child
    // is never detached: it has no reader, so a client disconnect reaps it.
    activeChildren.set(child, { clearTimers: clearTimer, detached: false });
    const done = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      const text = out.trim();
      if (code === 0) {
        settle({ code: 0, stdout: text, outcome: "ok", reason: "" });
        return;
      }
      settle({
        code,
        stdout: text,
        outcome: "exit",
        reason:
          code !== null ? `exited with code ${code}` : `terminated by signal ${signal ?? "unknown"} (no exit code)`,
      });
    };
    child.on("error", (err) => {
      // The command could not be started (e.g. ENOENT): no exit code at all.
      settle({ code: null, stdout: out.trim(), outcome: "spawn", reason: `${bin}: ${err.message}` });
    });
    child.on("close", (code, signal) => done(code, signal));
    child.on("exit", (code, signal) => {
      setTimeout(() => done(code, signal), 2_000).unref?.();
    });
  });
}

/**
 * Parse the model ids out of `agy models` output. A line yields an id when it
 * contains a TAB (the id is the text before the first TAB); a line without a
 * TAB - e.g. the "Fetching available models..." header - is not an id.
 */
export function parseModelIds(output: string): string[] {
  const ids: string[] = [];
  for (const line of output.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const id = line.slice(0, tab).trim();
    if (id) ids.push(id);
  }
  return ids;
}

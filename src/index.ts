/**
 * agy-agent-mcp: MCP server exposing the Google Antigravity (`agy`) CLI as
 * subagent-style delegation tools.
 *
 * Run: `npm run build` then `node dist/index.js` (bin/mcp.mjs wraps this;
 * npm installs need compiled JavaScript — Node won't type-strip under
 * node_modules).
 */
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
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

const server = new McpServer({
  name: SERVER_NAME,
  version: SERVER_VERSION,
});

// ---------------------------------------------------------------------------
// Shared schema fragments
// ---------------------------------------------------------------------------

const cwdField = z
  .string()
  .optional()
  .describe(
    "Working directory for the delegated task (project the sub-agent operates on). " +
      `Defaults to the server's cwd${ROOT ? `. Must be under AGY_MCP_ROOT: ${ROOT}` : ""}.`
  );

const modelField = z
  .string()
  .optional()
  .describe("Model for the task, e.g. gemini-3.8-flash-medium, claude-opus-5-5-high (see list_models)");

const agentField = z.string().optional().describe("Antigravity agent profile to use (see list_agents)");

const effortField = z
  .enum(["low", "medium", "high", "xhigh", "max"])
  .optional()
  .describe("Reasoning effort for the task");

const autoApproveField = z
  .boolean()
  .optional()
  .describe(
    "Expert switch: pass --dangerously-skip-permissions so headless runs stop auto-denying gated tools. " +
      "Pair it with sandbox when granting it. " +
      (ALLOW_AUTO_APPROVE
        ? "Allowed by this server."
        : "DISABLED on this server (AGY_MCP_DENY_AUTO_APPROVE=1); ignored.")
  );

const sandboxField = z
  .boolean()
  .optional()
  .describe("Run the task with Antigravity's terminal sandbox flag enabled (--sandbox)");

const addDirsField = z
  .array(z.string())
  .optional()
  .describe("Extra directories to add to the task's workspace (--add-dir, repeatable)");

const editScopeField = z
  .array(z.string())
  .min(1)
  .optional()
  .describe(
    "Give the sub-agent an edit boundary (files and directories relative to cwd, or absolute). " +
      "Out-of-scope changes are surfaced in the result's files_touched/scope_violations audit; " +
      "it is an audit-and-replay control, not a sandbox — the CLI writes files itself."
  );

const projectField = z.string().optional().describe("Antigravity project ID or name for the task");

const conversationIdField = z
  .string()
  .optional()
  .describe(
    "Existing agy conversation ID to continue/resume instead of starting a new conversation. " +
      "Returned by previous task results."
  );

const timeoutField = z
  .number()
  .int()
  .min(0)
  .max(3_600_000)
  .optional()
  .describe(
    `Idle timeout for the run in ms (0..3600000; 0 disables the idle kill for this run). ` +
      `Resets on every stdout/stderr chunk from the child; kicks in after this much child silence ` +
      `and kills the child (SIGTERM, then SIGKILL after 5s). Default: ` +
      `${DEFAULT_IDLE_TIMEOUT_MS} (AGY_MCP_IDLE_TIMEOUT_MS).`
  );

const delegationInputSchema = {
  prompt: z
    .string()
    .min(1)
    .describe("Full, self-contained task description for the sub-agent. Include all needed context and file paths."),
  conversation_id: conversationIdField,
  cwd: cwdField,
  model: modelField,
  agent: agentField,
  effort: effortField,
  auto_approve: autoApproveField,
  sandbox: sandboxField,
  add_dirs: addDirsField,
  edit_scope: editScopeField,
  project: projectField,
  timeout_ms: timeoutField,
};

function textResult(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    isError,
  };
}

type DelegationArgs = z.infer<z.ZodObject<typeof delegationInputSchema>>;

function toOptions(
  args: DelegationArgs,
  sessionID?: string,
  presets?: { mode?: TaskOptions["mode"]; effort?: TaskOptions["effort"] }
): TaskOptions {
  return {
    prompt: args.prompt,
    cwd: args.cwd,
    conversationId: args.conversation_id,
    agent: args.agent,
    model: args.model,
    effort: args.effort ?? presets?.effort,
    // No `mode` argument: each tool's preset is fixed by its registration so a
    // read-only explore_task cannot be weakened at call time.
    mode: presets?.mode,
    autoApprove: args.auto_approve,
    sandbox: args.sandbox,
    addDirs: args.add_dirs,
    editScope: args.edit_scope,
    project: args.project,
    timeoutMs: args.timeout_ms,
    sessionID,
  };
}

/** OpenCode attaches its session ID (`ses_...`) to every tool call in request _meta. */
function opencodeSessionID(extra: unknown): string | undefined {
  if (!extra || typeof extra !== "object" || !("_meta" in extra)) return undefined;
  const meta = (extra as { _meta?: unknown })._meta;
  if (!meta || typeof meta !== "object") return undefined;
  const v = (meta as Record<string, unknown>)["ai.opencode/sessionID"];
  return typeof v === "string" && v ? v : undefined;
}

// ---------------------------------------------------------------------------
// Core delegation tools (general_task / explore_task)
// ---------------------------------------------------------------------------

function registerDelegationTool(spec: {
  name: string;
  title: string;
  description: string;
  presets: { mode: TaskOptions["mode"]; effort: TaskOptions["effort"] };
}) {
  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: delegationInputSchema,
    },
    async (args, extra) => {
      try {
        const result = await runTask(toOptions(args, opencodeSessionID(extra), spec.presets));
        return textResult(result);
      } catch (err) {
        return textResult({ error: (err as Error).message }, true);
      }
    }
  );
}

registerDelegationTool({
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
  presets: { mode: "accept-edits", effort: "medium" },
});

registerDelegationTool({
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
  presets: { mode: "plan", effort: "low" },
});

// ---------------------------------------------------------------------------
// Live stream viewer (watch_task)
// ---------------------------------------------------------------------------

server.registerTool(
  "watch_task",
  {
    title: "Watch live or recent task stream transcript",
    description:
      "Tails a task's live stream transcript. No args = latest run. Call it while a general_task/explore_task " +
      "is in flight (this or any session) to watch the sub-agent work; the returned 'running' field plus " +
      "'modified' tell a live run from an abandoned one.",
    inputSchema: {
      stream_file: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Stream transcript to read. Omit for the latest task_<id>.stream in AGY_MCP_STATE_DIR. " +
            "Accepted forms: an absolute path under AGY_MCP_STATE_DIR, a bare file name like " +
            '"task_f8870173.stream", or a task id like "task_f8870173" / "f8870173".'
        ),
      tail_lines: z
        .number()
        .int()
        .min(0)
        .max(2000)
        .optional()
        .describe(
          "Number of trailing lines to return (1..2000, default 400; 0 returns the full transcript, " +
            "hard-capped at 200,000 chars)."
        ),
    },
  },
  async (args) => {
    try {
      return textResult(
        watchTask({
          streamFile: args.stream_file,
          tailLines: args.tail_lines,
        })
      );
    } catch (err) {
      return textResult({ error: (err as Error).message }, true);
    }
  }
);

// ---------------------------------------------------------------------------
// Discovery tools
// ---------------------------------------------------------------------------

server.registerTool(
  "list_models",
  {
    title: "List available agy models",
    description: "List model IDs usable for the `model` parameter of delegation tools.",
    inputSchema: {},
  },
  async () => {
    const { stdout } = await runCmd(AGY_BIN, ["models"], 30_000);
    return textResult({ models: stdout || "(no output from `agy models`)" });
  }
);

server.registerTool(
  "list_agents",
  {
    title: "List available agy agents",
    description: "List agent profiles usable for the `agent` parameter of delegation tools.",
    inputSchema: {},
  },
  async () => {
    const { stdout } = await runCmd(AGY_BIN, ["agents"], 30_000);
    return textResult({
      agents: stdout || "(no custom agents configured; default agent will be used)",
    });
  }
);

// ---------------------------------------------------------------------------
// Start transport
// ---------------------------------------------------------------------------

sweepStateDir();

process.stderr.write(
  `[${SERVER_NAME}] starting (agy=${AGY_BIN}, idle_timeout_ms=${DEFAULT_IDLE_TIMEOUT_MS === 0 ? "off" : DEFAULT_IDLE_TIMEOUT_MS}, wall_timeout_ms=${DEFAULT_PRINT_TIMEOUT_MS === 0 ? "off" : DEFAULT_PRINT_TIMEOUT_MS}, auto_approve=${ALLOW_AUTO_APPROVE ? "allowed" : "denied"}${ROOT ? `, root=${ROOT}` : ""}, retention=${RETENTION_DAYS === 0 ? "off" : `${RETENTION_DAYS}d`})\n`
);

await server.connect(new StdioServerTransport());
process.stderr.write(`[${SERVER_NAME}] connected on stdio\n`);

// When the MCP client dies mid-call, responses can arrive on a closed pipe and
// the SDK's stdio transport surfaces it as an unhandled EPIPE. Exit quietly —
// in-flight headless run children are killed on the way out; nothing else needs
// cleanup that the next boot's sweep would not do anyway.
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

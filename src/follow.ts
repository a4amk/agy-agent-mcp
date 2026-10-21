/**
 * agy-agent-follow: live-follow companion CLI for agy-agent-mcp.
 *
 * Runs ONE delegation directly through the server's own runner (`runTask` from
 * src/agy.ts — no MCP layer, no JSON-RPC, no subprocess of bin/mcp.mjs) and
 * forwards the live transcript to stdout, so a delegated run can be watched
 * from a terminal while it happens. stdout carries the `--- task <id> · stream
 * <name> ---` banner, then the mirrored `.stream` transcript lines as they are
 * written, then the `=== task done ===` marker and the final result JSON; the
 * single meta banner goes to stderr.
 *
 * Model and effort are two separate knobs, exactly as on the MCP tool surface:
 * pass a bare model id together with `--effort` (e.g. `--model
 * gemini-3.8-flash --effort high`), or a model id that already carries its
 * tier (e.g. `gemini-3.8-flash-high`) without `--effort`. The agy CLI rejects
 * a tier-carrying model id together with a *different* `--effort`, so that
 * mismatch is refused locally before a task is ever spawned.
 */
import path from "node:path";
import {
  EFFORT_LEVELS,
  isEffortLevel,
  modelTier,
  runTask,
  shutdownRunner,
  type TaskOptions,
  type TaskResult,
} from "./agy.ts";

/** Tool name -> fixed runner mode preset (the same pinning as the MCP tools). */
const TOOL_MODES = { general: "accept-edits", explore: "plan" } as const;
type ToolName = keyof typeof TOOL_MODES;

const FOLLOW_NAME = "agy-agent-follow";

const USAGE = `Usage: agy-agent-follow [options] <prompt words...>

Live-follow companion for agy-agent-mcp: drives the same runner the MCP server
uses (runTask) in-process and prints the mirrored .stream transcript to stdout
while it is written, followed by the final result JSON before exit. Exit code
is 0 only when the result status is "success".

Options:
  --tool general|explore   Posture to imitate: general -> accept-edits
                           (default), explore -> plan (read-only).
  --model <model-id>       Model for the task, e.g. gemini-3.8-flash. Pair it
                           with --effort to choose the reasoning tier.
  --effort <level>         Reasoning effort: low|medium|high (the levels the
                           available models accept). A model id that already
                           carries a tier (e.g. gemini-3.8-flash-high) must not
                           repeat it.
  --cwd <dir>              Working directory for the delegated task
                           (default: this process's cwd).
  --timeout-ms <n>         Idle timeout for the run in ms, 0..3600000
                           (0 disables; default AGY_MCP_IDLE_TIMEOUT_MS).
  --help                   Show this help.
`;

interface FollowInvocation {
  tool: ToolName;
  model?: string;
  effort?: TaskOptions["effort"];
  cwd?: string;
  timeoutMs?: number;
  prompt?: string;
  help: boolean;
  problems: string[];
}

/** Parse argv; every problem lands in `problems` for a single usage-error exit. */
function parseInvocation(argv: string[]): FollowInvocation {
  const parsed: FollowInvocation = { tool: "general", help: false, problems: [] };
  const problems: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i] as string;
    i += 1;
    if (arg === "--") {
      while (i < argv.length) {
        const word = argv[i] as string;
        i += 1;
        parsed.prompt = parsed.prompt === undefined ? word : `${parsed.prompt} ${word}`;
      }
      break;
    }
    if (parsed.prompt !== undefined) {
      parsed.prompt = `${parsed.prompt} ${arg}`;
      continue;
    }
    const take = (): string | undefined => {
      const value = argv[i];
      i += 1;
      if (typeof value !== "string" || (value.length > 1 && value.startsWith("-"))) return undefined;
      return value;
    };
    if (arg === "--help") {
      parsed.help = true;
    } else if (
      arg === "--tool" ||
      arg === "--model" ||
      arg === "--effort" ||
      arg === "--cwd" ||
      arg === "--timeout-ms"
    ) {
      const value = take();
      if (value === undefined) {
        problems.push(`${arg} requires a value`);
      } else if (arg === "--tool") {
        if (value === "general" || value === "explore") parsed.tool = value;
        else problems.push(`--tool must be "general" or "explore", got: ${value}`);
      } else if (arg === "--timeout-ms") {
        if (/^\d+$/.test(value) && Number(value) <= 3_600_000) parsed.timeoutMs = Number(value);
        else problems.push(`--timeout-ms must be an integer in 0..3600000, got: ${value}`);
      } else if (arg === "--effort") {
        if (isEffortLevel(value)) parsed.effort = value;
        else problems.push(`--effort must be one of ${EFFORT_LEVELS.join("|")}, got: ${value}`);
      } else if (arg === "--model") {
        // The model id is trimmed: the agy CLI compares it verbatim, so a
        // padded id would be an unknown model. The trimmed value is what
        // reaches the CLI and what the messages below quote.
        const model = value.trim();
        parsed.model = model === "" ? undefined : model;
      } else {
        parsed.cwd = value;
      }
    } else if (arg.startsWith("--")) {
      problems.push(`unknown option: ${arg}`);
    } else {
      parsed.prompt = arg;
    }
  }
  // The agy CLI refuses a model id that already carries a tier together with a
  // different --effort ("invalid model selection ... conflicts"). Catch it
  // locally so the mismatch is a usage error instead of a spawned-and-failed
  // run.
  const modelTierValue = modelTier(parsed.model);
  if (modelTierValue && parsed.effort && modelTierValue.toLowerCase() !== parsed.effort.toLowerCase()) {
    problems.push(
      `--model ${parsed.model} already carries tier "${modelTierValue}" which conflicts with --effort ${parsed.effort}; pass one or the other`
    );
  }
  if (parsed.prompt === undefined && !parsed.help && problems.length === 0) {
    problems.push("missing prompt");
  }
  parsed.problems = problems;
  return parsed;
}

const invocation = parseInvocation(process.argv.slice(2));

// ---------------------------------------------------------------------------
// Shutdown: the same policy as the server - kill in-flight headless run
// children. Registered BEFORE the awaited run below so a Ctrl-C / SIGTERM
// arriving while the delegation is in flight is caught by these handlers;
// pinned after the run they would never register (module evaluation is parked
// on the await) and the default signal disposition would exit without killing
// the agy child. Follow is single-flight per process, so shutdownRunner has at
// most one agy child to signal; distinct exit codes distinguish Ctrl-C (130)
// from SIGTERM (143) for scripts.
// ---------------------------------------------------------------------------

process.on("SIGINT", async () => {
  await shutdownRunner();
  process.exit(130);
});
process.on("SIGTERM", async () => {
  await shutdownRunner();
  process.exit(143);
});

// A dead consumer turns stdout writes into unhandled EPIPE the same way the
// MCP server's client death does — exit quietly, killing the in-flight child.
process.on("uncaughtException", async (err) => {
  if ((err as NodeJS.ErrnoException)?.code === "EPIPE") {
    await shutdownRunner();
    process.exit(141);
  }
  await shutdownRunner();
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Main: parse already done; delegate through the runner with the bridge hooks
// ---------------------------------------------------------------------------

if (invocation.help) {
  process.stdout.write(USAGE);
} else if (invocation.problems.length > 0 || invocation.prompt === undefined) {
  for (const problem of invocation.problems) {
    process.stderr.write(`[${FOLLOW_NAME}] ${problem}\n`);
  }
  process.stderr.write(USAGE);
  process.exitCode = 2;
} else {
  // stderr-only banner keeps stdout free of meta noise: stdout carries the
  // task banner, the transcript lines, the "=== task done ===" marker and
  // the result JSON - nothing else.
  const taskCwd = path.resolve(invocation.cwd ?? process.cwd());
  process.stderr.write(
    `[${FOLLOW_NAME}] tool=${invocation.tool} model=${invocation.model ?? "default"} cwd=${taskCwd}\n`
  );
  const opts: TaskOptions = {
    prompt: invocation.prompt,
    cwd: invocation.cwd,
    model: invocation.model,
    mode: TOOL_MODES[invocation.tool],
  };
  if (invocation.timeoutMs !== undefined) opts.timeoutMs = invocation.timeoutMs;
  if (invocation.effort !== undefined) opts.effort = invocation.effort;
  opts.onTaskStart = (taskId, streamPath) => {
    process.stdout.write(`--- task ${taskId} · stream ${path.basename(streamPath)} ---\n`);
  };
  opts.onStreamLine = (text) => {
    process.stdout.write(text);
  };
  try {
    const result: TaskResult = await runTask(opts);
    process.stdout.write(`\n=== task done ===\n${JSON.stringify(result, null, 2)}\n`);
    // Exit code 0 iff status === "success".
    process.exitCode = result.status === "success" ? 0 : 1;
  } catch (err) {
    process.stderr.write(`[${FOLLOW_NAME}] ${(err as Error).message}\n`);
    process.exitCode = 1;
  }
}

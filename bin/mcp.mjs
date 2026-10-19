#!/usr/bin/env node
/**
 * Executable shim so the package can be installed and run from npm
 * (`npm install -g agy-agent-mcp` / `npx agy-agent-mcp`).
 *
 * Node runs TypeScript sources directly via type stripping, but the unflagged
 * default only landed in 22.18+/23.6+. On 22.6-22.17 the flag is required, so
 * re-spawn node with it instead of importing the sources directly.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const [major, minor] = process.versions.node.split(".").map(Number);
const typeStrippingDefault = (major === 22 && minor >= 18) || (major === 23 && minor >= 6) || major >= 24;

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));

const child = spawn(process.execPath, [...(typeStrippingDefault ? [] : ["--experimental-strip-types"]), entry], {
  stdio: "inherit",
});
child.on("error", (err) => {
  console.error(`agy-agent-mcp: failed to start (node ${process.versions.node}): ${err.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

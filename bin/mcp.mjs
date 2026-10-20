#!/usr/bin/env node
/**
 * Executable shim: `npm install -g agy-agent-mcp` / `npx agy-agent-mcp`.
 *
 * Runs the compiled server (dist/) directly. The npm tarball must contain
 * plain JavaScript only — Node refuses to type-strip files under
 * node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so TypeScript
 * sources stay out of the registry payload and `npm run build` precedes
 * every publish (pretest / prepublishOnly / publish workflow).
 */
import "../dist/index.js";

# Contributing

## Development setup

Clone the repository and install dependencies:

```sh
git clone https://github.com/a4amk/agy-agent-mcp
cd agy-agent-mcp
npm install
```

Node 22.6 or later is required because TypeScript runs directly via type stripping without a build step. The server runs the CLI headlessly, so no `tmux` is needed. You only need an authenticated Antigravity CLI (`agy`) in your PATH if you want to run the maintainer-level live end-to-end test (`node test/client.ts`).

## Running from source

Start the server locally over stdio:

```sh
npm run start
```

## Linting and formatting

Formatting and linting are enforced with [Biome](https://biomejs.dev/) `2.5.15`, configured in `biome.json` (2-space indentation, double quotes, semicolons, `lineWidth: 120`, default branch `main`):

```sh
npm run lint       # biome check src test bin
npm run lint:fix   # biome check --write src test bin
```

## Running tests

Run the offline test suite and linter before submitting changes:

```sh
npm test               # offline suite (node test/client6.ts — no agy auth or quota needed)
node test/client.ts    # live e2e (maintainer-level: requires agy auth + a trusted workspace)
```

`npm test` (`node test/client6.ts`) uses fake shell scripts and runs completely offline for free — covering argv envelopes, `stream-json` output parsing and `.stream` rendering, idle and opt-in wall-clock timeouts (`kind: "idle"` vs `"wall"`), git-based `files_touched`/`scope_violations` auditing, the startup `.ndjson`/`.stream` retention sweep, and `watch_task` helpers.

`node test/client.ts` is a maintainer-level live end-to-end check that runs real headless turns through `agy` (blocking `general_task`, conversation resume, and `watch_task`) against a trusted workspace and consumes a small amount of model quota.

## Continuous integration

GitHub Actions (`.github/workflows/ci.yml`) runs `npm ci`, `npm run lint`, and `npm test` on Node 22 for pushes to `main` and all pull requests.

## Pull requests

- Target the `main` branch and keep pull requests focused on a single change.
- Use concise, one-line commit messages.
- When adding or modifying delegation tools (`general_task`, `explore_task`), inspection tools (`watch_task`), or discovery tools (`list_models`, `list_agents`), register them in `src/index.ts` using the shared delegation factory and option schema fragments.
- Make sure `npm run lint` and `npm test` pass cleanly before opening a pull request (and `node test/client.ts` when changing live CLI integration).

# Contributing

## Development setup

Clone the repository and install dependencies:

```sh
git clone https://github.com/a4amk/agy-agent-mcp
cd agy-agent-mcp
npm install
```

Node 22.6 or later is required. The shipped server is plain compiled JavaScript (`npm run build` -> `dist/`, which is what `bin/mcp.mjs` and `bin/follow.mjs` run - Node refuses to type-strip files under `node_modules`), while the repository's own test scripts (`node test/client6.ts`, `node test/client.ts`) execute the TypeScript sources directly through Node's type stripping, which is what needs 22.6+. The server runs the CLI headlessly, so no `tmux` is needed. You only need an authenticated Antigravity CLI (`agy`) in your PATH if you want to run the maintainer-level live end-to-end test (`node test/client.ts`).

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

`npm test` (`node test/client6.ts`) uses fake shell scripts and runs completely offline for free — covering argv envelopes, `stream-json` output parsing and `.stream` rendering, idle and opt-in wall-clock timeouts (`kind: "idle"` vs `"wall"`), git-based `files_touched`/`scope_violations` auditing, the startup `.ndjson`/`.stream` retention sweep, `watch_task` helpers (including that a finished run's watch report carries the complete final result, so a failed run reports why it failed), the progress bridge (a foreground delegation streams progress frames, a detached one emits none), the ignored-cancel hint (a cancel for a run this process does not own is reported as ignored, while a cancel that works and a cancel for a finished run carry no hint), the drain on a client disconnect (a detached run survives it and its receipt carries the result, while an abandoned foreground call is still killed), and the MCP-layer effort/model resolution, failure surfacing, input validation and discovery error reporting.

`node test/client.ts` is a maintainer-level live end-to-end check that runs real headless turns through `agy` (blocking `general_task`, conversation resume, and `watch_task`) against a trusted workspace and consumes a small amount of model quota.

## Continuous integration

GitHub Actions (`.github/workflows/ci.yml`) runs `npm ci`, `npm run lint`, and `npm test` on Node 22 for pushes to `main` and all pull requests.

## Releasing

- A release is a **tag on `main`**. The tag push is what publishes: `.github/workflows/publish.yml` runs on the push of a `v*` tag, publishes the package to npm through Trusted Publishing (OIDC, no token) and creates the GitHub release. There is no manual trigger - to retry a failed release, re-run the workflow run of that tag push. npm refuses to publish the same version twice, so a run that failed *after* the publish (the GitHub release step) cannot be re-published: create that release by hand from the tag.
- The preparation of a release is **one command**, not three hand-edits:

  ```sh
  npm run release -- 0.3.0
  ```

  It does the whole prep in one go and refuses to do it half-way:
  - **the release notes come first** - the script refuses to run unless `CHANGELOG.md` carries a `## Unreleased` section (and it is not empty): the maintainer writes the notes of the release there *before* running the command, and the release publishes exactly that section;
  - **the version is validated** as a **stable `MAJOR.MINOR.PATCH`** - three numbers, no leading zero (e.g. `0.3.0`) - and nothing else: no prerelease and no build metadata. A prerelease would need the workflow to publish with `--tag` (npm refuses a prerelease without it) and npm strips build metadata at publish time, so either way the published version would not be the version the tag names. The version in `package.json` is therefore exactly the version npm publishes and exactly the version the tag names; it must also be newer than the current `package.json` version;
  - **the working tree must be clean** - the script refuses any pre-existing modification, so it always starts from a known state;
  - it then edits exactly four things: the `version` in `package.json`, the two version fields in `package-lock.json` (the top-level `version` and `packages[""].version` - the lockfile is bumped with the version, or it would claim an older version than the package), the `## Unreleased` heading in `CHANGELOG.md` (renamed to `## <version> - <date>`) and the `serverInfo.version` of the two goldens `test/goldens/initialize.json` and `test/goldens/duplicate-initialize.json`. The goldens are compared exactly by the test suite, so they can no longer drift away from `package.json` (they sat at `0.1.2` through two releases before);
  - it runs the gates (`npm test` and `npm run lint`) and aborts without committing if either fails;
  - the whole sequence is **all-or-nothing**: a write error, a signal, a red gate or a failed commit puts the working tree back the way it was, so a failed run never leaves the tree half prepared and never blocks the next run;
  - it creates the commit `chore(release): <version>` with those files and nothing else.
- The script **never pushes, never tags and never publishes** (it has no network access at all): it prepares the commit, the maintainer does the rest.
- The flow, end to end:
  1. write the release notes under `## Unreleased` in `CHANGELOG.md` and commit them;
  2. `npm run release -- <version>` - prepares the version bump, the changelog heading and the goldens, runs the gates and creates the `chore(release): <version>` commit;
  3. push the branch, open a PR into `main` and merge it with **Rebase and merge** (a squash merge would collapse the history; a merge commit is rejected by the linear-history rule);
  4. on `main`, tag the release and push the tag:

     ```sh
     git tag v<version> && git push origin v<version>
     ```

     That tag push runs `.github/workflows/publish.yml`, which publishes to npm through Trusted Publishing (OIDC, no token) and creates the GitHub release.
- The workflow refuses to publish unless:
  1. **the ref is a release tag** (`refs/tags/v<version>`) - a branch ref, or a tag that is not a version, is refused;
  2. **the tag matches the `package.json` version** (`v0.3.0` publishes `0.3.0` and nothing else) - a mismatch is refused, so a tag can never publish a version other than the one it names;
  3. **the tagged commit is on `main`** (`git merge-base --is-ancestor`) - a release cut from a side branch is refused.
- The npm trusted publisher must name the workflow file `publish.yml` **and** the GitHub environment `release`. npm puts the publish token into the OIDC token only when the job declares that environment, so the job declares `environment: release`; without it the publish is refused - npm rejects the token (*Unable to authenticate*, or a 404 *package not found*, depending on the npm CLI version).
- The release notes of the GitHub release come from the CHANGELOG: the `## <version>` section of the released version, plus a `**Full Changelog**` compare link against the previous release tag. The section is built before `npm publish`, and a missing or empty section fails the release - a release without its notes is not published.
- The job runs `npm ci`, `npm run build --if-present` and `npm test` before publishing, so a red suite blocks the release.
- The workflow runs from the tagged commit, so `publish.yml` has to be on `main` before the first release.

## Pull requests

- Target the `main` branch and keep pull requests focused on a single change.
- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages:
  - **Subject**: `<type>(<scope>): <imperative summary>`, lowercase after the prefix, no trailing
    period, at most 72 characters. Allowed types: `feat`, `fix`, `docs`, `refactor`, `perf`,
    `test`, `build`, `ci`, `chore`, `revert`.
  - **Body**: required whenever the subject alone does not explain *what changed and why*.
    Separate it from the subject with one blank line, wrap it at 72 characters, and prefer prose
    over bullet lists. Explain the motivation (the bug, the contract that was broken) before the
    implementation details.
  - **Footer**: optional `BREAKING CHANGE:` notes and issue references, separated by a blank line.
  - One logical change per commit; do not mix a fix with an unrelated refactor.
- When adding or modifying delegation tools (`general_task`, `explore_task`), inspection tools (`watch_task`), or discovery tools (`list_models`, `list_agents`), add an entry to the five-tool table in `src/index.ts` (title, description, hand-written `inputSchema` literal, and handler); the `test/goldens/` files capture the exact wire shape and must stay in deep agreement.
- Make sure `npm run lint` and `npm test` pass cleanly before opening a pull request (and `node test/client.ts` when changing live CLI integration).

## Where the truth lives

To prevent drift between prose and code, this project avoids duplicate behavioral references. Every fact has a single machine-checked owner:

- **Result fields**: the `TaskResult` type in `src/agy.ts` (per-field comments).
- **Caps and defaults**: the `MAX_*` / `DEFAULT_*` constants in `src/agy.ts`.
- **Error wordings**: the literals in `runTask` and the MCP layer in `src/index.ts`.
- **The per-tool contract**: the tool and argument descriptions in `src/index.ts` (pinned byte-for-byte by `test/goldens/tools-list.json`).
- **The wire**: `test/goldens/`, enforced by the parity section of the suite.
- **Behaviours**: the test suite's own section summaries: run `npm test` and read them (the section list is in the header of `test/client6.ts`).
- **Product decisions**: `## Deliberately not implemented` in this file.
- **The user how-to**: `README.md`.

## Deliberately not implemented

These are decisions, not gaps. Each was considered and rejected on purpose — do not "fix" one without a product decision.

- **No concurrency cap**: the number of concurrent delegations is bounded by the machine and the account's quota, not by the server; the caller is free to fan out.
- **No MCP task API**: the server advertises `execution: { taskSupport: "forbidden" }` on every tool — the MCP task protocol is not offered. It is the spec-idiomatic async design, and it is what a server with long-running calls should advertise. But a client can only use it when it advertises the `tasks` capability — **OpenCode does not**. A task-based server would therefore, in practice, only make an orchestrator *poll* — more calls, more tokens, more context — for no gain over the handle-and-watch workflow this server already has (`background: true` + `watch_task`).
- **No async delegation mode** (a tool call that answers "still running, ask again"): the orchestrator contract is **one call → the complete result** (~300 tokens of context, the whole `TaskResult` in a single `tools/call`). An async rewrite puts exactly that asset at risk — the caller pays an extra round trip plus the polling context to get the same report — and it would take away the reason this server exists. The detached path covers "start now, collect later" without touching the foreground contract.
- **No `cancel_task` tool**: `watch_task(cancel: true)` already stops a run this process owns, and it *reports* a cancel it could not honour instead of pretending it worked. A second tool would duplicate that surface (and the MCP cancellation semantics) without adding a capability.
- **No cross-process cancel**: the cancel path acts on the in-flight delegations registry, so it can only stop a run this server process started. Cancelling a run owned by another process needs PID signalling plus an identity check (the PID must be proven to be that run's, not a recycled one) and a "cancel requested" marker the owning process polls — a feature, not a bug fix. Until that exists, an ignored cancel is reported as ignored (the report's `hint`).

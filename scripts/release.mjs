#!/usr/bin/env node
/**
 * Release prep for agy-agent-mcp.
 *
 *   npm run release -- 0.3.0
 *
 * The release is a tag on main, and the tag push is what publishes. This
 * script prepares the commit that the tag will point at: three edits that
 * must agree with each other and used to be three hand-edits (they drifted -
 * the goldens sat at 0.1.2 through two releases while package.json moved on).
 *
 *   - package.json          "version": "0.3.0"
 *   - package-lock.json     the top-level "version" and packages[""].version
 *   - CHANGELOG.md          "## Unreleased" becomes "## 0.3.0 - 2026-10-21"
 *   - test/goldens/*.json   serverInfo.version becomes "0.3.0"
 *
 * The test suite compares the golden's serverInfo.version exactly, so the
 * goldens cannot drift away from package.json any more.
 *
 * The script prepares and commits. It never publishes: it does not push, does
 * not tag, does not publish and does not touch the network. The maintainer
 * pushes the branch, merges the pull request and pushes the tag v<version> -
 * that tag push is what publishes to npm and creates the GitHub release.
 *
 * The prep is all-or-nothing: the edit -> gate -> commit sequence puts the
 * working tree back the way it was on any failure - a write error, a signal,
 * a red gate, a failed commit - so a failed run never leaves the tree half
 * prepared and never blocks the next run.
 */
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The files the release touches - nothing else is ever written. */
const PACKAGE_JSON = path.join(ROOT, "package.json");
const PACKAGE_LOCK = path.join(ROOT, "package-lock.json");
const CHANGELOG = path.join(ROOT, "CHANGELOG.md");
const GOLDEN_INITIALIZE = path.join(ROOT, "test", "goldens", "initialize.json");
const GOLDEN_DUPLICATE = path.join(ROOT, "test", "goldens", "duplicate-initialize.json");
const RELEASE_FILES = [PACKAGE_JSON, PACKAGE_LOCK, CHANGELOG, GOLDEN_INITIALIZE, GOLDEN_DUPLICATE];
const RELEASE_PATHS = RELEASE_FILES.map((file) => path.relative(ROOT, file).split(path.sep).join("/"));

/**
 * A release version is a stable MAJOR.MINOR.PATCH - three identifiers, each
 * 0|[1-9]\d* (no leading zero) - and nothing else.
 *
 * The strict semver grammar would also allow a prerelease and build metadata,
 * but the release workflow cannot publish those: it runs a plain "npm publish",
 * and npm refuses a prerelease without "--tag" ("You must specify a tag using
 * --tag when publishing a prerelease version"), while npm strips build
 * metadata at publish time - the published version would then be 0.3.0, not
 * the v0.3.0+build.5 the tag names. The rule is therefore the strict core
 * only: the version in package.json is exactly the version npm publishes and
 * exactly the version the tag names. This project has only ever shipped
 * stable versions.
 *
 * The release tag pattern in publish.yml is looser (v[0-9]+(\.[0-9]+)*); the
 * script is the stricter of the two on purpose.
 */
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** The git subcommands this script is allowed to run. Read-only, plus add/commit. */
const GIT_ALLOWED = new Set(["status", "add", "commit", "rev-parse", "show"]);

/** The signals that abort the run (and restore the working tree). */
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

/** A failure with a message meant for the maintainer - never a stack trace. */
class ReleaseError extends Error {}

/** The original bytes of the release files, and whether a restore is owed. */
const originals = new Map();
let restoreOwed = false;
let releaseCommitted = false;
let activeChild = null;

function restoreTree() {
  if (!restoreOwed) return;
  restoreOwed = false;
  for (const [file, bytes] of originals) {
    try {
      writeFileSync(file, bytes);
    } catch {
      // Best effort: a file that cannot be written back is reported by the
      // failure that caused the restore.
    }
  }
  // The index has to match the restored files again, or the next run would
  // be refused by the "working tree is not clean" check.
  try {
    git(["add", "--", ...RELEASE_PATHS]);
  } catch {
    // Best effort, same as above.
  }
}

function aborted(reason) {
  return new ReleaseError(
    `${reason} - the release was aborted, nothing was committed\n` +
      "  and the working tree was restored to its previous state."
  );
}

function usage() {
  process.stderr.write(
    "usage: npm run release -- <version>\n" +
      "  <version>  a stable MAJOR.MINOR.PATCH - three numbers, no leading zero\n" +
      "             (e.g. 0.3.0)\n"
  );
  process.exit(2);
}

/** Run a git subcommand. Only the allowlisted ones - never a push, never a tag. */
function git(args) {
  const [subcommand, ...rest] = args;
  if (!GIT_ALLOWED.has(subcommand)) {
    throw new ReleaseError(`refusing to run "git ${subcommand}": only ${[...GIT_ALLOWED].join(", ")} are allowed`);
  }
  try {
    return execFileSync("git", [subcommand, ...rest], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = error?.stderr ? String(error.stderr).trim() : "";
    throw new ReleaseError(`git ${subcommand} failed: ${stderr || error?.message || "unknown error"}`);
  }
}

function gitOut(args) {
  return git(args).trim();
}

/** Split a version into its numeric core and its prerelease tag. */
function parseVersion(version) {
  const match = /^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) return null;
  return { core: match[1].split(".").map(Number), prerelease: match[2] ?? null };
}

/** Compare two prerelease tags the way semver does (numeric < alphanumeric). */
function comparePrerelease(a, b) {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const left = a.split(".");
  const right = b.split(".");
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i];
    const y = right[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff > 0 ? 1 : -1;
    } else if (xNumeric !== yNumeric) {
      return xNumeric ? -1 : 1;
    } else if (x !== y) {
      return x > y ? 1 : -1;
    }
  }
  return 0;
}

/** > 0 when a is newer than b, 0 when they are the same, < 0 when a is older. */
function compareVersions(a, b) {
  const length = Math.max(a.core.length, b.core.length);
  for (let i = 0; i < length; i++) {
    const x = a.core[i] ?? 0;
    const y = b.core[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

/** Replace the value of a "version" key, keeping the file's own formatting. */
function replaceVersionValue(text, key, newValue, file) {
  const pattern = new RegExp(`("${key}"[ \\t]*:[ \\t]*")([^"]*)(")`);
  const match = pattern.exec(text);
  if (!match) throw new ReleaseError(`${file} has no "${key}" field`);
  return text.replace(pattern, (_all, before, _old, after) => `${before}${newValue}${after}`);
}

/**
 * Bump the two version fields of the lockfile: the top-level "version" and the
 * version of the root package (packages[""].version). The dependency versions
 * are not touched - only the two fields that name this package. The file is
 * edited in place (a string replacement), so its formatting and its trailing
 * newline are kept.
 */
function bumpLockfileVersion(text, version) {
  const lock = JSON.parse(text);
  const topVersion = typeof lock.version === "string" ? lock.version : null;
  const rootVersion = typeof lock.packages?.[""]?.version === "string" ? lock.packages[""].version : null;
  if (topVersion === null) throw new ReleaseError("package-lock.json has no top-level version");
  if (rootVersion === null) throw new ReleaseError('package-lock.json has no packages[""].version');

  const fields = [...text.matchAll(/("version"[ \t]*:[ \t]*")([^"]*)(")/g)];
  const top = fields[0];
  if (!top || top[2] !== topVersion) {
    throw new ReleaseError("package-lock.json: the top-level version is not where it is expected");
  }
  const packagesAt = text.indexOf('"packages"');
  if (packagesAt === -1) throw new ReleaseError('package-lock.json has no "packages" object');
  const root = fields.find((field) => field.index > packagesAt);
  if (!root || root[2] !== rootVersion) {
    throw new ReleaseError('package-lock.json: packages[""].version is not where it is expected');
  }
  if (root.index === top.index) {
    throw new ReleaseError("package-lock.json: the two version fields are the same field");
  }

  // Replace the later field first, so the offset of the earlier one stays valid.
  let out = text;
  for (const field of [root, top].sort((a, b) => b.index - a.index)) {
    out = out.slice(0, field.index) + field[1] + version + field[3] + out.slice(field.index + field[0].length);
  }
  const parsed = JSON.parse(out);
  if (parsed.version !== version || parsed.packages?.[""]?.version !== version) {
    throw new ReleaseError("could not set the version in package-lock.json");
  }
  return out;
}

/** Run one gate. The child is async, so a signal can still be handled. */
function runGate(label, args) {
  return new Promise((resolve, reject) => {
    process.stdout.write(`\n--- ${label} ---\n`);
    const child = spawn("npm", args, { cwd: ROOT, stdio: "inherit" });
    activeChild = child;
    child.on("error", (error) => {
      activeChild = null;
      reject(aborted(`${label} could not be run: ${error.message}`));
    });
    child.on("close", (code, signal) => {
      activeChild = null;
      if (signal) reject(aborted(`${label} was killed by ${signal}`));
      else if (code !== 0) reject(aborted(`${label} failed (exit code ${code})`));
      else resolve();
    });
  });
}

const signalHandlers = new Map();

function installSignalHandlers() {
  for (const signal of SIGNALS) {
    const handler = () => onSignal(signal);
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
}

function removeSignalHandlers() {
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  signalHandlers.clear();
}

/** A signal aborts the run: the child dies, the tree goes back, no commit. */
function onSignal(signal) {
  if (activeChild) {
    try {
      activeChild.kill("SIGTERM");
    } catch {
      // The child is already gone.
    }
    activeChild = null;
  }
  restoreTree();
  if (releaseCommitted) {
    process.stderr.write(
      `release: ${signal} - the release commit was already created, the working tree was left as it is\n`
    );
    process.exit(1);
  }
  process.stderr.write(
    `release: ${signal} - the release was aborted, nothing was committed\n` +
      "  and the working tree was restored to its previous state.\n"
  );
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) usage();
  if (args.length > 1) usage();
  const version = args[0];

  if (!VERSION_PATTERN.test(version)) {
    throw new ReleaseError(
      `"${version}" is not a release version.\n` +
        "  A release version is a stable MAJOR.MINOR.PATCH - three numbers, no\n" +
        "  leading zero (e.g. 0.3.0). It carries no prerelease and no build\n" +
        "  metadata: a prerelease would need the workflow to publish with --tag, and\n" +
        "  npm strips build metadata at publish time - either way the published\n" +
        "  version would not be the version the tag names."
    );
  }

  // 1. A known state: the working tree must be clean before anything is touched.
  const status = git(["status", "--porcelain"]);
  if (status.trim() !== "") {
    const entries = status
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => line.slice(3).trim());
    throw new ReleaseError(
      "the working tree is not clean - the release starts from a known state.\n" +
        `  ${entries.join("\n  ")}\n` +
        "  Commit or stash these first."
    );
  }

  // 2. The version must be newer than the released one.
  const packageText = readFileSync(PACKAGE_JSON, "utf8");
  const currentVersion = JSON.parse(packageText).version;
  const parsedCurrent = parseVersion(currentVersion);
  const parsedNew = parseVersion(version);
  if (!parsedCurrent) {
    throw new ReleaseError(`cannot read the current version "${currentVersion}" from package.json`);
  }
  if (compareVersions(parsedNew, parsedCurrent) <= 0) {
    throw new ReleaseError(
      `"${version}" is not newer than the current version "${currentVersion}".\n` +
        "  The release version must be greater than the released one."
    );
  }

  // 3. The release notes come first: the changelog must carry an "## Unreleased" section.
  const changelogText = readFileSync(CHANGELOG, "utf8");
  const unreleased = [...changelogText.matchAll(/^##[ \t]+Unreleased[ \t]*$/gm)];
  if (unreleased.length === 0) {
    throw new ReleaseError(
      "CHANGELOG.md has no '## Unreleased' section.\n" +
        "  Write the release notes there first - the release publishes that section."
    );
  }
  if (unreleased.length > 1) {
    throw new ReleaseError(`CHANGELOG.md has ${unreleased.length} '## Unreleased' headings - keep exactly one.`);
  }
  const headingStart = unreleased[0].index;
  const headingEnd = changelogText.indexOf("\n", headingStart);
  const bodyStart = headingEnd === -1 ? changelogText.length : headingEnd + 1;
  const nextHeading = changelogText.indexOf("\n## ", bodyStart);
  const body = changelogText.slice(bodyStart, nextHeading === -1 ? changelogText.length : nextHeading);
  if (body.trim() === "") {
    throw new ReleaseError(
      "the '## Unreleased' section of CHANGELOG.md is empty.\n" +
        "  Write the release notes there first - a release without its notes is not published."
    );
  }

  // 4. The edits, computed before anything is written.
  const date = new Date().toISOString().slice(0, 10);
  const heading = `## ${version} - ${date}`;

  const newPackageText = replaceVersionValue(packageText, "version", version, "package.json");
  if (JSON.parse(newPackageText).version !== version) {
    throw new ReleaseError("could not set the version in package.json");
  }

  // The lockfile carries the version too: the top-level "version" and the
  // version of the root package. Both are bumped with the version.
  const lockText = readFileSync(PACKAGE_LOCK, "utf8");
  const newLockText = bumpLockfileVersion(lockText, version);

  const newChangelogText = changelogText.replace(/^##[ \t]+Unreleased[ \t]*$/gm, () => heading);
  if (!newChangelogText.includes(heading)) {
    throw new ReleaseError("could not rename the '## Unreleased' heading in CHANGELOG.md");
  }

  const newGoldenTexts = new Map();
  for (const [file, text] of [
    [GOLDEN_INITIALIZE, readFileSync(GOLDEN_INITIALIZE, "utf8")],
    [GOLDEN_DUPLICATE, readFileSync(GOLDEN_DUPLICATE, "utf8")],
  ]) {
    const infoAt = text.indexOf('"serverInfo"');
    if (infoAt === -1) throw new ReleaseError(`${path.relative(ROOT, file)} has no "serverInfo" object`);
    const tail = text.slice(infoAt);
    const match = /("version"[ \t]*:[ \t]*")([^"]*)(")/.exec(tail);
    if (!match) throw new ReleaseError(`${path.relative(ROOT, file)} has no serverInfo.version`);
    const at = infoAt + match.index;
    const replaced = text.slice(0, at) + match[1] + version + match[3] + text.slice(at + match[0].length);
    if (JSON.parse(replaced)?.result?.serverInfo?.version !== version) {
      throw new ReleaseError(`could not set serverInfo.version in ${path.relative(ROOT, file)}`);
    }
    newGoldenTexts.set(file, replaced);
  }

  const updates = new Map([
    [PACKAGE_JSON, newPackageText],
    [PACKAGE_LOCK, newLockText],
    [CHANGELOG, newChangelogText],
    [GOLDEN_INITIALIZE, newGoldenTexts.get(GOLDEN_INITIALIZE)],
    [GOLDEN_DUPLICATE, newGoldenTexts.get(GOLDEN_DUPLICATE)],
  ]);
  // The original bytes, so a restore puts the files back exactly.
  for (const file of RELEASE_FILES) originals.set(file, readFileSync(file));

  // 5. Write the edits. From here on every failure restores the tree.
  installSignalHandlers();
  restoreOwed = true;
  for (const [file, text] of updates) {
    try {
      writeFileSync(file, text);
    } catch (error) {
      throw aborted(`could not write ${path.relative(ROOT, file)}: ${error.message}`);
    }
  }

  // 6. The gates. A red gate aborts the release: nothing is committed and the
  //    working tree is put back the way it was.
  await runGate("npm test", ["test"]);
  await runGate("npm run lint", ["run", "lint"]);

  // 7. The release commit - the release files and nothing else.
  try {
    git(["add", "--", ...RELEASE_PATHS]);
    git(["commit", "-m", `chore(release): ${version}`, "--", ...RELEASE_PATHS]);
  } catch (error) {
    throw aborted(error.message);
  }
  releaseCommitted = true;
  restoreOwed = false;
  removeSignalHandlers();
  // The commit must hold exactly the files the release changed - and nothing
  // else. A release file that already carried the new version (a lockfile that
  // was in sync) is not part of the diff and is not in the commit.
  const changed = RELEASE_FILES.filter((file) => !Buffer.from(updates.get(file), "utf8").equals(originals.get(file)));
  const expected = changed.map((file) => path.relative(ROOT, file).split(path.sep).join("/")).sort();
  const committed = gitOut(["show", "--name-only", "--pretty=format:", "HEAD"]).split("\n").filter(Boolean).sort();
  if (JSON.stringify(committed) !== JSON.stringify(expected)) {
    throw new ReleaseError(
      "the release commit does not hold exactly the files the release changed.\n" +
        `  committed: ${committed.join(", ") || "(nothing)"}\n` +
        `  expected:  ${expected.join(", ") || "(nothing)"}\n` +
        `  (git reset --soft HEAD~1 && git reset -- ${RELEASE_PATHS.join(" ")})`
    );
  }

  // 8. The next steps are the maintainer's: this script never pushes.
  const branch = gitOut(["rev-parse", "--abbrev-ref", "HEAD"]);
  process.stdout.write(
    `\nrelease ${version} prepared: ${RELEASE_PATHS.join(", ")}\n` +
      `committed as "chore(release): ${version}" on ${branch}\n` +
      "\nNext steps:\n" +
      '  1. Push the branch, open a PR into main and merge it with "Rebase and merge"\n' +
      "     (a squash merge would collapse the history; a merge commit is rejected by the\n" +
      "     linear-history rule):\n" +
      `       git push -u origin ${branch}\n` +
      "  2. After the merge, on main, tag the release and push the tag:\n" +
      `       git tag v${version} && git push origin v${version}\n` +
      "     That tag push is what publishes to npm (Trusted Publishing, OIDC) and creates\n" +
      "     the GitHub release.\n"
  );
}

main().catch((error) => {
  restoreTree();
  removeSignalHandlers();
  const message = error instanceof ReleaseError ? error.message : `${error?.message ?? error}`;
  process.stderr.write(`release: ${message}\n`);
  process.exit(1);
});

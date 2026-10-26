import { exec, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, lstat, mkdir, readFile, symlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

const MAX_GIT_BUFFER = 16 * 1024 * 1024;
const MAX_TEST_BUFFER = 8 * 1024 * 1024;

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RepoInfo {
  root: string;
  head: string;
  subdir: string;
}

export interface WorktreeRecord {
  /** Root of the linked worktree checkout. */
  path: string;
  /** Working directory for the teammate (lead cwd mapped into the worktree). */
  cwd: string;
  repoRoot: string;
  branch: string;
  baseCommit: string;
}

export interface MergeResult {
  status: "merged" | "no-changes" | "conflict" | "tests-failed" | "error";
  message: string;
  mergeCommit?: string;
  testCommand?: string;
  cleaned?: boolean;
}

export async function runGit(
  cwd: string,
  args: string[],
  timeoutMs = 60_000,
): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: MAX_GIT_BUFFER,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message ?? String(error),
    };
  }
}

export async function repoInfo(cwd: string): Promise<RepoInfo | undefined> {
  const top = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return undefined;
  const root = top.stdout.trim();
  if (!root) return undefined;
  const relative = path.relative(root, path.resolve(cwd));
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  const head = await runGit(root, ["rev-parse", "HEAD"]);
  if (head.code !== 0) return undefined;
  return { root, head: head.stdout.trim(), subdir: relative };
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  const result = await runGit(repoRoot, [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ]);
  return result.code === 0;
}

/**
 * Link an ignored dependency directory into a checkout so builds and tests work
 * without copying it. Failures are non-fatal.
 */
async function linkDependencies(fromRoot: string, toRoot: string): Promise<void> {
  const source = path.join(fromRoot, "node_modules");
  const target = path.join(toRoot, "node_modules");
  if (!(await exists(source)) || (await exists(target))) return;
  const ignored = await runGit(fromRoot, ["check-ignore", "-q", "node_modules"]);
  if (ignored.code !== 0) return;
  try {
    await symlink(
      source,
      target,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch {
    // Best effort; tests can still run if they need no dependencies.
  }
}

function safeBranchPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "member";
}

export async function createTeamWorktree(options: {
  leadCwd: string;
  teamDir: string;
  sessionId: string;
  name: string;
}): Promise<{ record?: WorktreeRecord; reason?: string }> {
  const repo = await repoInfo(options.leadCwd);
  if (!repo) {
    return { reason: "the project is not inside a git repository with a commit" };
  }

  const worktrees = path.join(options.teamDir, "worktrees");
  await mkdir(worktrees, { recursive: true });
  const suffix = randomUUID().slice(0, 4);
  const worktreePath = path.join(
    worktrees,
    `${safeBranchPart(options.name)}-${suffix}`,
  );

  let branch = `team/${safeBranchPart(options.sessionId.slice(-8))}-${safeBranchPart(options.name)}`;
  if (await branchExists(repo.root, branch)) branch = `${branch}-${suffix}`;

  const added = await runGit(repo.root, [
    "worktree",
    "add",
    "-b",
    branch,
    worktreePath,
    repo.head,
  ]);
  if (added.code !== 0) {
    return { reason: added.stderr.trim() || "git worktree add failed" };
  }

  await linkDependencies(repo.root, worktreePath);

  const cwd = repo.subdir
    ? path.join(worktreePath, repo.subdir)
    : worktreePath;
  await linkDependencies(options.leadCwd, cwd);
  return {
    record: {
      path: worktreePath,
      cwd,
      repoRoot: repo.root,
      branch,
      baseCommit: repo.head,
    },
  };
}

export async function removeTeamWorktree(
  record: WorktreeRecord,
  options: { deleteBranch?: boolean } = {},
): Promise<string | undefined> {
  let problem: string | undefined;
  const removed = await runGit(record.repoRoot, [
    "worktree",
    "remove",
    "--force",
    record.path,
  ]);
  if (removed.code !== 0) {
    problem = removed.stderr.trim() || "git worktree remove failed";
  }
  if (options.deleteBranch !== false) {
    const deleted = await runGit(record.repoRoot, [
      "branch",
      "-D",
      record.branch,
    ]);
    if (deleted.code !== 0 && !problem) {
      problem = deleted.stderr.trim() || "git branch -D failed";
    }
  }
  return problem;
}

export async function reviewTeamWorktree(
  record: WorktreeRecord,
  options: { diff?: boolean; maxChars?: number } = {},
): Promise<string> {
  const maxChars = options.maxChars ?? 12_000;
  if (!(await exists(record.path))) {
    return `Worktree ${record.path} is missing. It may have been merged and cleaned up.`;
  }

  const status = await runGit(record.path, ["status", "--porcelain"]);
  const head = await runGit(record.path, ["rev-parse", "HEAD"]);
  const ahead = await runGit(record.path, [
    "rev-list",
    "--count",
    `${record.baseCommit}..HEAD`,
  ]);
  const stat = await runGit(record.path, [
    "diff",
    "--stat",
    record.baseCommit,
  ]);
  const untracked = await runGit(record.path, [
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);

  const changed = status.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);
  const lines: string[] = [];
  lines.push(`Worktree: ${record.path}`);
  lines.push(`Branch: ${record.branch}`);
  lines.push(`Base: ${record.baseCommit.slice(0, 12)}`);
  lines.push(`Head: ${(head.stdout.trim() || record.baseCommit).slice(0, 12)}`);
  lines.push(`Commits ahead: ${ahead.stdout.trim() || "0"}`);
  lines.push(`Uncommitted changes: ${changed.length}`);
  if (changed.length > 0) {
    lines.push("");
    lines.push("Working tree:");
    for (const line of changed.slice(0, 80)) lines.push(`  ${line}`);
  }
  const newFiles = untracked.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (newFiles.length > 0) {
    lines.push("");
    lines.push("Untracked:");
    for (const file of newFiles.slice(0, 80)) lines.push(`  ${file}`);
  }
  const diffStat = stat.stdout.trim();
  if (diffStat) {
    lines.push("");
    lines.push("Diff stat:");
    lines.push(diffStat);
  }
  if (changed.length === 0 && newFiles.length === 0 && !diffStat) {
    lines.push("");
    lines.push("No changes relative to the base commit.");
  }
  if (options.diff) {
    const full = await runGit(record.path, ["diff", record.baseCommit]);
    if (full.stdout.trim()) {
      lines.push("");
      lines.push("Diff:");
      const body =
        full.stdout.length > maxChars
          ? `${full.stdout.slice(0, maxChars)}\n… truncated (${full.stdout.length} chars)`
          : full.stdout;
      lines.push(body.trimEnd());
    }
  }
  return lines.join("\n");
}

function tail(value: string, limit: number): string {
  return value.length > limit ? `…\n${value.slice(-limit)}` : value;
}

export async function detectTestCommand(
  repoRoot: string,
): Promise<string | undefined> {
  try {
    const raw = JSON.parse(
      await readFile(path.join(repoRoot, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    const script = raw.scripts?.test?.trim();
    if (
      script &&
      !script.includes('Error: no test specified') &&
      script !== "exit 1"
    ) {
      const runners: Array<[string, string]> = [
        ["bun.lock", "bun run test"],
        ["bun.lockb", "bun run test"],
        ["pnpm-lock.yaml", "pnpm test"],
        ["yarn.lock", "yarn test"],
      ];
      for (const [lock, command] of runners) {
        if (await exists(path.join(repoRoot, lock))) return command;
      }
      return "npm test";
    }
  } catch {
    // No package.json or invalid JSON.
  }
  if (await exists(path.join(repoRoot, "Cargo.toml"))) return "cargo test";
  if (await exists(path.join(repoRoot, "go.mod"))) return "go test ./...";
  if (await exists(path.join(repoRoot, "Makefile"))) return "make test";
  return undefined;
}

async function runTestCommand(
  cwd: string,
  command: string,
  timeoutMs: number,
): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: MAX_TEST_BUFFER,
      env: process.env,
    });
    return { ok: true, output: tail(`${stdout}\n${stderr}`.trim(), 8_000) };
  } catch (error) {
    const failure = error as {
      stdout?: string;
      stderr?: string;
      message?: string;
      killed?: boolean;
    };
    const output = `${failure.stdout ?? ""}\n${failure.stderr ?? failure.message ?? ""}`;
    return {
      ok: false,
      output: tail(
        `${failure.killed ? "Test command timed out.\n" : ""}${output}`.trim(),
        8_000,
      ),
    };
  }
}

export async function mergeTeamWorktree(options: {
  record: WorktreeRecord;
  leadCwd: string;
  teamDir: string;
  name: string;
  testCommand?: string;
  testTimeoutMs?: number;
  skipTests?: boolean;
  cleanup?: boolean;
}): Promise<MergeResult> {
  const { record } = options;
  const repo = await repoInfo(options.leadCwd);
  if (!repo) {
    return {
      status: "error",
      message: "The lead project is no longer inside a git repository.",
    };
  }
  if (repo.root !== record.repoRoot) {
    return {
      status: "error",
      message: `The project moved to ${repo.root}, but the worktree belongs to ${record.repoRoot}.`,
    };
  }
  if (!(await exists(record.path))) {
    return {
      status: "error",
      message: `Worktree ${record.path} is missing.`,
    };
  }

  const inProgress = await runGit(repo.root, [
    "rev-parse",
    "--verify",
    "--quiet",
    "MERGE_HEAD",
  ]);
  if (inProgress.code === 0) {
    return {
      status: "error",
      message: "A merge is already in progress in the lead working tree.",
    };
  }

  const dirty = await runGit(repo.root, ["status", "--porcelain"]);
  if (dirty.code !== 0) {
    return { status: "error", message: dirty.stderr.trim() };
  }
  const dirtyLines = dirty.stdout.split("\n").filter(Boolean);
  if (dirtyLines.length > 0) {
    return {
      status: "error",
      message:
        "The lead working tree has uncommitted changes. Commit or stash them " +
        "before merging a teammate worktree.\n" +
        dirtyLines.slice(0, 20).join("\n"),
    };
  }

  const staged = await runGit(record.path, ["add", "-A"]);
  if (staged.code !== 0) {
    return { status: "error", message: staged.stderr.trim() };
  }
  const changed = await runGit(record.path, ["diff", "--cached", "--quiet"]);
  if (changed.code !== 0) {
    const committed = await runGit(record.path, [
      "-c",
      "user.name=Ollama Agent",
      "-c",
      "user.email=ollama-agent@localhost",
      "commit",
      "--no-verify",
      "-m",
      `team(${options.name}): worktree changes`,
    ]);
    if (committed.code !== 0) {
      return {
        status: "error",
        message: committed.stderr.trim() || "Could not commit the worktree changes.",
      };
    }
  }

  const head = (await runGit(record.path, ["rev-parse", "HEAD"])).stdout.trim();
  if (head === record.baseCommit) {
    return {
      status: "no-changes",
      message: `${options.name} has no changes to merge.`,
    };
  }
  const stat = (
    await runGit(record.path, ["diff", "--stat", record.baseCommit])
  ).stdout.trim();

  const trialPath = path.join(
    options.teamDir,
    `trial-${safeBranchPart(options.name)}-${randomUUID().slice(0, 4)}`,
  );
  const trial = await runGit(repo.root, [
    "worktree",
    "add",
    "--detach",
    trialPath,
    "HEAD",
  ]);
  if (trial.code !== 0) {
    return {
      status: "error",
      message: trial.stderr.trim() || "Could not create the trial merge worktree.",
    };
  }
  await linkDependencies(repo.root, trialPath);
  const testCwd = path.join(
    trialPath,
    path.relative(record.path, record.cwd),
  );
  await linkDependencies(options.leadCwd, testCwd);

  let trialMerged = false;
  let testCommand = options.testCommand?.trim() || undefined;
  let testOutput = "";
  let testNote = "";
  try {
    const merged = await runGit(trialPath, [
      "merge",
      "--no-ff",
      "--no-commit",
      record.branch,
    ]);
    if (merged.code !== 0) {
      await runGit(trialPath, ["merge", "--abort"]);
      return {
        status: "conflict",
        message:
          "The trial merge conflicts with the lead branch. Resolve it by hand; " +
          "conflicts are never resolved by a model.\n" +
          (merged.stderr.trim() || merged.stdout.trim()),
      };
    }
    trialMerged = true;

    if (options.skipTests) {
      testNote = "Tests skipped at the lead's request.";
    } else {
      testCommand =
        testCommand ??
        (await detectTestCommand(options.leadCwd)) ??
        (await detectTestCommand(repo.root));
      if (testCommand) {
        const result = await runTestCommand(
          testCwd,
          testCommand,
          options.testTimeoutMs ?? 300_000,
        );
        testOutput = result.output;
        if (!result.ok) {
          return {
            status: "tests-failed",
            message:
              `Tests failed in the trial merge: ${testCommand}\n\n${result.output}`,
            testCommand,
          };
        }
        testNote = `Tests passed: ${testCommand}`;
      } else {
        testNote =
          "No test command detected; the trial merge was clean but no tests ran.";
      }
    }
  } finally {
    if (trialMerged) await runGit(trialPath, ["merge", "--abort"]);
    await runGit(repo.root, ["worktree", "remove", "--force", trialPath]);
  }

  const target = await runGit(repo.root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const merge = await runGit(repo.root, [
    "-c",
    "user.name=Ollama Agent",
    "-c",
    "user.email=ollama-agent@localhost",
    "merge",
    "--no-ff",
    "-m",
    `Merge team worktree "${options.name}" (${record.branch})`,
    record.branch,
  ]);
  if (merge.code !== 0) {
    await runGit(repo.root, ["merge", "--abort"]);
    return {
      status: "conflict",
      message:
        "The final merge failed after a clean trial merge; the merge was " +
        "aborted and the lead tree was left unchanged.\n" +
        (merge.stderr.trim() || merge.stdout.trim()),
    };
  }

  const mergeCommit = (await runGit(repo.root, ["rev-parse", "HEAD"])).stdout.trim();
  let cleanupNote = "";
  let cleaned = false;
  if (options.cleanup) {
    const problem = await removeTeamWorktree(record);
    cleaned = !problem;
    cleanupNote = problem
      ? `\nCleanup warning: ${problem}`
      : `\nWorktree and branch ${record.branch} removed.`;
  }

  const lines = [
    `Merged ${options.name} into ${target.stdout.trim() || "HEAD"} at ${mergeCommit.slice(0, 12)}.`,
    `Branch: ${record.branch}`,
    `Trial merge: clean`,
    testNote,
  ];
  if (stat) {
    lines.push("");
    lines.push(stat);
  }
  if (testOutput) {
    lines.push("");
    lines.push("Test output (tail):");
    lines.push(tail(testOutput, 2_000));
  }
  lines.push(cleanupNote.trimEnd());
  return {
    status: "merged",
    message: lines.filter(Boolean).join("\n"),
    mergeCommit,
    testCommand,
    cleaned,
  };
}

export async function worktreeExists(record: WorktreeRecord): Promise<boolean> {
  try {
    const info = await lstat(record.path);
    return info.isDirectory();
  } catch {
    return false;
  }
}

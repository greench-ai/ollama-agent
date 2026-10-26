import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { CheckpointStore } from "./checkpoints.ts";
import {
  agentHome,
  deleteSessionTitlePrefix,
  sessionsDir,
} from "./session.ts";
import { isSessionId } from "./sessions.ts";
import { removeTeamWorktree } from "./worktree.ts";

export interface PurgeResult {
  sessions: number;
  deleteFiles: boolean;
  warnings: string[];
}

function dataDir(): string {
  return agentHome();
}

async function removeRelatedSessionFiles(id: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(sessionsDir());
  } catch {
    return;
  }
  const exact = `${id}.jsonl`;
  const prefix = `${id}-`;
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    if (name !== exact && !name.startsWith(prefix)) continue;
    await unlink(path.join(sessionsDir(), name)).catch(() => {});
  }
  await deleteSessionTitlePrefix(id);
}

async function removeTelemetry(id: string): Promise<void> {
  const directory = path.join(dataDir(), "telemetry");
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === `${id}.jsonl` || name.startsWith(`${id}-`)) {
      await rm(path.join(directory, name), { force: true }).catch(() => {});
    }
  }
}

async function removeCheckpoints(
  id: string,
  restoreFiles: boolean,
  warnings: string[],
): Promise<void> {
  const store = new CheckpointStore(id);
  if (restoreFiles) {
    try {
      await store.restoreInitial();
    } catch (error) {
      warnings.push(
        `Could not restore files for ${id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  await rm(store.root, { recursive: true, force: true }).catch(() => {});
}

interface TeamMemberFile {
  name?: string;
  worktreePath?: string;
  worktreeCwd?: string;
  repoRoot?: string;
  branch?: string;
  baseCommit?: string;
}

async function removeTeamData(
  id: string,
  restoreFiles: boolean,
  warnings: string[],
): Promise<void> {
  const directory = path.join(dataDir(), "teams", id);
  try {
    const raw = JSON.parse(
      await readFile(path.join(directory, "team.json"), "utf8"),
    ) as { members?: TeamMemberFile[] };
    for (const member of raw.members ?? []) {
      if (
        !member.worktreePath ||
        !member.repoRoot ||
        !member.branch ||
        !member.baseCommit
      ) {
        continue;
      }
      try {
        const problem = await removeTeamWorktree(
          {
            path: member.worktreePath,
            cwd: member.worktreeCwd ?? member.worktreePath,
            repoRoot: member.repoRoot,
            branch: member.branch,
            baseCommit: member.baseCommit,
          },
          { deleteBranch: restoreFiles },
        );
        if (problem) {
          warnings.push(
            `Worktree for ${id}/${member.name ?? "member"}: ${problem}. Run git worktree prune.`,
          );
        }
      } catch (error) {
        warnings.push(
          `Worktree for ${id}/${member.name ?? "member"} was not removed: ${
            error instanceof Error ? error.message : String(error)
          }. Run git worktree prune.`,
        );
      }
    }
  } catch {
    // No team state, or it was already removed.
  }
  await rm(directory, { recursive: true, force: true }).catch(() => {});
}

async function pruneBackgroundJobs(target: string[] | "all"): Promise<void> {
  const file = path.join(dataDir(), "background", "state.json");
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    return;
  }
  const jobs = Array.isArray(raw.jobs)
    ? (raw.jobs as Array<Record<string, unknown>>)
    : [];
  const ids = target === "all" ? undefined : new Set(target);
  const filtered = jobs.filter((job) => {
    if (!ids) return false;
    return !(
      typeof job.sessionId === "string" && ids.has(job.sessionId)
    );
  });
  if (filtered.length === jobs.length) return;
  raw.jobs = filtered;
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp`;
  await writeFile(temporary, JSON.stringify(raw, null, 2), "utf8");
  await rename(temporary, file);
}

export async function purgeSession(
  id: string,
  options: { deleteFiles?: boolean } = {},
): Promise<PurgeResult> {
  if (!isSessionId(id)) throw new Error("Invalid session id.");
  const warnings: string[] = [];
  const deleteFiles = options.deleteFiles === true;
  await removeRelatedSessionFiles(id);
  await removeCheckpoints(id, deleteFiles, warnings);
  await removeTelemetry(id);
  await removeTeamData(id, deleteFiles, warnings);
  await pruneBackgroundJobs([id]);
  return { sessions: 1, deleteFiles, warnings };
}

async function mainSessionIds(): Promise<string[]> {
  try {
    return (await readdir(sessionsDir()))
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => name.slice(0, -".jsonl".length))
      .filter((id) => isSessionId(id));
  } catch {
    return [];
  }
}

async function checkpointSessionIds(): Promise<string[]> {
  try {
    return (await readdir(path.join(dataDir(), "checkpoints"), {
      withFileTypes: true,
    }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

async function teamSessionIds(): Promise<string[]> {
  try {
    return (await readdir(path.join(dataDir(), "teams"), {
      withFileTypes: true,
    }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export async function purgeAllSessions(
  options: { deleteFiles?: boolean } = {},
): Promise<PurgeResult> {
  const warnings: string[] = [];
  const deleteFiles = options.deleteFiles === true;
  const ids = await mainSessionIds();
  const teamIds = await teamSessionIds();

  if (deleteFiles) {
    // Newest first: restoring an older session afterwards leaves each file in
    // its state before the earliest session that touched it.
    for (const id of await checkpointSessionIds()) {
      try {
        await new CheckpointStore(id).restoreInitial();
      } catch (error) {
        warnings.push(
          `Could not restore files for ${id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  for (const id of teamIds) {
    await removeTeamData(id, deleteFiles, warnings);
  }

  await pruneBackgroundJobs("all");
  await rm(path.join(dataDir(), "sessions"), {
    recursive: true,
    force: true,
  }).catch(() => {});
  await rm(path.join(dataDir(), "checkpoints"), {
    recursive: true,
    force: true,
  }).catch(() => {});
  await rm(path.join(dataDir(), "telemetry"), {
    recursive: true,
    force: true,
  }).catch(() => {});
  await rm(path.join(dataDir(), "teams"), {
    recursive: true,
    force: true,
  }).catch(() => {});

  return { sessions: ids.length, deleteFiles, warnings };
}

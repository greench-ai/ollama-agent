import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { agentHome } from "./session.ts";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ENTRIES = 100;
const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);

export interface CheckpointFile {
  path: string;
  existed: boolean;
  backup?: string;
  note?: string;
}

export interface Checkpoint {
  id: string;
  at: string;
  tool: string;
  cwd: string;
  /** Message count when the checkpoint was taken (for future chat rewind). */
  messageCount?: number;
  files: CheckpointFile[];
}

export interface CheckpointSummary {
  id: string;
  at: string;
  tool: string;
  files: string[];
}

function newId(): string {
  return `cp-${Date.now()}-${randomUUID().slice(0, 4)}`;
}

function filePaths(input: Record<string, unknown>, cwd: string): string[] {
  const raw = input.file_path ?? input.notebook_path;
  if (typeof raw !== "string" || !raw.trim()) return [];
  return [path.resolve(cwd, raw.trim())];
}

export class CheckpointStore {
  readonly root: string;

  constructor(sessionId: string, home = agentHome()) {
    this.root = path.join(home, "checkpoints", sessionId);
  }

  private get entriesDir(): string {
    return path.join(this.root, "entries");
  }

  /**
   * Snapshot the files a mutating file tool is about to touch. Returns
   * undefined for tools that do not modify files.
   */
  async capture(
    tool: string,
    input: Record<string, unknown>,
    cwd: string,
    messageCount?: number,
    allowedRoot?: string,
  ): Promise<Checkpoint | undefined> {
    if (!FILE_TOOLS.has(tool)) return undefined;
    let paths = [...new Set(filePaths(input, cwd))];
    if (allowedRoot) {
      paths = paths.filter((target) => {
        const relative = path.relative(path.resolve(allowedRoot), target);
        return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
      });
    }
    if (paths.length === 0) return undefined;

    const id = newId();
    const entryDir = path.join(this.entriesDir, id);
    await mkdir(entryDir, { recursive: true, mode: 0o700 });
    const files: CheckpointFile[] = [];

    for (const [index, target] of paths.entries()) {
      const record: CheckpointFile = { path: target, existed: false };
      let info;
      try {
        info = await stat(target);
      } catch {
        files.push(record);
        continue;
      }
      record.existed = true;
      if (!info.isFile()) {
        record.note = "not a regular file";
        files.push(record);
        continue;
      }
      if (info.size > MAX_FILE_BYTES) {
        record.note = `too large to back up (${info.size} bytes)`;
        files.push(record);
        continue;
      }
      const backup = path.join(entryDir, `file-${index}`);
      try {
        await copyFile(target, backup);
        record.backup = backup;
      } catch (error) {
        record.note = `backup failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      files.push(record);
    }

    const checkpoint: Checkpoint = {
      id,
      at: new Date().toISOString(),
      tool,
      cwd,
      messageCount,
      files,
    };
    await writeFile(
      path.join(entryDir, "checkpoint.json"),
      JSON.stringify(checkpoint, null, 2),
      "utf8",
    );
    await this.prune();
    return checkpoint;
  }

  async list(limit = 50): Promise<CheckpointSummary[]> {
    let entries;
    try {
      entries = await readdir(this.entriesDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const ids = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse()
      .slice(0, Math.max(0, limit));

    const summaries: CheckpointSummary[] = [];
    for (const id of ids) {
      try {
        const raw = JSON.parse(
          await readFile(path.join(this.entriesDir, id, "checkpoint.json"), "utf8"),
        ) as Checkpoint;
        summaries.push({
          id: raw.id ?? id,
          at: raw.at ?? "",
          tool: raw.tool ?? "",
          files: (raw.files ?? []).map((file) => file.path),
        });
      } catch {
        // Skip corrupt checkpoints.
      }
    }
    return summaries;
  }

  async restore(id: string): Promise<string> {
    const safe = path.basename(id);
    const entryDir = path.join(this.entriesDir, safe);
    let checkpoint: Checkpoint;
    try {
      checkpoint = JSON.parse(
        await readFile(path.join(entryDir, "checkpoint.json"), "utf8"),
      ) as Checkpoint;
    } catch {
      throw new Error(`Unknown checkpoint "${id}".`);
    }

    const lines: string[] = [`Restored checkpoint ${safe} (${checkpoint.tool}).`];
    for (const file of checkpoint.files) {
      try {
        if (!file.existed) {
          await rm(file.path, { force: true });
          lines.push(`  removed ${file.path}`);
          continue;
        }
        if (!file.backup) {
          lines.push(`  skipped ${file.path}: ${file.note ?? "no backup"}`);
          continue;
        }
        await mkdir(path.dirname(file.path), { recursive: true });
        await copyFile(file.backup, file.path);
        lines.push(`  restored ${file.path}`);
      } catch (error) {
        lines.push(
          `  failed ${file.path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return lines.join("\n");
  }

  private async prune(max = MAX_ENTRIES): Promise<void> {
    let entries;
    try {
      entries = await readdir(this.entriesDir, { withFileTypes: true });
    } catch {
      return;
    }
    const ids = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const id of ids.slice(max)) {
      await rm(path.join(this.entriesDir, id), { recursive: true, force: true });
    }
  }
}

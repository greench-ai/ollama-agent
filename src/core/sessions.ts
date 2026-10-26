import { open, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import {
  Session,
  deleteSessionTitle,
  readSessionTitles,
  sessionsDir,
  setSessionTitle,
} from "./session.ts";
import type { Message } from "./types.ts";

/** Main session ids only; subagent transcripts use the same directory. */
const ID_PATTERN = /^\d{8}-\d{6}-[0-9a-f]{6}$/;

export function isSessionId(id: string): boolean {
  return ID_PATTERN.test(id);
}

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: string;
  model?: string;
  cwd?: string;
}

export interface LoadedSession extends SessionSummary {
  messages: Message[];
}

async function readFirstLine(file: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(file, "r");
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const line = buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0];
    return line || undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function listSessions(limit = 200): Promise<SessionSummary[]> {
  let names: string[];
  try {
    names = await readdir(sessionsDir());
  } catch {
    return [];
  }

  const titles = await readSessionTitles();
  const ids = names
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => name.slice(0, -".jsonl".length))
    .filter((id) => ID_PATTERN.test(id));

  const summaries = await Promise.all(
    ids.map(async (id): Promise<SessionSummary | undefined> => {
      const file = path.join(sessionsDir(), `${id}.jsonl`);
      try {
        const info = await stat(file);
        // A session containing only its meta line has no conversation yet.
        if (!titles[id] && info.size <= 200) return undefined;
        const metaLine = await readFirstLine(file);
        let meta: Record<string, unknown> = {};
        if (metaLine) {
          try {
            const parsed = JSON.parse(metaLine);
            if (parsed && typeof parsed === "object") {
              meta = parsed as Record<string, unknown>;
            }
          } catch {
            // Older or partial line: fall back to defaults.
          }
        }
        return {
          id,
          title: titles[id] ?? fallbackTitle(info.mtime),
          updatedAt: info.mtime.toISOString(),
          model: typeof meta.model === "string" ? meta.model : undefined,
          cwd: typeof meta.cwd === "string" ? meta.cwd : undefined,
        };
      } catch {
        return undefined;
      }
    }),
  );

  return summaries
    .filter((entry): entry is SessionSummary => entry !== undefined)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
}

function fallbackTitle(date: Date): string {
  return `Chat · ${date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

export async function loadSession(id: string): Promise<LoadedSession> {
  if (!ID_PATTERN.test(id)) throw new Error("Invalid session id.");
  const session = await Session.open(id);
  const messages = await session.loadMessages();
  const titles = await readSessionTitles();
  return {
    id,
    title: titles[id] ?? "New chat",
    updatedAt: new Date().toISOString(),
    model: session.model || undefined,
    cwd: session.cwd || undefined,
    messages,
  };
}

export function cleanTitle(title: string): string {
  const collapsed = title.replace(/\s+/g, " ").trim();
  return (collapsed || "New chat").slice(0, 120);
}

export async function renameSession(id: string, title: string): Promise<string> {
  if (!ID_PATTERN.test(id)) throw new Error("Invalid session id.");
  const cleaned = cleanTitle(title);
  await setSessionTitle(id, cleaned);
  return cleaned;
}

export async function deleteSession(id: string): Promise<void> {
  if (!ID_PATTERN.test(id)) throw new Error("Invalid session id.");
  await unlink(path.join(sessionsDir(), `${id}.jsonl`)).catch(() => {});
  await deleteSessionTitle(id);
}

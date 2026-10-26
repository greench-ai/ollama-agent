import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import type { Message, TodoItem } from "./types.ts";

export function agentHome(): string {
  return (
    process.env.OLLAMA_AGENT_HOME ??
    path.join(homedir(), ".local", "share", "ollama-agent")
  );
}

export function sessionsDir(): string {
  return path.join(agentHome(), "sessions");
}

function titlesPath(): string {
  return path.join(sessionsDir(), "index.json");
}

/** Session id -> display title. Kept outside the transcript so listing is cheap. */
export async function readSessionTitles(): Promise<Record<string, string>> {
  try {
    const raw = JSON.parse(await readFile(titlesPath(), "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, string> = {};
    for (const [id, title] of Object.entries(raw)) {
      if (typeof title === "string") out[id] = title;
    }
    return out;
  } catch {
    return {};
  }
}

async function writeSessionTitles(titles: Record<string, string>): Promise<void> {
  await mkdir(sessionsDir(), { recursive: true });
  await writeFile(titlesPath(), JSON.stringify(titles, null, 2), "utf8");
}

export async function getSessionTitle(id: string): Promise<string | undefined> {
  return (await readSessionTitles())[id];
}

export async function setSessionTitle(id: string, title: string): Promise<void> {
  const titles = await readSessionTitles();
  titles[id] = title;
  await writeSessionTitles(titles);
}

export async function deleteSessionTitle(id: string): Promise<void> {
  const titles = await readSessionTitles();
  if (!(id in titles)) return;
  delete titles[id];
  await writeSessionTitles(titles);
}

/** Remove a session title and every subagent/team title derived from it. */
export async function deleteSessionTitlePrefix(prefix: string): Promise<void> {
  const titles = await readSessionTitles();
  let changed = false;
  for (const key of Object.keys(titles)) {
    if (key === prefix || key.startsWith(`${prefix}-`)) {
      delete titles[key];
      changed = true;
    }
  }
  if (changed) await writeSessionTitles(titles);
}

export type SessionRecord =
  | { type: "meta"; id: string; createdAt: string; cwd: string; model: string }
  | { type: "message"; message: Message }
  | { type: "todos"; todos: TodoItem[] };

export class Session {
  readonly id: string;
  readonly file: string;
  readonly createdAt: string;
  cwd: string;
  model: string;

  constructor(options: {
    id?: string;
    file?: string;
    createdAt?: string;
    cwd: string;
    model: string;
  }) {
    this.id = options.id ?? newId();
    this.file = options.file ?? path.join(sessionsDir(), `${this.id}.jsonl`);
    this.createdAt = options.createdAt ?? new Date().toISOString();
    this.cwd = options.cwd;
    this.model = options.model;
  }

  static async create(options: {
    cwd: string;
    model: string;
    id?: string;
  }): Promise<Session> {
    await mkdir(sessionsDir(), { recursive: true });
    const session = new Session(options);
    await session.append({
      type: "meta",
      id: session.id,
      createdAt: session.createdAt,
      cwd: session.cwd,
      model: session.model,
    });
    return session;
  }

  static async open(id: string): Promise<Session> {
    const file = path.join(sessionsDir(), `${id}.jsonl`);
    const text = await readFile(file, "utf8");
    let cwd = process.cwd();
    let model = "";
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const record = JSON.parse(line) as SessionRecord;
      if (record.type === "meta") {
        cwd = record.cwd;
        model = record.model;
        return new Session({ id, file, createdAt: record.createdAt, cwd, model });
      }
    }
    return new Session({ id, file, cwd, model });
  }

  static async latest(): Promise<Session | undefined> {
    try {
      const entries = await readdir(sessionsDir());
      const files = entries
        .filter((name) => name.endsWith(".jsonl"))
        .sort()
        .reverse();
      if (files.length === 0) return undefined;
      return await Session.open(files[0].replace(/\.jsonl$/, ""));
    } catch {
      return undefined;
    }
  }

  async append(record: SessionRecord): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    await appendFile(this.file, `${JSON.stringify(record)}\n`, "utf8");
  }

  async appendMessage(message: Message): Promise<void> {
    await this.append({ type: "message", message });
  }

  async setTitle(title: string): Promise<void> {
    await setSessionTitle(this.id, title);
  }

  async appendTodos(todos: TodoItem[]): Promise<void> {
    await this.append({ type: "todos", todos });
  }

  async loadMessages(): Promise<Message[]> {
    try {
      const text = await readFile(this.file, "utf8");
      const messages: Message[] = [];
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        const record = JSON.parse(line) as SessionRecord;
        if (record.type === "message") messages.push(record.message);
      }
      return messages;
    } catch {
      return [];
    }
  }
}

function newId(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "")
    .replace("T", "-");
  return `${stamp}-${randomUUID().slice(0, 6)}`;
}

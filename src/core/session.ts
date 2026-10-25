import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
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

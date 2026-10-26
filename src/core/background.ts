import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { PermissionMode } from "./permissions.ts";
import { Session, agentHome } from "./session.ts";
import type { Message } from "./types.ts";

export type BackgroundJobStatus =
  | "queued"
  | "running"
  | "done"
  | "error"
  | "cancelled";

export interface BackgroundJob {
  id: string;
  title: string;
  prompt: string;
  cwd: string;
  model: string;
  mode: PermissionMode;
  status: BackgroundJobStatus;
  scheduleId?: string;
  sessionId?: string;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  report?: string;
  error?: string;
}

export interface BackgroundSchedule {
  id: string;
  name: string;
  prompt: string;
  cwd: string;
  model: string;
  mode: PermissionMode;
  cron: string;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  nextRunAt?: string;
}

export interface BackgroundState {
  jobs: BackgroundJob[];
  schedules: BackgroundSchedule[];
  maxConcurrent: number;
}

export interface BackgroundAgent {
  messages: Message[];
  signal?: AbortSignal;
  run(prompt: string): Promise<void>;
  close?(): Promise<void> | void;
}

export interface BackgroundAgentFactoryInput {
  jobId: string;
  title: string;
  cwd: string;
  model: string;
  mode: PermissionMode;
}

export interface BackgroundAgentFactory {
  (
    input: BackgroundAgentFactoryInput,
  ): Promise<{ agent: BackgroundAgent; session: Session }>;
}

export type BackgroundEvent =
  | { type: "background_state"; state: BackgroundState }
  | { type: "notice"; text: string };

export interface BackgroundManagerOptions {
  home?: string;
  createAgent: BackgroundAgentFactory;
  onEvent?: (event: BackgroundEvent) => void;
  maxConcurrent?: number;
  /** Start the schedule timer (default true). Tests can disable it. */
  autoStart?: boolean;
  tickMs?: number;
}

interface ActiveJob {
  agent?: BackgroundAgent;
  controller: AbortController;
  promise: Promise<void>;
}

interface ParsedField {
  values: Set<number>;
  restricted: boolean;
}

interface CronSpec {
  minute: ParsedField;
  hour: ParsedField;
  dom: ParsedField;
  month: ParsedField;
  dow: ParsedField;
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};
const DAY_NAMES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

function parseValue(
  raw: string,
  min: number,
  max: number,
  names?: Record<string, number>,
): number {
  const text = raw.trim().toLowerCase();
  const named = names?.[text];
  const value = named ?? Number(text);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Cron value "${raw}" is outside ${min}-${max}.`);
  }
  return value;
}

function parseField(
  raw: string,
  min: number,
  max: number,
  names?: Record<string, number>,
  normalize?: (value: number) => number,
): ParsedField {
  const text = raw.trim();
  if (!text) throw new Error("Empty cron field.");
  if (text === "*" || text === "?") {
    const values = new Set<number>();
    for (let value = min; value <= max; value += 1) values.add(value);
    return { values, restricted: false };
  }
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    let step = 1;
    if (stepPart !== undefined) {
      step = Number(stepPart);
      if (!Number.isInteger(step) || step <= 0) {
        throw new Error(`Invalid cron step "${part}".`);
      }
    }
    let start = min;
    let end = max;
    if (rangePart !== "*") {
      const [startRaw, endRaw] = rangePart.split("-");
      start = parseValue(startRaw, min, max, names);
      end = endRaw === undefined ? (stepPart ? max : start) : parseValue(endRaw, min, max, names);
      if (end < start) throw new Error(`Invalid cron range "${part}".`);
    }
    for (let value = start; value <= end; value += step) {
      values.add(normalize ? normalize(value) : value);
    }
  }
  return { values, restricted: true };
}

/** Parse a standard five-field cron expression. */
export function parseCron(expression: string): CronSpec {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error("Cron expressions need five fields: minute hour day month weekday.");
  }
  return {
    minute: parseField(fields[0], 0, 59),
    hour: parseField(fields[1], 0, 23),
    dom: parseField(fields[2], 1, 31),
    month: parseField(fields[3], 1, 12, MONTH_NAMES),
    dow: parseField(fields[4], 0, 7, DAY_NAMES, (value) => (value === 7 ? 0 : value)),
  };
}

export function cronMatches(expression: string, date: Date): boolean {
  const spec = parseCron(expression);
  if (!spec.minute.values.has(date.getMinutes())) return false;
  if (!spec.hour.values.has(date.getHours())) return false;
  if (!spec.month.values.has(date.getMonth() + 1)) return false;
  const domMatch = spec.dom.values.has(date.getDate());
  const dowMatch = spec.dow.values.has(date.getDay());
  if (spec.dom.restricted && spec.dow.restricted) return domMatch || dowMatch;
  return domMatch && dowMatch;
}

/** Next matching minute strictly after `from`, or undefined within two years. */
export function nextCron(expression: string, from = new Date()): Date | undefined {
  const spec = parseCron(expression);
  const cursor = new Date(from);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  const limit = 2 * 366 * 24 * 60;
  for (let step = 0; step < limit; step += 1) {
    if (
      spec.minute.values.has(cursor.getMinutes()) &&
      spec.hour.values.has(cursor.getHours()) &&
      spec.month.values.has(cursor.getMonth() + 1)
    ) {
      const domMatch = spec.dom.values.has(cursor.getDate());
      const dowMatch = spec.dow.values.has(cursor.getDay());
      const dayMatch =
        spec.dom.restricted && spec.dow.restricted
          ? domMatch || dowMatch
          : domMatch && dowMatch;
      if (dayMatch) return new Date(cursor);
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return undefined;
}

function now(): string {
  return new Date().toISOString();
}

function lastAssistantText(messages: Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role !== "assistant") continue;
    const text = messages[index].content
      .filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

function titleFor(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim().slice(0, 70) || "Background job";
}

export class BackgroundManager {
  private options: BackgroundManagerOptions;
  private state?: BackgroundState;
  private statePromise?: Promise<BackgroundState>;
  private active = new Map<string, ActiveJob>();
  private saveChain: Promise<void> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private pumping = false;
  private closed = false;

  constructor(options: BackgroundManagerOptions) {
    this.options = options;
  }

  static async load(options: BackgroundManagerOptions): Promise<BackgroundManager> {
    const manager = new BackgroundManager(options);
    await manager.ensureState();
    if (options.autoStart !== false) {
      manager.start();
      void manager.pump();
    }
    return manager;
  }

  private get root(): string {
    return path.join(
      this.options.home ?? agentHome(),
      "background",
    );
  }

  private get stateFile(): string {
    return path.join(this.root, "state.json");
  }

  private createInitialState(): BackgroundState {
    return {
      jobs: [],
      schedules: [],
      maxConcurrent: this.options.maxConcurrent ?? 2,
    };
  }

  private normalize(raw: unknown): BackgroundState {
    const base = this.createInitialState();
    if (!raw || typeof raw !== "object") return base;
    const data = raw as Record<string, unknown>;
    const jobs = Array.isArray(data.jobs)
      ? (data.jobs as BackgroundJob[]).map((job): BackgroundJob =>
          job.status === "running" || job.status === "queued"
            ? {
                ...job,
                status: job.status === "running" ? "error" : "queued",
                error:
                  job.status === "running"
                    ? "Interrupted by restart."
                    : job.error,
                endedAt: job.status === "running" ? now() : job.endedAt,
              }
            : job,
        )
      : [];
    const schedules = Array.isArray(data.schedules)
      ? (data.schedules as BackgroundSchedule[]).map((schedule) => {
          if (!schedule.enabled) return schedule;
          try {
            const next = nextCron(schedule.cron, new Date());
            return { ...schedule, nextRunAt: next?.toISOString() };
          } catch {
            return { ...schedule, enabled: false };
          }
        })
      : [];
    return {
      jobs: jobs.slice(-200),
      schedules: schedules.slice(-50),
      maxConcurrent:
        typeof data.maxConcurrent === "number" && data.maxConcurrent > 0
          ? Math.min(4, Math.floor(data.maxConcurrent))
          : base.maxConcurrent,
    };
  }

  private async ensureState(): Promise<BackgroundState> {
    if (this.state) return this.state;
    if (this.statePromise) return this.statePromise;
    this.statePromise = (async () => {
      try {
        this.state = this.normalize(
          JSON.parse(await readFile(this.stateFile, "utf8")),
        );
      } catch {
        this.state = this.createInitialState();
      }
      await this.save();
      return this.state;
    })();
    return this.statePromise;
  }

  private queueSave(): Promise<void> {
    if (!this.state) return Promise.resolve();
    const payload = JSON.stringify(this.state, null, 2);
    this.saveChain = this.saveChain
      .then(async () => {
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        const temporary = `${this.stateFile}.tmp`;
        await writeFile(temporary, payload, "utf8");
        await rename(temporary, this.stateFile);
      })
      .catch(() => {});
    return this.saveChain;
  }

  private async save(): Promise<void> {
    await this.queueSave();
  }

  private snapshot(): BackgroundState {
    const state = this.state as BackgroundState;
    return {
      maxConcurrent: state.maxConcurrent,
      jobs: state.jobs.map((job) => ({ ...job })),
      schedules: state.schedules.map((schedule) => ({ ...schedule })),
    };
  }

  private emit(): void {
    if (!this.state) return;
    this.options.onEvent?.({ type: "background_state", state: this.snapshot() });
  }

  start(): void {
    if (this.timer || this.closed) return;
    const tick = () => {
      void this.tick();
    };
    void this.tick();
    this.timer = setInterval(tick, this.options.tickMs ?? 30_000);
    this.timer.unref?.();
  }

  async stateSnapshot(): Promise<BackgroundState> {
    await this.ensureState();
    return this.snapshot();
  }

  async dispatch(input: {
    prompt: string;
    cwd: string;
    model: string;
    mode?: PermissionMode;
    title?: string;
    scheduleId?: string;
  }): Promise<BackgroundJob> {
    const state = await this.ensureState();
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error("A background prompt is required.");
    const job: BackgroundJob = {
      id: `job-${randomUUID().slice(0, 8)}`,
      title: input.title?.trim() || titleFor(prompt),
      prompt,
      cwd: input.cwd,
      model: input.model,
      mode: input.mode ?? "acceptEdits",
      status: "queued",
      scheduleId: input.scheduleId,
      createdAt: now(),
    };
    state.jobs.push(job);
    if (state.jobs.length > 200) state.jobs = state.jobs.slice(-200);
    await this.save();
    this.emit();
    void this.pump();
    return { ...job };
  }

  private async pump(): Promise<void> {
    if (this.closed || this.pumping) return;
    this.pumping = true;
    try {
      const state = await this.ensureState();
      while (
        !this.closed &&
        this.active.size < state.maxConcurrent &&
        state.jobs.some((job) => job.status === "queued")
      ) {
        const job = state.jobs.find((entry) => entry.status === "queued");
        if (!job) break;
        await this.startJob(job);
      }
    } finally {
      this.pumping = false;
    }
  }

  private async startJob(job: BackgroundJob): Promise<void> {
    job.status = "running";
    job.startedAt = now();
    job.error = undefined;
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let agent: BackgroundAgent | undefined;
    let session: Session | undefined;
    const controller = new AbortController();
    const runtime: ActiveJob = { controller, promise: done };
    this.active.set(job.id, runtime);
    await this.save();
    this.emit();

    const promise = (async () => {
      try {
        const created = await this.options.createAgent({
          jobId: job.id,
          title: job.title,
          cwd: job.cwd,
          model: job.model,
          mode: job.mode,
        });
        agent = created.agent;
        session = created.session;
        runtime.agent = agent;
        job.sessionId = session.id;
        agent.signal = controller.signal;
        await agent.run(job.prompt);
        job.status = controller.signal.aborted ? "cancelled" : "done";
        job.report = lastAssistantText(agent.messages);
      } catch (error) {
        job.status = controller.signal.aborted ? "cancelled" : "error";
        job.error = error instanceof Error ? error.message : String(error);
      } finally {
        job.endedAt = now();
        try {
          await agent?.close?.();
        } catch {
          // Ignore cleanup errors.
        }
        this.active.delete(job.id);
        finish();
        await this.save();
        this.emit();
        if (!this.closed) void this.pump();
      }
    })();
    void promise.catch(() => {});
  }

  async cancel(id: string): Promise<string> {
    const state = await this.ensureState();
    const job = state.jobs.find((entry) => entry.id === id);
    if (!job) throw new Error(`Unknown background job "${id}".`);
    if (job.status === "queued") {
      job.status = "cancelled";
      job.endedAt = now();
      await this.save();
      this.emit();
      return `Cancelled queued job ${id}.`;
    }
    const active = this.active.get(id);
    if (!active) return `Job ${id} is not running.`;
    active.controller.abort();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        active.promise,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 5_000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return `Cancelled job ${id}.`;
  }

  async transcript(id: string): Promise<Message[]> {
    const state = await this.ensureState();
    const job = state.jobs.find((entry) => entry.id === id);
    if (!job) return [];
    const active = this.active.get(id);
    if (active?.agent) return [...active.agent.messages];
    if (!job.sessionId) return [];
    try {
      const session = await Session.open(job.sessionId);
      return await session.loadMessages();
    } catch {
      return [];
    }
  }

  async addSchedule(input: {
    name: string;
    prompt: string;
    cron: string;
    cwd: string;
    model: string;
    mode?: PermissionMode;
    enabled?: boolean;
  }): Promise<BackgroundSchedule> {
    const state = await this.ensureState();
    const name = input.name.trim();
    const prompt = input.prompt.trim();
    if (!name || !prompt) throw new Error("Schedule name and prompt are required.");
    const cron = input.cron.trim();
    const next = nextCron(cron, new Date());
    if (!next) throw new Error("Cron expression has no run within two years.");
    const schedule: BackgroundSchedule = {
      id: `sch-${randomUUID().slice(0, 8)}`,
      name,
      prompt,
      cron,
      cwd: input.cwd,
      model: input.model,
      mode: input.mode ?? "acceptEdits",
      enabled: input.enabled !== false,
      createdAt: now(),
      nextRunAt: next.toISOString(),
    };
    state.schedules.push(schedule);
    if (state.schedules.length > 50) state.schedules = state.schedules.slice(-50);
    await this.save();
    this.emit();
    return { ...schedule };
  }

  async removeSchedule(id: string): Promise<string> {
    const state = await this.ensureState();
    const before = state.schedules.length;
    state.schedules = state.schedules.filter((schedule) => schedule.id !== id);
    if (state.schedules.length === before) {
      throw new Error(`Unknown schedule "${id}".`);
    }
    await this.save();
    this.emit();
    return `Removed schedule ${id}.`;
  }

  async tick(at = Date.now()): Promise<void> {
    const state = await this.ensureState();
    const nowMs = at;
    let changed = false;
    for (const schedule of state.schedules) {
      if (!schedule.enabled) continue;
      const next = schedule.nextRunAt
        ? Date.parse(schedule.nextRunAt)
        : Number.NaN;
      if (!Number.isFinite(next) || next > nowMs) continue;
      schedule.lastRunAt = new Date(nowMs).toISOString();
      const upcoming = nextCron(schedule.cron, new Date(nowMs));
      schedule.nextRunAt = upcoming?.toISOString();
      changed = true;
      try {
        await this.dispatch({
          prompt: schedule.prompt,
          cwd: schedule.cwd,
          model: schedule.model,
          mode: schedule.mode,
          title: schedule.name,
          scheduleId: schedule.id,
        });
      } catch (error) {
        this.options.onEvent?.({
          type: "notice",
          text: `[schedule] ${schedule.name}: ${error instanceof Error ? error.message : error}`,
        });
      }
    }
    if (changed) {
      await this.save();
      this.emit();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const active of this.active.values()) active.controller.abort();
    await this.save();
  }
}

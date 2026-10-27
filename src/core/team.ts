import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentDefinition } from "./agent-definitions.ts";
import type { PermissionEngine } from "./permissions.ts";
import { Session, agentHome } from "./session.ts";
import type { Message, Tool } from "./types.ts";
import {
  createTeamWorktree,
  mergeTeamWorktree,
  removeTeamWorktree,
  reviewTeamWorktree,
  type WorktreeRecord,
} from "./worktree.ts";
import type { SkillDefinition } from "./skills.ts";
import type { HooksEngine } from "./hooks.ts";

export type TeamMemberStatus = "idle" | "running" | "offline" | "error";
export type TeamTaskStatus = "pending" | "in_progress" | "completed" | "blocked";
export type TeamRunStatus = "running" | "done" | "error" | "cancelled";

export interface TeamMember {
  name: string;
  role: string;
  model: string;
  status: TeamMemberStatus;
  sessionId: string;
  createdAt: string;
  lastActiveAt?: string;
  currentTaskId?: string;
  currentRunId?: string;
  turns: number;
  error?: string;
  isolation?: "worktree" | "none";
  worktreePath?: string;
  worktreeCwd?: string;
  repoRoot?: string;
  branch?: string;
  baseCommit?: string;
  mergedAt?: string;
  mergeCommit?: string;
}

export interface TeamTask {
  id: string;
  title: string;
  description: string;
  status: TeamTaskStatus;
  assignee?: string;
  dependsOn: string[];
  files: string[];
  result?: string;
  blockedReason?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface TeamMessage {
  id: string;
  from: string;
  to: string;
  text: string;
  at: string;
  read: boolean;
}

export interface TeamRun {
  id: string;
  agent: string;
  prompt: string;
  status: TeamRunStatus;
  startedAt: string;
  endedAt?: string;
  report?: string;
  error?: string;
}

export interface TeamSettings {
  maxMembers: number;
  maxConcurrentRuns: number;
  maxTurns: number;
  maxAutoTurns: number;
  testCommand?: string;
  testTimeoutMs?: number;
}

export interface TeamState {
  id: string;
  name: string;
  createdAt: string;
  leadSessionId: string;
  members: TeamMember[];
  tasks: TeamTask[];
  runs: TeamRun[];
  messages: TeamMessage[];
  settings: TeamSettings;
}

export type TeamStateSnapshot = TeamState;

export type TeamStreamKind =
  | "text"
  | "thinking"
  | "tool_start"
  | "tool_end"
  | "error"
  | "done";

export type TeamEvent =
  | { type: "team_state"; state: TeamStateSnapshot }
  | {
      type: "stream";
      agent: string;
      kind: TeamStreamKind;
      text?: string;
      name?: string;
      summary?: string;
      content?: string;
      isError?: boolean;
    }
  | { type: "notice"; text: string };

export type TeamAgentEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_start"; name: string; summary: string }
  | { type: "tool_end"; name: string; content: string; isError: boolean }
  | { type: "error"; message: string }
  | { type: "done" };

export interface TeamAgentConfig {
  name: string;
  model: string;
  tools: Tool[];
  permissions: PermissionEngine;
  session: Session;
  system: string;
  maxTurns: number;
  cwd?: string;
  workspaceRoot?: string;
  skills?: Map<string, SkillDefinition>;
  hooks?: HooksEngine;
  messages?: Message[];
  onEvent: (event: TeamAgentEvent) => void;
}

export interface TeamAgent {
  messages: Message[];
  signal?: AbortSignal;
  run(prompt: string): Promise<void>;
  contextUsage(): { used: number; budget: number };
}

export interface TeamAgentFactory {
  (config: TeamAgentConfig): TeamAgent;
}

export interface TeamManagerOptions {
  leadModel: string;
  baseTools: Tool[];
  memberTools: Tool[];
  permissions: PermissionEngine;
  cwd: string;
  parentSessionId: string;
  agentDefinitions: Map<string, AgentDefinition>;
  skills?: Map<string, SkillDefinition>;
  hooks?: HooksEngine;
  createAgent: TeamAgentFactory;
  onEvent: (event: TeamEvent) => void;
}

/** The surface team tools use; keeps tools independent of the manager class. */
export interface TeamController {
  spawn(
    caller: string,
    input: {
      name: string;
      role: string;
      prompt?: string;
      model?: string;
      wait?: boolean;
      isolation?: "worktree" | "none";
    },
  ): Promise<string>;
  run(caller: string, name: string, prompt: string, wait?: boolean): Promise<string>;
  awaitMembers(names?: string[], timeoutMs?: number): Promise<string>;
  sendMessage(from: string, to: string, text: string): Promise<string>;
  review(
    caller: string,
    name: string,
    options?: { diff?: boolean; maxChars?: number },
  ): Promise<string>;
  merge(
    caller: string,
    name: string,
    options?: {
      testCommand?: string;
      skipTests?: boolean;
      cleanup?: boolean;
      timeoutMs?: number;
    },
  ): Promise<string>;
  taskAction(
    caller: string,
    action: "create" | "list" | "claim" | "complete" | "block",
    input: Record<string, unknown>,
  ): Promise<string>;
  statusText(): Promise<string>;
  shutdown(
    caller: string,
    name: string,
    options?: { removeWorktree?: boolean },
  ): Promise<string>;
  transcript(name: string): Promise<Message[]>;
  snapshot(): Promise<TeamStateSnapshot | null>;
}

interface MemberRuntime {
  session: Session;
  agent?: TeamAgent;
  controller?: AbortController;
  runPromise?: Promise<void>;
  currentRunId?: string;
  queued: string[];
  autoTurns: number;
}

const MEMBER_RULES = (
  team: string,
  name: string,
  role: string,
  cwd: string,
  worktree?: WorktreeRecord,
) => `
Team: ${team}
Member: ${name} (${role})
Working directory: ${cwd}${
  worktree
    ? `
Worktree: ${worktree.path} (branch ${worktree.branch}, base ${worktree.baseCommit.slice(0, 12)})`
    : ""
}

Team rules
- Use TeamTask to list, claim, and complete shared tasks; use TeamMessage to talk to teammates; use TeamStatus to inspect the board.
- You cannot spawn teammates or shut down the team.
- Do not ask the user questions; work autonomously on the delegated task.
- End each turn with a concise report of what you did, what you verified, and anything unresolved.${
  worktree
    ? `
- Work only inside your worktree. Do not run git commit, git checkout, git merge, or git push; leave changes for the lead to review and merge.`
    : `
- You share the working directory with the lead and other teammates. Reserve paths with TeamTask before editing.`
}`;

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

function toolBaseName(name: string): string {
  return name.split("(")[0].trim();
}

function sanitizeName(name: string): string {
  return name.trim().replace(/[^A-Za-z0-9._-]+/g, "-");
}

function memberWorktree(member: TeamMember): WorktreeRecord | undefined {
  if (
    !member.worktreePath ||
    !member.repoRoot ||
    !member.branch ||
    !member.baseCommit
  ) {
    return undefined;
  }
  return {
    path: member.worktreePath,
    cwd: member.worktreeCwd ?? member.worktreePath,
    repoRoot: member.repoRoot,
    branch: member.branch,
    baseCommit: member.baseCommit,
  };
}

export class TeamManager implements TeamController {
  private options: TeamManagerOptions;
  private state?: TeamState;
  private statePromise?: Promise<TeamState>;
  private runtimes = new Map<string, MemberRuntime>();
  private runPromises = new Map<string, Promise<void>>();
  private saveChain: Promise<void> = Promise.resolve();
  private lock: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(options: TeamManagerOptions) {
    this.options = options;
  }

  private get teamDir(): string {
    return path.join(agentHome(), "teams", this.options.parentSessionId);
  }

  private get stateFile(): string {
    return path.join(this.teamDir, "team.json");
  }

  private createInitialState(): TeamState {
    const id = this.options.parentSessionId;
    return {
      id,
      name: `team-${id.slice(-6)}`,
      createdAt: now(),
      leadSessionId: id,
      members: [],
      tasks: [],
      runs: [],
      messages: [],
      settings: {
        maxMembers: 6,
        maxConcurrentRuns: 3,
        maxTurns: 30,
        maxAutoTurns: 8,
      },
    };
  }

  private normalizeState(raw: unknown): TeamState {
    const base = this.createInitialState();
    if (!raw || typeof raw !== "object") return base;
    const data = raw as Record<string, unknown>;
    const members = Array.isArray(data.members)
      ? (data.members as TeamMember[]).map((member) => ({
          ...member,
          status: "offline" as TeamMemberStatus,
          currentRunId: undefined,
          currentTaskId: undefined,
        }))
      : [];
    return {
      ...base,
      name: typeof data.name === "string" ? data.name : base.name,
      createdAt: typeof data.createdAt === "string" ? data.createdAt : base.createdAt,
      members,
      tasks: Array.isArray(data.tasks) ? (data.tasks as TeamTask[]) : [],
      runs: Array.isArray(data.runs)
        ? (data.runs as TeamRun[]).map((run) =>
            run.status === "running"
              ? { ...run, status: "error", error: "Interrupted by restart." }
              : run,
          )
        : [],
      messages: Array.isArray(data.messages) ? (data.messages as TeamMessage[]) : [],
      settings: {
        ...base.settings,
        ...(data.settings && typeof data.settings === "object" ? data.settings : {}),
      },
    };
  }

  private async ensureState(): Promise<TeamState> {
    if (this.state) return this.state;
    if (this.statePromise) return this.statePromise;
    this.statePromise = (async () => {
      try {
        const raw = JSON.parse(await readFile(this.stateFile, "utf8"));
        this.state = this.normalizeState(raw);
      } catch {
        this.state = this.createInitialState();
        await this.save();
      }
      return this.state;
    })();
    return this.statePromise;
  }

  private queueSave(): Promise<void> {
    if (!this.state) return Promise.resolve();
    const payload = JSON.stringify(this.state, null, 2);
    this.saveChain = this.saveChain
      .then(async () => {
        await mkdir(this.teamDir, { recursive: true });
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

  private snapshotNow(): TeamStateSnapshot {
    const state = this.state as TeamState;
    return {
      ...state,
      members: state.members.map((member) => ({ ...member })),
      tasks: state.tasks.map((task) => ({
        ...task,
        dependsOn: [...task.dependsOn],
        files: [...task.files],
      })),
      runs: state.runs.slice(-100).map((run) => ({ ...run })),
      messages: state.messages.slice(-200).map((message) => ({ ...message })),
      settings: { ...state.settings },
    };
  }

  private emitState(): void {
    if (!this.state) return;
    this.options.onEvent({ type: "team_state", state: this.snapshotNow() });
  }

  async snapshot(): Promise<TeamStateSnapshot | null> {
    if (this.state) return this.snapshotNow();
    try {
      await access(this.stateFile);
    } catch {
      return null;
    }
    await this.ensureState();
    return this.state ? this.snapshotNow() : null;
  }

  async statusText(): Promise<string> {
    const state = await this.ensureState();
    const lines: string[] = [];
    lines.push(`Team ${state.name} — ${state.members.length} member(s)`);
    if (state.members.length > 0) {
      lines.push("Members:");
      for (const member of state.members) {
        const task = state.tasks.find((entry) => entry.id === member.currentTaskId);
        const lastRun = [...state.runs].reverse().find((run) => run.agent === member.name);
        const bits = [
          `${member.name} (${member.role}, ${member.model}): ${member.status}`,
        ];
        if (task) bits.push(`task: ${task.id} ${task.title}`);
        if (member.branch) bits.push(`worktree: ${member.branch}`);
        if (member.mergedAt) bits.push("merged");
        if (lastRun?.report) bits.push(`last: ${lastRun.report.slice(0, 300)}`);
        if (member.error) bits.push(`error: ${member.error}`);
        lines.push(`- ${bits.join(" · ")}`);
      }
    }
    if (state.tasks.length > 0) {
      lines.push("Tasks:");
      for (const task of state.tasks) {
        const suffix = task.assignee ? ` @${task.assignee}` : "";
        const deps =
          task.dependsOn.length > 0 ? ` deps: ${task.dependsOn.join(",")}` : "";
        lines.push(`- [${task.status}] ${task.id} ${task.title}${suffix}${deps}`);
      }
    }
    const unread = state.messages.filter((message) => !message.read).length;
    lines.push(`Messages: ${state.messages.length} total, ${unread} unread`);
    return lines.join("\n");
  }

  private findMember(name: string): TeamMember | undefined {
    return this.state?.members.find((member) => member.name === name);
  }

  private activeRunCount(): number {
    return (this.state?.runs ?? []).filter((run) => run.status === "running").length;
  }

  private filterTools(definition: AgentDefinition): Tool[] {
    let tools = this.options.baseTools.filter(
      (tool) => tool.name !== "Task" && tool.name !== "ExitPlanMode",
    );
    if (definition.disallowedTools && definition.disallowedTools.length > 0) {
      const denied = new Set(definition.disallowedTools.map(toolBaseName));
      tools = tools.filter((tool) => !denied.has(tool.name));
    }
    if (definition.tools && definition.tools.length > 0) {
      const allowed = new Set(definition.tools.map(toolBaseName));
      tools = tools.filter((tool) => allowed.has(tool.name));
    }
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const tool of this.options.memberTools) byName.set(tool.name, tool);
    const skillDenied = definition.disallowedTools?.some(
      (tool) => toolBaseName(tool) === "Skill",
    );
    if (!skillDenied) {
      const skill = this.options.baseTools.find((tool) => tool.name === "Skill");
      if (skill) byName.set("Skill", skill);
    }
    return [...byName.values()];
  }

  private async ensureRuntime(member: TeamMember): Promise<MemberRuntime> {
    const existing = this.runtimes.get(member.name);
    if (existing?.agent) return existing;

    let runtime = existing;
    let session: Session;
    let prior: Message[] = [];

    if (runtime) {
      session = runtime.session;
    } else {
      try {
        session = await Session.open(member.sessionId);
        prior = await session.loadMessages();
      } catch {
        session = await Session.create({
          cwd: this.options.cwd,
          model: member.model,
          id: `${this.options.parentSessionId}-team-${member.name}-${randomUUID().slice(0, 4)}`,
        });
        prior = [];
      }
      runtime = { session, queued: [], autoTurns: 0 };
      this.runtimes.set(member.name, runtime);
    }

    const definition = this.options.agentDefinitions.get(member.role);
    if (!definition) {
      throw new Error(`Agent definition "${member.role}" is no longer available.`);
    }

    const permissions = this.options.permissions.fork(
      definition.permissionMode ?? this.options.permissions.mode,
    );
    const worktree = memberWorktree(member);
    const memberCwd = worktree?.cwd ?? this.options.cwd;
    const system = `${definition.systemPrompt.trim()}\n\n${MEMBER_RULES(
      this.state?.name ?? "team",
      member.name,
      member.role,
      memberCwd,
      worktree,
    )}`;

    runtime.agent = this.options.createAgent({
      name: member.name,
      model: member.model,
      tools: this.filterTools(definition),
      permissions,
      session,
      system,
      maxTurns: definition.maxTurns ?? this.state?.settings.maxTurns ?? 30,
      cwd: memberCwd,
      workspaceRoot: worktree?.path,
      skills: this.options.skills,
      hooks: this.options.hooks,
      messages: prior,
      onEvent: (event) => this.handleMemberEvent(member.name, event),
    });
    return runtime;
  }

  private handleMemberEvent(name: string, event: TeamAgentEvent): void {
    const base = { type: "stream" as const, agent: name };
    switch (event.type) {
      case "text":
        this.options.onEvent({ ...base, kind: "text", text: event.text });
        break;
      case "thinking":
        this.options.onEvent({ ...base, kind: "thinking", text: event.text });
        break;
      case "tool_start":
        this.options.onEvent({
          ...base,
          kind: "tool_start",
          name: event.name,
          summary: event.summary,
        });
        break;
      case "tool_end":
        this.options.onEvent({
          ...base,
          kind: "tool_end",
          name: event.name,
          content: event.content,
          isError: event.isError,
        });
        break;
      case "error":
        this.options.onEvent({ ...base, kind: "error", content: event.message });
        break;
      case "done":
        this.options.onEvent({ ...base, kind: "done" });
        break;
    }
  }

  private finishRun(run: TeamRun, member: TeamMember, status: TeamRunStatus, report?: string, error?: string): void {
    run.status = status;
    run.endedAt = now();
    if (report !== undefined) run.report = report;
    if (error !== undefined) run.error = error;
    member.currentRunId = undefined;
    member.lastActiveAt = now();
    member.turns += 1;
    if (status === "cancelled") member.status = "offline";
    else if (status === "error") {
      member.status = "error";
      member.error = error;
    } else {
      member.status = "idle";
      member.error = undefined;
    }
  }

  private async withLock<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release = () => {};
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  private startRun(member: TeamMember, prompt: string): Promise<string> {
    return this.withLock(() => this.startRunUnlocked(member, prompt));
  }

  private async startRunUnlocked(member: TeamMember, prompt: string): Promise<string> {
    if (!this.state) throw new Error("Team is not initialized.");
    if (this.closed) throw new Error("Team is closed.");
    if (member.status === "running") {
      throw new Error(`Teammate "${member.name}" is already running.`);
    }
    if (this.activeRunCount() >= this.state.settings.maxConcurrentRuns) {
      throw new Error(
        `Concurrency limit reached (${this.state.settings.maxConcurrentRuns}). Await a run first.`,
      );
    }

    const runtime = await this.ensureRuntime(member);
    const agent = runtime.agent as TeamAgent;
    const run: TeamRun = {
      id: `run-${randomUUID().slice(0, 8)}`,
      agent: member.name,
      prompt,
      status: "running",
      startedAt: now(),
    };
    this.state.runs.push(run);
    member.status = "running";
    member.currentRunId = run.id;
    member.error = undefined;

    const controller = new AbortController();
    runtime.controller = controller;
    runtime.currentRunId = run.id;
    agent.signal = controller.signal;

    await this.save();
    this.emitState();

    const runPromise = (async () => {
      try {
        await agent.run(prompt);
        this.finishRun(run, member, "done", lastAssistantText(agent.messages));
      } catch (error) {
        if (controller.signal.aborted) {
          this.finishRun(run, member, "cancelled");
        } else {
          this.finishRun(
            run,
            member,
            "error",
            undefined,
            error instanceof Error ? error.message : String(error),
          );
        }
      } finally {
        runtime.controller = undefined;
        runtime.currentRunId = undefined;
        runtime.runPromise = undefined;
        this.runPromises.delete(run.id);
        await this.save();
        this.emitState();
        void this.deliverQueued(member.name);
      }
    })();

    runtime.runPromise = runPromise;
    this.runPromises.set(run.id, runPromise);
    return run.id;
  }

  private async deliverQueued(name: string): Promise<void> {
    if (this.closed) return;
    const member = this.findMember(name);
    const runtime = this.runtimes.get(name);
    if (!member || !runtime || member.status !== "idle") return;
    const queued = runtime.queued.splice(0);
    if (queued.length === 0) return;
    if (runtime.autoTurns >= (this.state?.settings.maxAutoTurns ?? 8)) {
      this.options.onEvent({
        type: "notice",
        text: `[team] ${name} reached the auto-message limit; messages stay unread.`,
      });
      runtime.queued.push(...queued);
      return;
    }
    runtime.autoTurns += 1;
    const state = this.state as TeamState;
    const messages = state.messages.filter((message) => queued.includes(message.id));
    for (const message of messages) message.read = true;
    await this.save();
    this.emitState();
    const text = messages
      .map((message) => `Message from ${message.from}:\n${message.text}`)
      .join("\n\n");
    try {
      await this.startRun(member, text);
    } catch (error) {
      this.options.onEvent({
        type: "notice",
        text: `[team] could not deliver messages to ${name}: ${error instanceof Error ? error.message : error}`,
      });
    }
  }

  async spawn(
    caller: string,
    input: {
      name: string;
      role: string;
      prompt?: string;
      model?: string;
      wait?: boolean;
      isolation?: "worktree" | "none";
    },
  ): Promise<string> {
    if (caller !== "lead") throw new Error("Only the lead can spawn teammates.");
    const state = await this.ensureState();
    const name = sanitizeName(input.name);
    if (!name) throw new Error("A teammate name is required.");
    if (this.findMember(name)) throw new Error(`Teammate "${name}" already exists.`);
    if (state.members.length >= state.settings.maxMembers) {
      throw new Error(`Member limit reached (${state.settings.maxMembers}).`);
    }

    const definition = this.options.agentDefinitions.get(input.role);
    if (!definition) {
      const available = [...this.options.agentDefinitions.keys()].sort().join(", ");
      throw new Error(`Unknown role "${input.role}". Available: ${available}.`);
    }
    const model =
      input.model?.trim() ||
      (definition.model && definition.model !== "inherit"
        ? definition.model
        : this.options.leadModel);

    const wantedIsolation =
      input.isolation ??
      (definition.isolation === "worktree" ? "worktree" : "none");
    let worktree: WorktreeRecord | undefined;
    if (wantedIsolation === "worktree") {
      const prepared = await createTeamWorktree({
        leadCwd: this.options.cwd,
        teamDir: this.teamDir,
        sessionId: this.options.parentSessionId,
        name,
      });
      if (prepared.record) {
        worktree = prepared.record;
      } else {
        this.options.onEvent({
          type: "notice",
          text: `[team] ${name} is using the shared tree: ${prepared.reason ?? "worktree unavailable"}.`,
        });
      }
    }

    const session = await Session.create({
      cwd: this.options.cwd,
      model,
      id: `${this.options.parentSessionId}-team-${name}-${randomUUID().slice(0, 4)}`,
    });

    const member: TeamMember = {
      name,
      role: definition.name,
      model,
      status: "idle",
      sessionId: session.id,
      createdAt: now(),
      turns: 0,
      isolation: worktree ? "worktree" : "none",
      worktreePath: worktree?.path,
      worktreeCwd: worktree?.cwd,
      repoRoot: worktree?.repoRoot,
      branch: worktree?.branch,
      baseCommit: worktree?.baseCommit,
    };
    state.members.push(member);
    this.runtimes.set(name, { session, queued: [], autoTurns: 0 });
    await this.save();
    this.emitState();

    const where = worktree
      ? `\nWorktree: ${worktree.branch} (${worktree.path})`
      : "";
    if (input.prompt?.trim()) {
      try {
        const runId = await this.startRun(member, input.prompt.trim());
        if (input.wait) {
          await this.awaitMembers([name]);
          return `Spawned ${name} (${definition.name}) and awaited run ${runId}.${where}\n\n${await this.statusText()}`;
        }
        return `Spawned ${name} (${definition.name}) on model ${model}; run ${runId} started in the background. Use TeamAwait to collect it.${where}`;
      } catch (error) {
        state.members = state.members.filter((entry) => entry !== member);
        this.runtimes.delete(name);
        if (worktree) await removeTeamWorktree(worktree);
        await this.save();
        this.emitState();
        throw error;
      }
    }
    return `Spawned ${name} (${definition.name}) on model ${model}; it is idle. Use TeamRun to give it work.${where}`;
  }

  async run(caller: string, name: string, prompt: string, wait = false): Promise<string> {
    if (caller !== "lead" && caller !== name) {
      throw new Error("A teammate can only run itself.");
    }
    await this.ensureState();
    const member = this.findMember(name);
    if (!member) throw new Error(`Unknown teammate "${name}".`);
    if (member.status === "offline") {
      throw new Error(`Teammate "${name}" is offline; spawn a new teammate.`);
    }
    const runId = await this.startRun(member, prompt);
    if (wait) {
      await this.awaitMembers([name]);
      return `Run ${runId} finished.\n\n${await this.statusText()}`;
    }
    return `Started run ${runId} for ${name} in the background. Use TeamAwait to collect it.`;
  }

  async awaitMembers(names?: string[], timeoutMs = 180_000): Promise<string> {
    await this.ensureState();
    const targets =
      names && names.length > 0
        ? names.map((name) => sanitizeName(name))
        : (this.state?.members.map((member) => member.name) ?? []);
    const promises = targets
      .map((name) => this.runtimes.get(name)?.runPromise)
      .filter((promise): promise is Promise<void> => promise !== undefined);

    if (promises.length > 0) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      });
      const result = await Promise.race([Promise.all(promises).then(() => "done" as const), timeout]);
      if (timer) clearTimeout(timer);
      if (result === "timeout") {
        return `Timed out after ${timeoutMs}ms; current state:\n\n${await this.statusText()}`;
      }
    }
    return this.statusText();
  }

  async review(
    caller: string,
    name: string,
    options: { diff?: boolean; maxChars?: number } = {},
  ): Promise<string> {
    await this.ensureState();
    const target = sanitizeName(name);
    if (caller !== "lead" && caller !== target) {
      throw new Error("A teammate can only review its own worktree.");
    }
    const member = this.findMember(target);
    if (!member) throw new Error(`Unknown teammate "${name}".`);
    const worktree = memberWorktree(member);
    if (!worktree) {
      return `${member.name} has no worktree (isolation: none); it worked in the shared tree. Use git status/diff in ${this.options.cwd}.`;
    }
    return reviewTeamWorktree(worktree, options);
  }

  async merge(
    caller: string,
    name: string,
    options: {
      testCommand?: string;
      skipTests?: boolean;
      cleanup?: boolean;
      timeoutMs?: number;
    } = {},
  ): Promise<string> {
    if (caller !== "lead") throw new Error("Only the lead can merge worktrees.");
    const state = await this.ensureState();
    const member = this.findMember(sanitizeName(name));
    if (!member) throw new Error(`Unknown teammate "${name}".`);
    if (member.status === "running") {
      throw new Error(
        `Teammate "${member.name}" is still running. Await or stop it before merging.`,
      );
    }
    const worktree = memberWorktree(member);
    if (!worktree) {
      return `Merge blocked: ${member.name} has no worktree. Its changes (if any) are already in the shared tree.`;
    }

    const result = await this.withLock(() =>
      mergeTeamWorktree({
        record: worktree,
        leadCwd: this.options.cwd,
        teamDir: this.teamDir,
        name: member.name,
        testCommand: options.testCommand ?? state.settings.testCommand,
        testTimeoutMs: options.timeoutMs ?? state.settings.testTimeoutMs,
        skipTests: options.skipTests,
        cleanup: options.cleanup,
      }),
    );

    if (result.status === "merged") {
      member.mergedAt = now();
      member.mergeCommit = result.mergeCommit;
      if (result.cleaned) {
        member.worktreePath = undefined;
        member.worktreeCwd = undefined;
      }
      await this.save();
      this.emitState();
    }
    if (result.status === "merged") return result.message;
    return `Merge blocked (${result.status}):\n\n${result.message}`;
  }

  async sendMessage(from: string, to: string, text: string): Promise<string> {
    const state = await this.ensureState();
    const body = text.trim();
    if (!body) throw new Error("Message text is required.");
    const recipients =
      to === "all"
        ? state.members.filter((member) => member.name !== from && member.status !== "offline")
        : [this.findMember(sanitizeName(to))].filter(
            (member): member is TeamMember => member !== undefined,
          );
    if (recipients.length === 0) throw new Error(`No recipient "${to}".`);

    const created: TeamMessage[] = [];
    for (const recipient of recipients) {
      const message: TeamMessage = {
        id: `msg-${randomUUID().slice(0, 8)}`,
        from,
        to: recipient.name,
        text: body,
        at: now(),
        read: false,
      };
      state.messages.push(message);
      created.push(message);
    }
    await this.save();
    this.emitState();

    let delivered = 0;
    for (const message of created) {
      const member = this.findMember(message.to);
      const runtime = this.runtimes.get(message.to);
      if (!member || !runtime || member.status === "offline") continue;
      if (member.status === "running") {
        runtime.queued.push(message.id);
        continue;
      }
      if (runtime.autoTurns >= state.settings.maxAutoTurns) continue;
      runtime.autoTurns += 1;
      message.read = true;
      delivered += 1;
      try {
        await this.startRun(member, `Message from ${message.from}:\n${message.text}`);
      } catch {
        message.read = false;
      }
    }
    await this.save();
    this.emitState();
    return `Sent ${created.length} message(s)${delivered > 0 ? `, ${delivered} started a turn` : ""}.`;
  }

  private taskById(id: string): TeamTask {
    const task = this.state?.tasks.find((entry) => entry.id === id);
    if (!task) throw new Error(`Unknown task "${id}".`);
    return task;
  }

  async taskAction(
    caller: string,
    action: "create" | "list" | "claim" | "complete" | "block",
    input: Record<string, unknown>,
  ): Promise<string> {
    const state = await this.ensureState();
    if (action === "list") return this.formatTasks();

    if (action === "create") {
      if (caller !== "lead" && state.members.every((member) => member.name !== caller)) {
        throw new Error("Unknown caller.");
      }
      const title = typeof input.title === "string" ? input.title.trim() : "";
      if (!title) throw new Error("Task title is required.");
      const description =
        typeof input.description === "string" && input.description.trim()
          ? input.description.trim()
          : title;
      const dependsOn = Array.isArray(input.dependsOn)
        ? input.dependsOn.filter((entry): entry is string => typeof entry === "string")
        : [];
      for (const dependency of dependsOn) this.taskById(dependency);
      const files = Array.isArray(input.files)
        ? input.files.filter((entry): entry is string => typeof entry === "string")
        : [];
      const assignee =
        typeof input.assignee === "string" ? sanitizeName(input.assignee) : undefined;
      if (assignee && !this.findMember(assignee)) {
        throw new Error(`Unknown assignee "${assignee}".`);
      }
      const task: TeamTask = {
        id: `task-${randomUUID().slice(0, 6)}`,
        title,
        description,
        status: "pending",
        assignee,
        dependsOn,
        files,
        createdBy: caller,
        createdAt: now(),
        updatedAt: now(),
      };
      state.tasks.push(task);
      await this.save();
      this.emitState();
      return `Created ${task.id}: ${task.title}${assignee ? ` (assigned to ${assignee})` : ""}.`;
    }

    const id = typeof input.taskId === "string" ? input.taskId : "";
    const task = this.taskById(id);

    if (action === "claim") {
      if (task.status !== "pending") throw new Error(`Task ${id} is ${task.status}.`);
      if (task.assignee && task.assignee !== caller) {
        throw new Error(`Task ${id} is assigned to ${task.assignee}.`);
      }
      const incomplete = task.dependsOn.filter(
        (dependency) => this.taskById(dependency).status !== "completed",
      );
      if (incomplete.length > 0) {
        throw new Error(`Task ${id} is blocked by ${incomplete.join(", ")}.`);
      }
      const conflict = state.tasks.find(
        (other) =>
          other.id !== id &&
          other.status === "in_progress" &&
          other.files.some((file) => task.files.includes(file)),
      );
      if (conflict) {
        throw new Error(
          `Task ${id} shares files with in-progress task ${conflict.id}; serialize them.`,
        );
      }
      task.status = "in_progress";
      task.assignee = caller;
      task.updatedAt = now();
      const member = this.findMember(caller);
      if (member) member.currentTaskId = task.id;
      await this.save();
      this.emitState();
      return `Claimed ${id} for ${caller}.`;
    }

    if (action === "complete") {
      if (caller !== "lead" && task.assignee !== caller) {
        throw new Error(`Only ${task.assignee ?? "the lead"} can complete ${id}.`);
      }
      task.status = "completed";
      task.result =
        typeof input.result === "string" ? input.result.slice(0, 4000) : task.result;
      task.updatedAt = now();
      const member = task.assignee ? this.findMember(task.assignee) : undefined;
      if (member && member.currentTaskId === task.id) member.currentTaskId = undefined;
      await this.save();
      this.emitState();
      return `Completed ${id}.`;
    }

    if (action === "block") {
      task.status = "blocked";
      task.blockedReason =
        typeof input.reason === "string" ? input.reason.slice(0, 500) : "blocked";
      task.updatedAt = now();
      const member = task.assignee ? this.findMember(task.assignee) : undefined;
      if (member && member.currentTaskId === task.id) member.currentTaskId = undefined;
      await this.save();
      this.emitState();
      return `Blocked ${id}: ${task.blockedReason}`;
    }

    throw new Error(`Unknown task action "${action}".`);
  }

  private formatTasks(): string {
    const tasks = this.state?.tasks ?? [];
    if (tasks.length === 0) return "No tasks.";
    return tasks
      .map((task) => {
        const suffix = task.assignee ? ` @${task.assignee}` : "";
        const deps =
          task.dependsOn.length > 0 ? ` deps: ${task.dependsOn.join(",")}` : "";
        return `[${task.status}] ${task.id} ${task.title}${suffix}${deps}`;
      })
      .join("\n");
  }

  async shutdown(
    caller: string,
    name: string,
    options: { removeWorktree?: boolean } = {},
  ): Promise<string> {
    if (caller !== "lead") throw new Error("Only the lead can shut down teammates.");
    await this.ensureState();
    const member = this.findMember(sanitizeName(name));
    if (!member) throw new Error(`Unknown teammate "${name}".`);
    const runtime = this.runtimes.get(member.name);
    const worktree = memberWorktree(member);
    if (runtime?.controller) runtime.controller.abort();
    if (runtime?.runPromise) {
      await Promise.race([
        runtime.runPromise.catch(() => {}),
        new Promise<void>((resolve) => setTimeout(resolve, 5000)),
      ]);
    }
    if (runtime) {
      runtime.queued = [];
      runtime.agent = undefined;
      runtime.runPromise = undefined;
    }
    member.status = "offline";
    member.currentRunId = undefined;
    member.currentTaskId = undefined;
    this.runtimes.delete(member.name);

    let cleanup = "";
    if (options.removeWorktree) {
      if (!worktree) {
        cleanup = " It had no worktree to remove.";
      } else {
        const problem = await removeTeamWorktree(worktree);
        if (problem) {
          cleanup = ` Worktree cleanup failed: ${problem}`;
        } else {
          member.worktreePath = undefined;
          member.worktreeCwd = undefined;
          cleanup = ` Removed worktree ${worktree.path} and branch ${worktree.branch}.`;
        }
      }
    }
    await this.save();
    this.emitState();
    return `Shut down ${member.name}.${cleanup}`;
  }

  async transcript(name: string): Promise<Message[]> {
    await this.ensureState();
    const member = this.findMember(sanitizeName(name));
    if (!member) return [];
    const runtime = this.runtimes.get(member.name);
    if (runtime?.agent) return [...runtime.agent.messages];
    try {
      const session = await Session.open(member.sessionId);
      return await session.loadMessages();
    } catch {
      return [];
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const runtime of this.runtimes.values()) {
      runtime.controller?.abort();
    }
    await this.save();
  }
}

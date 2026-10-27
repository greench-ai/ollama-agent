import type {
  ContentBlock,
  FileAttachment,
  ImageAttachment,
  Message,
  Provider,
  SubagentRequest,
  SubagentResult,
  SubagentType,
  Tool,
  ToolCall,
  ToolContext,
  ToolResultBlock,
  TodoItem,
  Usage,
} from "./types.ts";
import {
  PermissionEngine,
  summarizeToolInput,
  toolsForMode,
  type PermissionMode,
} from "./permissions.ts";
import {
  builtinAgentDefinitions,
  type AgentDefinition,
} from "./agent-definitions.ts";
import { compactMessages, estimateMessages } from "./tokens.ts";
import { Session } from "./session.ts";
import { TeamManager, type TeamAgentEvent, type TeamEvent } from "./team.ts";
import { memberTeamTools, TEAM_TOOL_NAMES } from "../tools/team.ts";
import { withSkillCatalog, type SkillDefinition } from "./skills.ts";
import { CheckpointStore } from "./checkpoints.ts";
import { HooksEngine } from "./hooks.ts";
import { TelemetryStore, newTelemetryRun } from "./telemetry.ts";

interface RunMetrics {
  startedAt: number;
  turns: number;
  tools: Record<string, number>;
  inputTokens: number;
  outputTokens: number;
  compactions: number;
  toolErrors: number;
}
export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_start"; name: string; input: Record<string, unknown>; summary: string; id?: string }
  | { type: "tool_end"; name: string; content: string; isError: boolean; id?: string }
  | { type: "notice"; text: string }
  | { type: "usage"; usage: Usage }
  | { type: "turn_end" }
  | { type: "error"; message: string }
  | { type: "session_title"; title: string }
  | { type: "team_event"; event: TeamEvent }
  | {
      type: "subagent_start";
      name: string;
      description: string;
      subagentType: string;
      model: string;
    }
  | {
      type: "subagent_end";
      name: string;
      description: string;
      subagentType: string;
      ok: boolean;
      messages: number;
    };

export interface AgentOptions {
  provider: Provider;
  model: string;
  tools: Tool[];
  permissions: PermissionEngine;
  session: Session;
  cwd: string;
  system: string;
  think?: boolean;
  numCtx?: number;
  temperature?: number;
  maxTurns?: number;
  maxToolResultChars?: number;
  messages?: Message[];
  signal?: AbortSignal;
  /** Nesting depth; subagents start at 1. */
  depth?: number;
  maxDepth?: number;
  /** Called by ExitPlanMode; the host shows the plan and returns a decision. */
  planApprover?: (plan: string) => Promise<{ approved: boolean; feedback?: string }>;
  /** Mode applied when a plan is approved. Defaults to acceptEdits. */
  planApplyMode?: PermissionMode;
  /** Agent definitions available to the Task tool. */
  agentDefinitions?: Map<string, AgentDefinition>;
  /** Existing team manager for teammate agents. */
  team?: TeamManager;
  teamRole?: "lead" | "member";
  agentName?: string;
  /** Confine file tools to this root (worktree teammates). */
  workspaceRoot?: string;
  /** Skills available to the Skill tool and advertised in the system prompt. */
  skills?: Map<string, SkillDefinition>;
  /** Checkpoint store; true by default, false disables file snapshots. */
  checkpoints?: CheckpointStore | false;
  /** Lifecycle hooks loaded from user/project config. */
  hooks?: HooksEngine;
  /** Set false to send every tool schema (default: defer MCP tools when many). */
  toolSearch?: boolean;
  /** Tool-count threshold before MCP tools are deferred (default 20). */
  toolSearchThreshold?: number;
  /** Override detected model context length. */
  contextWindow?: number;
  /** Per-run telemetry store; create one by default, false disables it. */
  telemetry?: TelemetryStore | false;
  /** Lead agents create a team manager unless disabled. */
  teamsEnabled?: boolean;
  onEvent?: (event: AgentEvent) => void;
}

const DEFAULT_MAX_TOKENS = 24_000;

/**
 * Tools that only read state and can safely run concurrently. This is an
 * explicit allowlist rather than `mutating: false`, because several
 * non-mutating tools still have ordering requirements: ToolSearch swaps the
 * tool registry, TodoWrite rewrites the session todo list, ExitPlanMode
 * changes the permission mode, and spawning a Task or teammate starts a run.
 */
const PARALLEL_SAFE_TOOLS = new Set(["Read", "Glob", "Grep", "Skill"]);

/**
 * Tools whose repeated identical calls are meaningful progress rather than a
 * stalled loop: a team board changes between polls, and TodoWrite legitimately
 * re-sends the whole list.
 */
const REPETITION_EXEMPT_TOOLS = new Set([
  "TodoWrite",
  "TeamStatus",
  "TeamAwait",
  "TeamReview",
  "TeamTask",
]);

/** Identical calls allowed before the harness intervenes on the next repeat. */
const MAX_IDENTICAL_CALLS = 2;

/** Key-order-independent JSON, so equal inputs always hash alike. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(",")}}`;
}

export class Agent {
  provider: Provider;
  model: string;
  tools: Tool[];
  permissions: PermissionEngine;
  session: Session;
  cwd: string;
  system: string;
  think: boolean;
  numCtx?: number;
  contextWindow?: number;
  private contextModel?: string;
  private contextOverride?: number;
  temperature?: number;
  maxTurns: number;
  maxToolResultChars: number;
  messages: Message[];
  todos: TodoItem[] = [];
  signal?: AbortSignal;
  depth: number;
  maxDepth: number;
  planApprover?: (plan: string) => Promise<{ approved: boolean; feedback?: string }>;
  planApplyMode: PermissionMode;
  agentDefinitions: Map<string, AgentDefinition>;
  team?: TeamManager;
  teamRole: "lead" | "member";
  agentName: string;
  workspaceRoot?: string;
  skills: Map<string, SkillDefinition>;
  checkpoints?: CheckpointStore;
  hooks?: HooksEngine;
  telemetry?: TelemetryStore;
  private telemetryDisabled: boolean;
  private activeMetrics?: RunMetrics;
  private checkpointsDisabled: boolean;
  private allToolDefs: Tool[] = [];
  private deferredTools = new Map<string, Tool>();
  private toolSearchEnabled = false;
  private toolSearchAllowed: boolean;
  private toolSearchThreshold: number;
  private baseSystem: string;
  private teamsEnabled: boolean;
  private subagentCounter = 0;
  /** `tool:stable-input` → how many times the model has issued that exact call. */
  private callCounts = new Map<string, number>();
  private onEvent: (event: AgentEvent) => void;

  constructor(options: AgentOptions) {
    this.provider = options.provider;
    this.model = options.model;
    this.tools = options.tools;
    this.permissions = options.permissions;
    this.session = options.session;
    this.cwd = options.cwd;
    this.system = options.system;
    this.skills = options.skills ?? new Map();
    this.baseSystem = withSkillCatalog(this.system, this.skills);
    this.system = this.baseSystem;
    this.toolSearchAllowed = options.toolSearch !== false;
    this.toolSearchThreshold = Math.max(1, options.toolSearchThreshold ?? 20);
    this.checkpointsDisabled = options.checkpoints === false;
    this.checkpoints = this.checkpointsDisabled
      ? undefined
      : options.checkpoints instanceof CheckpointStore
        ? options.checkpoints
        : new CheckpointStore(this.session.id);
    this.telemetryDisabled = options.telemetry === false;
    this.telemetry = this.telemetryDisabled
      ? undefined
      : options.telemetry instanceof TelemetryStore
        ? options.telemetry
        : new TelemetryStore(this.session.id);
    this.hooks = options.hooks;    this.think = options.think ?? false;
    this.numCtx = options.numCtx;
    this.contextOverride = options.contextWindow;
    this.temperature = options.temperature;
    this.maxTurns = options.maxTurns ?? 40;
    this.maxToolResultChars = options.maxToolResultChars ?? 30_000;
    this.messages = options.messages ? [...options.messages] : [];
    this.signal = options.signal;
    this.depth = options.depth ?? 0;
    this.maxDepth = options.maxDepth ?? 1;
    this.planApprover = options.planApprover;
    this.planApplyMode = options.planApplyMode ?? "acceptEdits";
    this.agentDefinitions = options.agentDefinitions ?? builtinAgentDefinitions();
    this.onEvent = options.onEvent ?? (() => {});
    this.agentName = options.agentName ?? (this.depth === 0 ? "lead" : "agent");
    this.workspaceRoot = options.workspaceRoot;
    this.teamRole = options.teamRole ?? "lead";
    this.team = options.team;
    this.teamsEnabled =
      this.depth === 0 && this.teamRole === "lead" && options.teamsEnabled !== false;
    if (!this.team && this.teamsEnabled) {
      this.team = this.createTeamManager(this.session.id);
    }

    this.allToolDefs = this.team
      ? [...options.tools]
      : options.tools.filter((tool) => !TEAM_TOOL_NAMES.has(tool.name));
    this.tools = [...this.allToolDefs];
    this.configureDeferredTools();
  }

  private effectiveNumCtx(): number | undefined {
    return this.numCtx ?? this.contextOverride ?? this.contextWindow;
  }

  private contextBudget(): number {
    const window = this.effectiveNumCtx() ?? 32_768;
    return Math.max(4_000, Math.floor(window * 0.75));
  }

  /**
   * Ask the provider for the selected model's maximum context length. Called
   * before a turn so cloud models such as deepseek-v4.1-flash use their full
   * 1M window, and before compaction decides its budget.
   */
  async refreshContextWindow(): Promise<number | undefined> {
    if (!this.provider.contextWindow) return this.contextWindow;
    if (this.contextModel === this.model) return this.contextWindow;
    try {
      const window = await this.provider.contextWindow(this.model);
      this.contextWindow =
        window && Number.isFinite(window) && window > 0
          ? Math.floor(window)
          : undefined;
      this.contextModel = this.model;
    } catch {
      // Keep the previous value; the provider may be temporarily unavailable.
    }
    return this.contextWindow;
  }

  /** Replace the tool set (for example after MCP reload) and re-apply deferral. */
  setTools(tools: Tool[]): void {
    this.allToolDefs = this.team
      ? [...tools]
      : tools.filter((tool) => !TEAM_TOOL_NAMES.has(tool.name));
    this.configureDeferredTools();
  }

  /** Replace the base system prompt and re-apply catalogs after a project change. */
  setSystem(system: string, skills?: Map<string, SkillDefinition>): void {
    if (skills) this.skills = skills;
    this.baseSystem = withSkillCatalog(system, this.skills);
    this.system = this.baseSystem;
    if (this.deferredTools.size > 0) {
      this.system = `${this.baseSystem}\n\n${this.deferredCatalogText()}`;
    }
  }

  private deferredCatalogText(): string {
    const catalog = [...this.deferredTools.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((tool) => {
        const description =
          tool.description.length > 120
            ? `${tool.description.slice(0, 117)}…`
            : tool.description;
        return `- ${tool.name}: ${description}`;
      });
    return `Deferred tools (schemas not loaded). Use ToolSearch with a keyword, then call the tool on the next turn:\n${catalog.join("\n")}`;
  }

  private configureDeferredTools(): void {
    this.tools = [...this.allToolDefs];
    this.system = this.baseSystem;
    this.deferredTools.clear();
    this.toolSearchEnabled = false;
    const search = this.tools.find((tool) => tool.name === "ToolSearch");
    if (
      !this.toolSearchAllowed ||
      !search ||
      this.tools.length <= this.toolSearchThreshold
    ) {
      this.tools = this.tools.filter((tool) => tool.name !== "ToolSearch");
      return;
    }
    const candidates = this.tools.filter((tool) => tool.name.includes("__"));
    if (candidates.length < 3) {
      this.tools = this.tools.filter((tool) => tool.name !== "ToolSearch");
      return;
    }
    this.deferredTools = new Map(candidates.map((tool) => [tool.name, tool]));
    this.tools = this.tools.filter((tool) => !this.deferredTools.has(tool.name));
    this.toolSearchEnabled = true;
    this.system = `${this.baseSystem}\n\n${this.deferredCatalogText()}`;
  }

  private async searchDeferredTools(
    query: string,
    limit = 5,
  ): Promise<{ content: string; loaded: string[] }> {
    const deferred = [...this.deferredTools.values()];
    if (deferred.length === 0) {
      return {
        content: "No deferred tools remain; all available tools are loaded.",
        loaded: [],
      };
    }
    const terms = query
      .toLowerCase()
      .split(/[^a-z0-9_.-]+/)
      .filter((term) => term.length > 1);
    const scored = deferred
      .map((tool) => {
        const name = tool.name.toLowerCase();
        const description = tool.description.toLowerCase();
        let score = query.trim() === "*" ? 1 : 0;
        for (const term of terms) {
          if (name === term) score += 20;
          else if (name.includes(term)) score += 8;
          else if (description.includes(term)) score += 2;
        }
        return { tool, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
    const selected = scored
      .slice(0, Math.max(1, Math.min(10, Math.floor(limit) || 5)))
      .map((entry) => entry.tool);
    if (selected.length === 0) {
      const names = deferred.map((tool) => tool.name).sort().join(", ");
      return {
        content: `No deferred tool matched "${query}". Available: ${names}.`,
        loaded: [],
      };
    }
    for (const tool of selected) {
      if (!this.tools.some((entry) => entry.name === tool.name)) {
        this.tools.push(tool);
      }
      this.deferredTools.delete(tool.name);
    }
    const schemas = selected.map((tool) =>
      JSON.stringify(
        {
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        },
        null,
        2,
      ),
    );
    return {
      content: `Loaded ${selected.length} tool(s): ${selected
        .map((tool) => tool.name)
        .join(", ")}.\nCall one of them on the next turn.\n\n${schemas.join("\n\n")}`,
      loaded: selected.map((tool) => tool.name),
    };
  }

  private createTeamManager(parentSessionId: string): TeamManager {
    const baseTools = this.tools.filter(
      (tool) => !TEAM_TOOL_NAMES.has(tool.name) && tool.name !== "ToolSearch",
    );
    let manager: TeamManager | undefined;
    manager = new TeamManager({
      leadModel: this.model,
      baseTools,
      memberTools: memberTeamTools,
      permissions: this.permissions,
      cwd: this.cwd,
      parentSessionId,
      agentDefinitions: this.agentDefinitions,
      skills: this.skills,
      hooks: this.hooks,
      onEvent: (event) => this.onEvent({ type: "team_event", event }),
      createAgent: (config) =>
        new Agent({
          provider: this.provider,
          model: config.model,
          tools: config.tools,
          permissions: config.permissions,
          session: config.session,
          cwd: config.cwd ?? this.cwd,
          workspaceRoot: config.workspaceRoot,
          system: config.system,
          think: false,
          numCtx: this.numCtx,
          temperature: this.temperature,
          maxTurns: config.maxTurns,
          maxToolResultChars: this.maxToolResultChars,
          messages: config.messages,
          depth: this.depth + 1,
          maxDepth: this.maxDepth,
          agentDefinitions: this.agentDefinitions,
          skills: config.skills,
          hooks: config.hooks,
          team: manager,
          teamRole: "member",
          agentName: config.name,
          onEvent: (event) => {
            switch (event.type) {
              case "text":
                config.onEvent({ type: "text", text: event.text });
                break;
              case "thinking":
                config.onEvent({ type: "thinking", text: event.text });
                break;
              case "tool_start":
                config.onEvent({
                  type: "tool_start",
                  name: event.name,
                  summary: event.summary,
                });
                break;
              case "tool_end":
                config.onEvent({
                  type: "tool_end",
                  name: event.name,
                  content: event.content,
                  isError: event.isError,
                });
                break;
              case "error":
                config.onEvent({ type: "error", message: event.message });
                break;
              case "turn_end":
                config.onEvent({ type: "done" });
                break;
              default:
                break;
            }
          },
        }),
    });
    return manager;
  }

  async run(
    userText: string,
    images?: ImageAttachment[],
    files?: FileAttachment[],
  ): Promise<void> {
    await this.refreshContextWindow();
    const metrics: RunMetrics = {
      startedAt: Date.now(),
      turns: 0,
      tools: {},
      inputTokens: 0,
      outputTokens: 0,
      compactions: 0,
      toolErrors: 0,
    };
    this.activeMetrics = metrics;
    let recorded = false;
    const finishTelemetry = async (stopReason: string, error?: string) => {
      if (recorded) return;
      recorded = true;
      this.activeMetrics = undefined;
      if (!this.telemetry) return;
      try {
        await this.telemetry.record(
          newTelemetryRun({
            sessionId: this.session.id,
            agentName: this.agentName,
            model: this.model,
            cwd: this.cwd,
            startedAt: metrics.startedAt,
            endedAt: Date.now(),
            turns: metrics.turns,
            tools: metrics.tools,
            inputTokens: metrics.inputTokens,
            outputTokens: metrics.outputTokens,
            compactions: metrics.compactions,
            toolErrors: metrics.toolErrors,
            stopReason,
            error,
          }),
        );
      } catch {
        // Telemetry must never break a turn.
      }
    };
    if (this.hooks?.has("SessionStart") && this.messages.length === 0) {
      const started = await this.hooks.run("SessionStart", {
        cwd: this.cwd,
        sessionId: this.session.id,
        agentName: this.agentName,
      });
      if (started.output) {
        this.onEvent({ type: "notice", text: started.output });
      }
    }
    if (this.hooks?.has("UserPromptSubmit")) {
      const submitted = await this.hooks.run("UserPromptSubmit", {
        cwd: this.cwd,
        sessionId: this.session.id,
        agentName: this.agentName,
        prompt: userText,
      });
      if (submitted.blocked) {
        this.onEvent({
          type: "notice",
          text: `Prompt blocked by hook: ${submitted.reason ?? "exit 2"}`,
        });
        await finishTelemetry("prompt_blocked");
        return;
      }
      if (submitted.output) {
        this.onEvent({ type: "notice", text: submitted.output });
      }
    }

    const content: ContentBlock[] = [{ type: "text", text: userText }];
    for (const image of images ?? []) {
      content.push({ type: "image", ...image });
    }
    for (const file of files ?? []) {
      content.push({ type: "file", ...file });
    }
    const userMessage: Message = { role: "user", content };
    this.messages.push(userMessage);
    await this.session.appendMessage(userMessage);

    if (this.messages.length === 1) {
      const title = userText.replace(/\s+/g, " ").trim().slice(0, 80) || "New chat";
      await this.session.setTitle(title).catch(() => {});
      this.onEvent({ type: "session_title", title });
    }

    for (let turn = 0; turn < this.maxTurns; turn += 1) {
      metrics.turns += 1;
      const compacted = compactMessages(this.messages, this.contextBudget());
      if (compacted.dropped > 0 || compacted.truncated > 0) {
        metrics.compactions += 1;
        this.messages = compacted.messages;
        const parts: string[] = [];
        if (compacted.dropped) parts.push(`dropped ${compacted.dropped} old message(s)`);
        if (compacted.truncated) parts.push(`truncated ${compacted.truncated} tool result(s)`);
        this.onEvent({
          type: "notice",
          text: `Context budget reached: ${parts.join(", ")}.`,
        });
      }

      const tools = toolsForMode(this.tools, this.permissions.mode);
      const assistantBlocks: ContentBlock[] = [];
      const toolCalls: ToolCall[] = [];
      let text = "";
      let thinking = "";
      let stopReason = "end_turn";
      let usage: Usage | undefined;

      try {
        for await (const event of this.provider.chat({
          model: this.model,
          messages: this.messages,
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
          system: this.system,
          temperature: this.temperature,
          numCtx: this.effectiveNumCtx(),
          think: this.think,
          signal: this.signal,
        })) {
          switch (event.type) {
            case "text":
              text += event.text;
              this.onEvent({ type: "text", text: event.text });
              break;
            case "thinking":
              thinking += event.text;
              this.onEvent({ type: "thinking", text: event.text });
              break;
            case "tool_call":
              toolCalls.push(event.call);
              break;
            case "done":
              stopReason = event.stopReason;
              usage = event.usage;
              break;
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.onEvent({ type: "error", message });
        await finishTelemetry("error", message);
        throw error;
      }

      if (usage) {
        metrics.inputTokens += usage.inputTokens ?? 0;
        metrics.outputTokens += usage.outputTokens ?? 0;
        this.onEvent({ type: "usage", usage });
      }
      if (thinking.trim()) assistantBlocks.push({ type: "thinking", thinking });
      if (text) assistantBlocks.push({ type: "text", text });
      for (const call of toolCalls) {
        assistantBlocks.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: call.input,
        });
      }

      if (assistantBlocks.length > 0) {
        const assistantMessage: Message = {
          role: "assistant",
          content: assistantBlocks,
        };
        this.messages.push(assistantMessage);
        await this.session.appendMessage(assistantMessage);
      }

      if (toolCalls.length === 0) {
        if (this.hooks?.has("Stop")) {
          const stopped = await this.hooks.run("Stop", {
            cwd: this.cwd,
            sessionId: this.session.id,
            agentName: this.agentName,
            text,
          });
          if (stopped.output || stopped.reason) {
            this.onEvent({
              type: "notice",
              text: stopped.reason ?? stopped.output ?? "",
            });
          }
        }
        await finishTelemetry(stopReason);
        this.onEvent({ type: "turn_end" });
        return;
      }

      const results = await this.runToolCalls(toolCalls);
      const resultMessage: Message = { role: "user", content: results };
      this.messages.push(resultMessage);
      await this.session.appendMessage(resultMessage);
      this.onEvent({ type: "turn_end" });
      void stopReason;
    }

    await finishTelemetry("max_turns");
    this.onEvent({
      type: "notice",
      text: `Stopped after ${this.maxTurns} turns without a final answer.`,
    });
  }

  /**
   * Run one turn's tool calls, returning results in the same order the model
   * requested them (the provider pairs results to calls positionally).
   *
   * Consecutive read-only calls run concurrently; anything else is a barrier
   * that preserves ordering, so a Write still completes before the Read that
   * follows it. Tool events gain an `id` so hosts can pair start/end across
   * interleaved runs instead of relying on adjacency.
   */
  private async runToolCalls(calls: ToolCall[]): Promise<ToolResultBlock[]> {
    const results: (ToolResultBlock | undefined)[] = new Array(calls.length);
    let index = 0;
    while (index < calls.length) {
      if (this.canRunConcurrently(calls[index])) {
        const batch: number[] = [];
        while (index < calls.length && this.canRunConcurrently(calls[index])) {
          batch.push(index);
          index += 1;
        }
        const settled = await Promise.all(
          batch.map((position) => this.executeTool(calls[position])),
        );
        batch.forEach((position, offset) => {
          results[position] = settled[offset];
        });
        continue;
      }
      results[index] = await this.executeTool(calls[index]);
      index += 1;
    }
    return results as ToolResultBlock[];
  }

  private canRunConcurrently(call: ToolCall): boolean {
    if (call.inputError) return false;
    if (!PARALLEL_SAFE_TOOLS.has(call.name)) return false;
    // Unknown tool names never reach here, but bail out defensively so a typo
    // in the allowlist cannot smuggle in a stateful tool.
    return this.tools.some((tool) => tool.name === call.name);
  }

  /**
   * Count an identical (tool, input) pair and decide whether to short-circuit
   * it. Weak local models often re-issue a call verbatim after a confusing
   * result; without this they burn the whole turn budget and report nothing.
   */
  private noteCall(
    name: string,
    input: Record<string, unknown>,
  ): { blocked: boolean; attempt: number; summary: string } {
    const summary = summarizeToolInput(name, input);
    if (REPETITION_EXEMPT_TOOLS.has(name)) {
      return { blocked: false, attempt: 0, summary };
    }
    const key = `${name}:${stableStringify(input)}`;
    const attempt = (this.callCounts.get(key) ?? 0) + 1;
    this.callCounts.set(key, attempt);
    return { blocked: attempt > MAX_IDENTICAL_CALLS, attempt, summary };
  }

  private repeatGuidance(name: string, attempt: number): string {
    const base =
      `Blocked by the harness: you have already called ${name} with these ` +
      `exact arguments ${attempt - 1} time(s), and the result is unchanged. ` +
      `Repeating it will not produce a different answer.\n\n`;
    if (name === "TeamStatus") {
      return base; // unreachable while exempt, kept for clarity
    }
    return (
      base +
      `What to do next: either act on the tool output already in this ` +
      `conversation, try a genuinely different approach (different arguments, ` +
      `a different tool, or read a different part of the file), or stop and ` +
      `tell the user what is blocking you.`
    );
  }

  private async executeTool(call: ToolCall): Promise<ToolResultBlock> {
    const tool = this.tools.find((candidate) => candidate.name === call.name);
    if (!tool) {
      const content = `Unknown tool "${call.name}".`;
      this.onEvent({ type: "tool_end", name: call.name, content, isError: true, id: call.id });
      return {
        type: "tool_result",
        tool_use_id: call.id,
        name: call.name,
        content,
        is_error: true,
      };
    }

    // A call whose arguments could not be parsed must not run: it would fail
    // deep inside the tool as a missing-parameter error the model cannot
    // connect back to its own malformed JSON.
    if (call.inputError) {
      if (this.activeMetrics) this.activeMetrics.toolErrors += 1;
      const content =
        `Your call to ${call.name} could not be run. ${call.inputError}\n\n` +
        `Re-issue the call with a single valid JSON object as its arguments, ` +
        `using the parameter names from the tool's schema.`;
      this.onEvent({ type: "tool_start", name: call.name, input: call.input, summary: "", id: call.id });
      this.onEvent({ type: "tool_end", name: call.name, content, isError: true, id: call.id });
      return {
        type: "tool_result",
        tool_use_id: call.id,
        name: call.name,
        content,
        is_error: true,
      };
    }

    const repeat = this.noteCall(tool.name, call.input);
    if (repeat.blocked) {
      if (this.activeMetrics) this.activeMetrics.toolErrors += 1;
      const content = this.repeatGuidance(tool.name, repeat.attempt);
      this.onEvent({ type: "tool_start", name: tool.name, input: call.input, summary: repeat.summary, id: call.id });
      this.onEvent({ type: "tool_end", name: tool.name, content, isError: true, id: call.id });
      return {
        type: "tool_result",
        tool_use_id: call.id,
        name: tool.name,
        content,
        is_error: true,
      };
    }

    if (this.hooks?.has("PreToolUse")) {
      const hooked = await this.hooks.run("PreToolUse", {
        tool: tool.name,
        input: call.input,
        cwd: this.cwd,
        sessionId: this.session.id,
        agentName: this.agentName,
      });
      if (hooked.output) {
        this.onEvent({ type: "notice", text: hooked.output });
      }
      if (hooked.blocked) {
        if (this.activeMetrics) this.activeMetrics.toolErrors += 1;
        const content = `Blocked by PreToolUse hook: ${hooked.reason ?? "exit 2"}`;
        this.onEvent({ type: "tool_end", name: tool.name, content, isError: true, id: call.id });
        return {
          type: "tool_result",
          tool_use_id: call.id,
          name: tool.name,
          content,
          is_error: true,
        };
      }
    }

    if (this.activeMetrics) {
      this.activeMetrics.tools[tool.name] =
        (this.activeMetrics.tools[tool.name] ?? 0) + 1;
    }
    const permission = await this.permissions.check({
      tool: tool.name,
      input: call.input,
      mutating: tool.mutating,
    });
    if (!permission.allowed) {
      if (this.activeMetrics) this.activeMetrics.toolErrors += 1;
      const content = permission.reason ?? "Denied.";
      this.onEvent({ type: "tool_end", name: tool.name, content, isError: true, id: call.id });
      return {
        type: "tool_result",
        tool_use_id: call.id,
        name: tool.name,
        content,
        is_error: true,
      };
    }

    if (this.checkpoints && tool.mutating) {
      try {
        await this.checkpoints.capture(
          tool.name,
          call.input,
          this.cwd,
          this.messages.length,
          this.workspaceRoot,
        );
      } catch (error) {
        this.onEvent({
          type: "notice",
          text: `checkpoint failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    const summary = summarizeToolInput(tool.name, call.input);
    this.onEvent({ type: "tool_start", name: tool.name, input: call.input, summary, id: call.id });

    const controller = new AbortController();
    const context: ToolContext = {
      cwd: this.cwd,
      sessionId: this.session.id,
      signal: controller.signal,
      todos: this.todos,
      log: (line) => this.onEvent({ type: "notice", text: line }),
      spawnSubagent: (request) => this.spawnSubagent(request),
      requestPlanApproval: (plan) => this.requestPlanApproval(plan),
      team: this.team,
      teamRole: this.teamRole,
      agentName: this.agentName,
      allowedRoot: this.workspaceRoot,
      skills: this.skills,
      toolSearch: this.toolSearchEnabled
        ? {
            search: (query: string, limit?: number) =>
              this.searchDeferredTools(query, limit),
          }
        : undefined,
    };

    let content: string;
    let isError = false;
    let images: ImageAttachment[] | undefined;
    try {
      const result = await tool.run(call.input, context);
      content = result.content;
      isError = result.isError ?? false;
      images = result.images;
    } catch (error) {
      content = error instanceof Error ? error.message : String(error);
      isError = true;
    }

    if (isError && this.activeMetrics) this.activeMetrics.toolErrors += 1;
    const postEvent = isError ? "PostToolUseFailure" : "PostToolUse";
    if (this.hooks?.has(postEvent)) {
      const hooked = await this.hooks.run(postEvent, {
        tool: tool.name,
        input: call.input,
        output: content.slice(0, 20_000),
        isError,
        cwd: this.cwd,
        sessionId: this.session.id,
        agentName: this.agentName,
      });
      if (hooked.output) {
        this.onEvent({ type: "notice", text: hooked.output });
      }
    }

    if (content.length > this.maxToolResultChars) {
      const omitted = content.length - this.maxToolResultChars;
      content = `${content.slice(0, this.maxToolResultChars)}\n\n[truncated ${omitted} chars]`;
    }

    if (tool.name === "TodoWrite") {
      await this.session.appendTodos(this.todos);
    }

    this.onEvent({ type: "tool_end", name: tool.name, content, isError, id: call.id });
    return {
      type: "tool_result",
      tool_use_id: call.id,
      name: tool.name,
      content,
      is_error: isError,
      ...(images && images.length > 0 ? { images } : {}),
    };
  }

  /** Ask the host to approve a plan, then leave plan mode on approval. */
  private async requestPlanApproval(
    plan: string,
  ): Promise<{ approved: boolean; feedback?: string }> {
    if (!this.planApprover) {
      return { approved: false, feedback: "Plan approval is not configured." };
    }
    const result = await this.planApprover(plan);
    if (result.approved) {
      this.permissions.setMode(this.planApplyMode);
      this.onEvent({
        type: "notice",
        text: `plan approved — mode → ${this.permissions.mode}`,
      });
    } else {
      this.onEvent({ type: "notice", text: "plan rejected" });
    }
    return result;
  }

  /**
   * Run a delegated task in a fresh Agent. The child gets its own message
   * history and session file, so intermediate output never enters the parent
   * context; only its final report is returned. `Task` is removed from the
   * child's tool set, which caps nesting at one level.
   */
  private async spawnSubagent(request: SubagentRequest): Promise<SubagentResult> {
    if (this.depth >= this.maxDepth) {
      return {
        content: "Subagents cannot spawn further subagents.",
        isError: true,
      };
    }

    const subagentType = request.subagentType?.trim() || "general-purpose";
    const definition = this.agentDefinitions.get(subagentType);
    if (!definition) {
      const available = [...this.agentDefinitions.keys()].sort().join(", ");
      return {
        content: `Unknown subagent type "${subagentType}". Available: ${available}.`,
        isError: true,
      };
    }

    const rawName = request.name?.trim() || `sub-${this.subagentCounter + 1}`;
    this.subagentCounter += 1;
    const name = rawName.replace(/[^A-Za-z0-9._-]+/g, "-");
    const model =
      request.model?.trim() ||
      (definition.model && definition.model !== "inherit"
        ? definition.model
        : this.model);

    let childTools = this.tools.filter(
      (tool) =>
        !TEAM_TOOL_NAMES.has(tool.name) &&
        tool.name !== "Task" &&
        tool.name !== "ExitPlanMode" &&
        tool.name !== "ToolSearch",
    );
    if (definition.disallowedTools && definition.disallowedTools.length > 0) {
      const denied = new Set(definition.disallowedTools.map(toolBaseName));
      childTools = childTools.filter((tool) => !denied.has(tool.name));
    }
    if (definition.tools && definition.tools.length > 0) {
      const allowed = new Set(definition.tools.map(toolBaseName));
      childTools = childTools.filter((tool) => allowed.has(tool.name));
    }
    const skillDenied = definition.disallowedTools?.some(
      (tool) => toolBaseName(tool) === "Skill",
    );
    if (!skillDenied && !childTools.some((tool) => tool.name === "Skill")) {
      const skill = this.tools.find((tool) => tool.name === "Skill");
      if (skill) childTools.push(skill);
    }

    const childPermissions = this.permissions.fork(
      definition.permissionMode ?? this.permissions.mode,
    );
    const readOnly = definition.permissionMode === "plan";
    const basePrompt =
      definition.systemPrompt.trim() ||
      `You are the ${definition.name} subagent described as: ${definition.description}`;
    const system = `${basePrompt}\n\n${subagentRules(
      this.cwd,
      definition.name,
      request.description,
      readOnly,
    )}`;

    const childSession = await Session.create({
      cwd: this.cwd,
      model,
      id: `${this.session.id}-${name}`,
    });

    this.onEvent({
      type: "subagent_start",
      name,
      description: request.description,
      subagentType: definition.name,
      model,
    });

    const child = new Agent({
      provider: this.provider,
      model,
      tools: childTools,
      permissions: childPermissions,
      session: childSession,
      cwd: this.cwd,
      system,
      think: false,
      numCtx: this.numCtx,
      temperature: this.temperature,
      maxTurns: request.maxTurns ?? definition.maxTurns ?? 25,
      maxToolResultChars: this.maxToolResultChars,
      depth: this.depth + 1,
      maxDepth: this.maxDepth,
      teamsEnabled: false,
      agentName: name,
      agentDefinitions: this.agentDefinitions,
      skills: this.skills,
      hooks: this.hooks,
      onEvent: (event) => {
        if (event.type === "tool_start") {
          this.onEvent({
            type: "notice",
            text: `[${name}] ${event.name}${event.summary ? `: ${event.summary}` : ""}`,
          });
        } else if (event.type === "error") {
          this.onEvent({ type: "notice", text: `[${name}] error: ${event.message}` });
        }
      },
    });

    try {
      await child.run(request.prompt);
      const report = lastAssistantText(child.messages);
      if (this.hooks?.has("SubagentStop")) {
        const stopped = await this.hooks.run("SubagentStop", {
          cwd: this.cwd,
          sessionId: this.session.id,
          agentName: name,
          report,
        });
        if (stopped.output) {
          this.onEvent({ type: "notice", text: stopped.output });
        }
      }
      this.onEvent({
        type: "subagent_end",
        name,
        description: request.description,
        subagentType: definition.name,
        ok: true,
        messages: child.messages.length,
      });
      return { content: report || "Subagent finished without a final report." };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.onEvent({
        type: "subagent_end",
        name,
        description: request.description,
        subagentType: definition.name,
        ok: false,
        messages: child.messages.length,
      });
      return { content: message, isError: true };
    }
  }

  /** Approximate context usage for the status line. */
  contextUsage(): { used: number; budget: number } {
    return {
      used: estimateMessages(this.messages),
      budget: this.effectiveNumCtx() ?? 32_768,
    };
  }

  /** Clear the conversation (used by the CLI's /clear). */
  reset(): void {
    this.messages = [];
    this.todos = [];
  }

  /** Replace the active session and conversation (session switching). */
  restore(session: Session, messages: Message[]): void {
    if (this.teamsEnabled) {
      const previous = this.team;
      this.team = this.createTeamManager(session.id);
      void previous?.close();
    }
    this.session = session;
    this.messages = [...messages];
    this.todos = [];
    if (!this.checkpointsDisabled) {
      this.checkpoints = new CheckpointStore(session.id);
    }
    if (!this.telemetryDisabled) {
      this.telemetry = new TelemetryStore(session.id);
    }
  }

  /** Stop background teammates owned by this lead. */
  async close(): Promise<void> {
    if (this.hooks?.has("SessionEnd")) {
      const ended = await this.hooks.run("SessionEnd", {
        cwd: this.cwd,
        sessionId: this.session.id,
        agentName: this.agentName,
      });
      if (ended.output) this.onEvent({ type: "notice", text: ended.output });
    }
    await this.team?.close();
  }
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

function subagentRules(
  cwd: string,
  type: string,
  description: string,
  readOnly: boolean,
): string {
  return `You are the ${type} subagent, working on one delegated task.

Task: ${description}

Environment
- Working directory: ${cwd}
${readOnly ? "- Read-only: do not modify files or run mutating commands.\n" : ""}
Rules
- Use absolute file paths.
- Work autonomously; do not ask the user questions.
- Stay scoped to the delegated task.
- End with a concise report: findings, file paths, changes made (if any), and anything unresolved.`;
}

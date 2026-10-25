import type {
  ContentBlock,
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
import { compactMessages, estimateMessages } from "./tokens.ts";
import { Session } from "./session.ts";

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_start"; name: string; input: Record<string, unknown>; summary: string }
  | { type: "tool_end"; name: string; content: string; isError: boolean }
  | { type: "notice"; text: string }
  | { type: "usage"; usage: Usage }
  | { type: "turn_end" }
  | { type: "error"; message: string }
  | { type: "session_title"; title: string }
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
  onEvent?: (event: AgentEvent) => void;
}

const DEFAULT_MAX_TOKENS = 24_000;

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
  private subagentCounter = 0;
  private onEvent: (event: AgentEvent) => void;

  constructor(options: AgentOptions) {
    this.provider = options.provider;
    this.model = options.model;
    this.tools = options.tools;
    this.permissions = options.permissions;
    this.session = options.session;
    this.cwd = options.cwd;
    this.system = options.system;
    this.think = options.think ?? false;
    this.numCtx = options.numCtx;
    this.temperature = options.temperature;
    this.maxTurns = options.maxTurns ?? 40;
    this.maxToolResultChars = options.maxToolResultChars ?? 30_000;
    this.messages = options.messages ? [...options.messages] : [];
    this.signal = options.signal;
    this.depth = options.depth ?? 0;
    this.maxDepth = options.maxDepth ?? 1;
    this.planApprover = options.planApprover;
    this.planApplyMode = options.planApplyMode ?? "acceptEdits";
    this.onEvent = options.onEvent ?? (() => {});
  }

  private contextBudget(): number {
    const window = this.numCtx ?? 32_768;
    return Math.max(4_000, Math.floor(window * 0.75));
  }

  async run(userText: string, images?: ImageAttachment[]): Promise<void> {
    const content: ContentBlock[] = [{ type: "text", text: userText }];
    for (const image of images ?? []) {
      content.push({ type: "image", ...image });
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
      const compacted = compactMessages(this.messages, this.contextBudget());
      if (compacted.dropped > 0 || compacted.truncated > 0) {
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
          numCtx: this.numCtx,
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
        throw error;
      }

      if (usage) this.onEvent({ type: "usage", usage });
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
        this.onEvent({ type: "turn_end" });
        return;
      }

      const results: ToolResultBlock[] = [];
      for (const call of toolCalls) {
        const result = await this.executeTool(call);
        results.push(result);
      }
      const resultMessage: Message = { role: "user", content: results };
      this.messages.push(resultMessage);
      await this.session.appendMessage(resultMessage);
      this.onEvent({ type: "turn_end" });
      void stopReason;
    }

    this.onEvent({
      type: "notice",
      text: `Stopped after ${this.maxTurns} turns without a final answer.`,
    });
  }

  private async executeTool(call: ToolCall): Promise<ToolResultBlock> {
    const tool = this.tools.find((candidate) => candidate.name === call.name);
    if (!tool) {
      const content = `Unknown tool "${call.name}".`;
      this.onEvent({ type: "tool_end", name: call.name, content, isError: true });
      return {
        type: "tool_result",
        tool_use_id: call.id,
        name: call.name,
        content,
        is_error: true,
      };
    }

    const permission = await this.permissions.check({
      tool: tool.name,
      input: call.input,
      mutating: tool.mutating,
    });
    if (!permission.allowed) {
      const content = permission.reason ?? "Denied.";
      this.onEvent({ type: "tool_end", name: tool.name, content, isError: true });
      return {
        type: "tool_result",
        tool_use_id: call.id,
        name: tool.name,
        content,
        is_error: true,
      };
    }

    const summary = summarizeToolInput(tool.name, call.input);
    this.onEvent({ type: "tool_start", name: tool.name, input: call.input, summary });

    const controller = new AbortController();
    const context: ToolContext = {
      cwd: this.cwd,
      sessionId: this.session.id,
      signal: controller.signal,
      todos: this.todos,
      log: (line) => this.onEvent({ type: "notice", text: line }),
      spawnSubagent: (request) => this.spawnSubagent(request),
      requestPlanApproval: (plan) => this.requestPlanApproval(plan),
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

    if (content.length > this.maxToolResultChars) {
      const omitted = content.length - this.maxToolResultChars;
      content = `${content.slice(0, this.maxToolResultChars)}\n\n[truncated ${omitted} chars]`;
    }

    if (tool.name === "TodoWrite") {
      await this.session.appendTodos(this.todos);
    }

    this.onEvent({ type: "tool_end", name: tool.name, content, isError });
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

    const subagentType: SubagentType = request.subagentType ?? "general-purpose";
    const readOnly = subagentType === "explore" || subagentType === "plan";
    const rawName = request.name?.trim() || `sub-${this.subagentCounter + 1}`;
    this.subagentCounter += 1;
    const name = rawName.replace(/[^A-Za-z0-9._-]+/g, "-");
    const model = request.model?.trim() || this.model;

    const childTools = this.tools.filter(
      (tool) => tool.name !== "Task" && (!readOnly || !tool.mutating),
    );
    const childSession = await Session.create({
      cwd: this.cwd,
      model,
      id: `${this.session.id}-${name}`,
    });

    this.onEvent({
      type: "subagent_start",
      name,
      description: request.description,
      subagentType,
      model,
    });

    const child = new Agent({
      provider: this.provider,
      model,
      tools: childTools,
      permissions: this.permissions,
      session: childSession,
      cwd: this.cwd,
      system: subagentSystemPrompt(this.cwd, subagentType, request.description),
      think: false,
      numCtx: this.numCtx,
      temperature: this.temperature,
      maxTurns: request.maxTurns ?? 25,
      maxToolResultChars: this.maxToolResultChars,
      depth: this.depth + 1,
      maxDepth: this.maxDepth,
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
      this.onEvent({
        type: "subagent_end",
        name,
        description: request.description,
        subagentType,
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
        subagentType,
        ok: false,
        messages: child.messages.length,
      });
      return { content: message, isError: true };
    }
  }

  /** Approximate context usage for the status line. */
  contextUsage(): { used: number; budget: number } {
    return { used: estimateMessages(this.messages), budget: this.contextBudget() };
  }

  /** Clear the conversation (used by the CLI's /clear). */
  reset(): void {
    this.messages = [];
    this.todos = [];
  }

  /** Replace the active session and conversation (session switching). */
  restore(session: Session, messages: Message[]): void {
    this.session = session;
    this.messages = [...messages];
    this.todos = [];
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

function subagentSystemPrompt(
  cwd: string,
  type: SubagentType,
  description: string,
): string {
  const readOnly = type === "explore" || type === "plan";
  return `You are a ${type} subagent launched by a coding agent, working on one delegated task.

Task: ${description}

Environment
- Working directory: ${cwd}
${readOnly ? "- Read-only: you may not modify files or run mutating commands.\n" : ""}
Rules
- Use absolute file paths.
- Work autonomously; do not ask the user questions.
- Stay scoped to the delegated task.
- End with a concise report: findings, file paths, changes made (if any), and anything unresolved.`;
}

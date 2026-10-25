import type {
  ContentBlock,
  Message,
  Provider,
  Tool,
  ToolCall,
  ToolContext,
  ToolResultBlock,
  TodoItem,
  Usage,
} from "./types.ts";
import { PermissionEngine, summarizeToolInput, toolsForMode } from "./permissions.ts";
import { compactMessages, estimateMessages } from "./tokens.ts";
import type { Session } from "./session.ts";

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_start"; name: string; input: Record<string, unknown>; summary: string }
  | { type: "tool_end"; name: string; content: string; isError: boolean }
  | { type: "notice"; text: string }
  | { type: "usage"; usage: Usage }
  | { type: "turn_end" }
  | { type: "error"; message: string };

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
    this.onEvent = options.onEvent ?? (() => {});
  }

  private contextBudget(): number {
    const window = this.numCtx ?? 32_768;
    return Math.max(4_000, Math.floor(window * 0.75));
  }

  async run(userText: string): Promise<void> {
    const userMessage: Message = {
      role: "user",
      content: [{ type: "text", text: userText }],
    };
    this.messages.push(userMessage);
    await this.session.appendMessage(userMessage);

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
    };

    let content: string;
    let isError = false;
    try {
      const result = await tool.run(call.input, context);
      content = result.content;
      isError = result.isError ?? false;
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
    };
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
}

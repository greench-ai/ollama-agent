// Shared types for the agent core.
// Kept UI-agnostic so the same core can back a CLI and a desktop shell.

export type JsonSchema = {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
};

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  /** Tool name; Ollama needs it on the tool message. */
  name?: string;
  content: string;
  is_error?: boolean;
}

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock;

export interface Message {
  role: "system" | "user" | "assistant";
  content: ContentBlock[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
}

export interface ToolContext {
  cwd: string;
  sessionId: string;
  signal: AbortSignal;
  todos: TodoItem[];
  log: (line: string) => void;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** True when the tool can change files or run commands. */
  mutating: boolean;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
}

export type ProviderEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "done"; stopReason: string; usage?: Usage };

export interface ChatRequest {
  model: string;
  /** Conversation only; the system prompt travels separately. */
  messages: Message[];
  tools: ToolDefinition[];
  system?: string;
  temperature?: number;
  numCtx?: number;
  think?: boolean;
  signal?: AbortSignal;
}

export interface ModelInfo {
  name: string;
  size?: number;
  parameterSize?: string;
  quantization?: string;
  capabilities?: string[];
}

export interface Provider {
  readonly name: string;
  chat(req: ChatRequest): AsyncGenerator<ProviderEvent>;
  listModels(): Promise<ModelInfo[]>;
}

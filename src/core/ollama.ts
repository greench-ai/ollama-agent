import { randomUUID } from "node:crypto";
import type {
  ChatRequest,
  Message,
  ModelInfo,
  Provider,
  ProviderEvent,
  ToolCall,
} from "./types.ts";

export interface OllamaConfig {
  /** Base URL, e.g. http://127.0.0.1:11434 or https://ollama.com */
  host: string;
  /** Bearer token for Ollama Cloud. Omit for a local daemon. */
  apiKey?: string;
  /** Extra headers, merged after auth. */
  headers?: Record<string, string>;
}

type OllamaMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  images?: string[];
  tool_name?: string;
  tool_calls?: Array<{ function: { name: string; arguments: unknown } }>;
};

/** Normalize the many shapes a host may be configured with. */
export function normalizeHost(raw: string): string {
  let host = raw.trim();
  if (!host) return "http://127.0.0.1:11434";
  if (!/^https?:\/\//i.test(host)) host = `http://${host}`;
  return host.replace(/\/+$/, "");
}

/**
 * Convert the internal Anthropic-shaped conversation into Ollama chat messages.
 * Exported for tests: this mapping is the part most likely to drift between
 * Ollama versions.
 */
export function toOllamaMessages(
  messages: Message[],
  system?: string,
): OllamaMessage[] {
  const out: OllamaMessage[] = [];
  if (system && system.trim()) out.push({ role: "system", content: system });

  for (const message of messages) {
    if (message.role === "user") {
      const toolResults = message.content.filter((b) => b.type === "tool_result");
      if (toolResults.length > 0) {
        const toolImages: Array<{ data: string; name?: string; tool?: string }> = [];
        for (const block of toolResults) {
          if (block.type !== "tool_result") continue;
          out.push({
            role: "tool",
            content: block.content,
            ...(block.name ? { tool_name: block.name } : {}),
          });
          for (const image of block.images ?? []) {
            toolImages.push({ data: image.data, name: image.name, tool: block.name });
          }
        }
        // Ollama attaches images to user messages, not tool messages. Append a
        // user turn so the model can see images returned by a tool.
        if (toolImages.length > 0) {
          const label = toolImages
            .map((image, index) => `${image.name ?? `image ${index + 1}`}${image.tool ? ` (from ${image.tool})` : ""}`)
            .join(", ");
          out.push({
            role: "user",
            content: `Images returned by tool results: ${label}`,
            images: toolImages.map((image) => image.data),
          });
        }
        continue;
      }
      const userText = message.content
        .filter((b) => b.type === "text")
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("\n");
      const fileText = message.content
        .map((block) =>
          block.type === "file"
            ? `--- Attached file: ${block.name} (${block.mimeType}) ---\n${block.content}\n--- End of ${block.name} ---`
            : "",
        )
        .filter(Boolean)
        .join("\n\n");
      const text = [userText, fileText].filter(Boolean).join("\n\n");
      const images = message.content
        .filter((b) => b.type === "image")
        .map((b) => (b.type === "image" ? b.data : ""));
      out.push({
        role: "user",
        content: text,
        ...(images.length > 0 ? { images } : {}),
      });
      continue;
    }

    if (message.role === "assistant") {
      const text = message.content
        .filter((b) => b.type === "text")
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("");
      const calls = message.content.filter((b) => b.type === "tool_use");
      const entry: OllamaMessage = { role: "assistant", content: text };
      if (calls.length > 0) {
        entry.tool_calls = calls.map((block) => {
          if (block.type !== "tool_use") throw new Error("unreachable");
          return { function: { name: block.name, arguments: block.input } };
        });
      }
      // Thinking blocks are intentionally dropped: Ollama does not accept them
      // back as input, and replayed reasoning would only waste context.
      out.push(entry);
      continue;
    }
  }
  return out;
}

function parseArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through to the empty input below
    }
  }
  return {};
}

export class OllamaProvider implements Provider {
  readonly name = "ollama";
  private host: string;
  private apiKey?: string;
  private headers: Record<string, string>;

  constructor(config: OllamaConfig) {
    this.host = normalizeHost(config.host);
    this.apiKey = config.apiKey;
    this.headers = config.headers ?? {};
  }

  get baseUrl(): string {
    return this.host;
  }

  private requestHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...this.headers,
    };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    return headers;
  }

  async listModels(): Promise<ModelInfo[]> {
    const response = await this.fetch("/api/tags", { method: "GET" });
    const body = (await response.json()) as {
      models?: Array<{
        name: string;
        size?: number;
        details?: {
          parameter_size?: string;
          quantization_level?: string;
        };
      }>;
    };
    return (body.models ?? []).map((model) => ({
      name: model.name,
      size: model.size,
      parameterSize: model.details?.parameter_size,
      quantization: model.details?.quantization_level,
    }));
  }

  async showModel(model: string): Promise<ModelInfo | undefined> {
    const response = await this.fetch("/api/show", {
      method: "POST",
      body: JSON.stringify({ model }),
    });
    const body = (await response.json()) as {
      capabilities?: string[];
      details?: { parameter_size?: string; quantization_level?: string };
    };
    return {
      name: model,
      capabilities: body.capabilities ?? [],
      parameterSize: body.details?.parameter_size,
      quantization: body.details?.quantization_level,
    };
  }

  private async fetch(path: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`${this.host}${path}`, {
        ...init,
        headers: { ...this.requestHeaders(), ...(init.headers ?? {}) },
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Could not reach Ollama at ${this.host} (${reason}). ` +
          `Is it running? Try: ollama serve`,
      );
    }
    if (!response.ok) {
      const text = (await response.text()).slice(0, 800);
      throw new Error(
        `Ollama ${path} returned ${response.status} ${response.statusText}: ${text}`,
      );
    }
    return response;
  }

  async *chat(req: ChatRequest): AsyncGenerator<ProviderEvent> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: toOllamaMessages(req.messages, req.system),
      stream: true,
    };
    if (req.tools.length > 0) {
      body.tools = req.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));
    }
    const options: Record<string, unknown> = {};
    if (typeof req.temperature === "number") options.temperature = req.temperature;
    if (typeof req.numCtx === "number") options.num_ctx = req.numCtx;
    if (Object.keys(options).length > 0) body.options = options;
    if (req.think) body.think = true;

    const response = await this.fetch("/api/chat", {
      method: "POST",
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!response.body) throw new Error("Ollama returned an empty stream");

    const decoder = new TextDecoder();
    let buffer = "";
    let sawToolCall = false;

    const stream = response.body as unknown as AsyncIterable<Uint8Array>;
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;

        let payload: {
          message?: {
            content?: string;
            thinking?: string;
            tool_calls?: Array<{
              function?: { name?: string; arguments?: unknown };
            }>;
          };
          done?: boolean;
          done_reason?: string;
          prompt_eval_count?: number;
          eval_count?: number;
        };
        try {
          payload = JSON.parse(line);
        } catch {
          continue;
        }

        const message = payload.message;
        if (message?.thinking) {
          yield { type: "thinking", text: message.thinking };
        }
        if (message?.content) {
          yield { type: "text", text: message.content };
        }
        for (const raw of message?.tool_calls ?? []) {
          const name = raw.function?.name;
          if (!name) continue;
          sawToolCall = true;
          const call: ToolCall = {
            id: `call_${randomUUID().slice(0, 8)}`,
            name,
            input: parseArguments(raw.function?.arguments),
          };
          yield { type: "tool_call", call };
        }

        if (payload.done) {
          yield {
            type: "done",
            stopReason: sawToolCall
              ? "tool_use"
              : payload.done_reason === "length"
                ? "max_tokens"
                : "end_turn",
            usage: {
              inputTokens: payload.prompt_eval_count,
              outputTokens: payload.eval_count,
            },
          };
          return;
        }
      }
    }
  }
}

import { JsonRpcConnection, JsonRpcError } from "./jsonrpc.ts";
import { HttpTransport, StdioTransport } from "./transports.ts";
import { ensureToken } from "./oauth.ts";
import type { McpServerConfig } from "./config.ts";
import type { JsonSchema } from "../core/types.ts";

export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema: JsonSchema;
  annotations?: McpToolAnnotations;
}

export interface McpContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  resource?: { uri?: string; text?: string; mimeType?: string };
  [key: string]: unknown;
}

export interface McpCallResult {
  content?: McpContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
  [key: string]: unknown;
}

export interface McpResourceInfo {
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

export interface McpPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface McpPromptInfo {
  name: string;
  title?: string;
  description?: string;
  arguments?: McpPromptArgument[];
}

export interface McpPromptResult {
  description?: string;
  messages: Array<{
    role: "user" | "assistant";
    content: McpContentBlock | McpContentBlock[];
  }>;
}

export interface McpClientOptions {
  timeoutMs?: number;
  onLog?: (line: string) => void;
  /** Injectable for tests; defaults to opening the system browser. */
  openUrl?: (url: string) => Promise<void>;
}

export class McpClient {
  readonly name: string;
  readonly serverInfo: { name?: string; version?: string } = {};
  readonly capabilities: Record<string, unknown> = {};
  instructions?: string;
  private connection: JsonRpcConnection;
  private transport: StdioTransport | HttpTransport;
  private timeoutMs: number;

  private constructor(
    name: string,
    connection: JsonRpcConnection,
    transport: StdioTransport | HttpTransport,
    timeoutMs: number,
  ) {
    this.name = name;
    this.connection = connection;
    this.transport = transport;
    this.timeoutMs = timeoutMs;
  }

  static async connect(
    name: string,
    config: McpServerConfig,
    options: McpClientOptions = {},
  ): Promise<McpClient> {
    let token: string | undefined;
    if ("url" in config && config.auth) {
      token = await ensureToken(name, config.auth, { openUrl: options.openUrl });
    }

    let attempts = 0;
    while (true) {
      try {
        return await McpClient.connectOnce(name, config, options, token);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const unauthorized = /401|unauthorized/i.test(message);
        if (
          !("url" in config) ||
          !config.auth ||
          !unauthorized ||
          attempts >= 1
        ) {
          throw error;
        }
        // The cached token was rejected: refresh, then authorize if needed.
        attempts += 1;
        token = await ensureToken(name, config.auth, {
          force: true,
          openUrl: options.openUrl,
        });
      }
    }
  }

  private static async connectOnce(
    name: string,
    config: McpServerConfig,
    options: McpClientOptions,
    token?: string,
  ): Promise<McpClient> {
    const timeoutMs = options.timeoutMs ?? 60_000;
    let transport: StdioTransport | HttpTransport | undefined;
    const connection = new JsonRpcConnection(
      async (message) => {
        if (!transport) throw new Error("MCP transport is not ready.");
        await transport.send(message);
      },
      {
        onNotification: () => {
          // Notifications (list_changed, progress, logging) are ignored for now.
        },
      },
    );

    const transportOptions = {
      onMessage: (message: unknown) => connection.handleMessage(message),
      onError: (error: Error) => connection.fail(error.message),
      onLog: options.onLog,
    };

    if ("url" in config) {
      transport = new HttpTransport(
        {
          url: config.url,
          headers: {
            ...config.headers,
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
        },
        transportOptions,
      );
    } else {
      transport = new StdioTransport(
        {
          command: config.command,
          args: config.args,
          env: config.env,
          cwd: config.cwd,
        },
        transportOptions,
      );
    }

    const client = new McpClient(name, connection, transport, timeoutMs);
    try {
      const init = (await connection.request(
        "initialize",
        {
          protocolVersion: "2024-11-05",
          capabilities: { roots: { listChanged: false } },
          clientInfo: { name: "ollama-agent", version: "0.1.0" },
        },
        30_000,
      )) as {
        serverInfo?: { name?: string; version?: string };
        capabilities?: Record<string, unknown>;
        instructions?: string;
      };
      client.serverInfo.name = init.serverInfo?.name;
      client.serverInfo.version = init.serverInfo?.version;
      Object.assign(client.capabilities, init.capabilities ?? {});
      client.instructions = init.instructions;
      await connection.notify("notifications/initialized");
      return client;
    } catch (error) {
      await transport.close().catch(() => {});
      throw error;
    }
  }

  async listTools(): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const response = (await this.connection.request(
        "tools/list",
        cursor ? { cursor } : {},
        this.timeoutMs,
      )) as { tools?: McpToolInfo[]; nextCursor?: string };
      for (const tool of response.tools ?? []) {
        if (!tool || typeof tool.name !== "string") continue;
        tools.push({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema:
            tool.inputSchema && typeof tool.inputSchema === "object"
              ? tool.inputSchema
              : { type: "object", properties: {} },
          annotations: tool.annotations,
        });
      }
      cursor = response.nextCursor;
    } while (cursor);
    return tools;
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<McpCallResult> {
    const request = this.connection.request<McpCallResult>(
      "tools/call",
      { name: toolName, arguments: args },
      options.timeoutMs ?? this.timeoutMs,
    );
    if (!options.signal) return request;

    const signal = options.signal;
    if (signal.aborted) throw new Error("MCP tool call aborted.");
    return new Promise<McpCallResult>((resolve, reject) => {
      const onAbort = () => reject(new Error("MCP tool call aborted."));
      signal.addEventListener("abort", onAbort, { once: true });
      request
        .then((value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        })
        .catch((error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        });
    });
  }

  async ping(): Promise<void> {
    await this.connection.request("ping", {}, 5_000);
  }

  get isConnected(): boolean {
    return !this.connection.isClosed;
  }

  private supports(capability: string): boolean {
    return Boolean(this.capabilities[capability]);
  }

  async listResources(): Promise<McpResourceInfo[]> {
    if (!this.supports("resources")) return [];
    const resources: McpResourceInfo[] = [];
    let cursor: string | undefined;
    do {
      const response = (await this.connection.request(
        "resources/list",
        cursor ? { cursor } : {},
        this.timeoutMs,
      )) as { resources?: McpResourceInfo[]; nextCursor?: string };
      for (const resource of response.resources ?? []) {
        if (!resource || typeof resource.uri !== "string") continue;
        resources.push(resource);
      }
      cursor = response.nextCursor;
    } while (cursor);
    return resources;
  }

  async readResource(uri: string): Promise<McpResourceContent[]> {
    if (!this.supports("resources")) {
      throw new Error(`Server "${this.name}" does not advertise resources.`);
    }
    const response = (await this.connection.request(
      "resources/read",
      { uri },
      this.timeoutMs,
    )) as { contents?: McpResourceContent[] };
    return response.contents ?? [];
  }

  async listPrompts(): Promise<McpPromptInfo[]> {
    if (!this.supports("prompts")) return [];
    const prompts: McpPromptInfo[] = [];
    let cursor: string | undefined;
    do {
      const response = (await this.connection.request(
        "prompts/list",
        cursor ? { cursor } : {},
        this.timeoutMs,
      )) as { prompts?: McpPromptInfo[]; nextCursor?: string };
      for (const prompt of response.prompts ?? []) {
        if (!prompt || typeof prompt.name !== "string") continue;
        prompts.push(prompt);
      }
      cursor = response.nextCursor;
    } while (cursor);
    return prompts;
  }

  async getPrompt(
    name: string,
    args: Record<string, string> = {},
  ): Promise<McpPromptResult> {
    if (!this.supports("prompts")) {
      throw new Error(`Server "${this.name}" does not advertise prompts.`);
    }
    return (await this.connection.request(
      "prompts/get",
      { name, arguments: args },
      this.timeoutMs,
    )) as McpPromptResult;
  }

  async close(): Promise<void> {
    this.connection.fail(`MCP client "${this.name}" closed.`);
    await this.transport.close().catch(() => {});
  }
}

/** Turn an MCP tool result into text the model can consume. */
export function mcpResultToText(result: McpCallResult): string {
  const parts: string[] = [];
  for (const block of result.content ?? []) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
      continue;
    }
    if (block.type === "image") {
      const bytes = typeof block.data === "string" ? Math.floor((block.data.length * 3) / 4) : 0;
      parts.push(`[image ${block.mimeType ?? "unknown"}, ~${bytes} bytes]`);
      continue;
    }
    if (block.type === "resource") {
      const resource = block.resource;
      if (resource?.text !== undefined) parts.push(resource.text);
      else parts.push(`[resource ${resource?.uri ?? block.uri ?? "unknown"}]`);
      continue;
    }
    if (block.type === "resource_link") {
      parts.push(`[resource link ${String(block.uri ?? block.name ?? "unknown")}]`);
      continue;
    }
    parts.push(JSON.stringify(block));
  }

  if (parts.length === 0 && result.structuredContent !== undefined) {
    return JSON.stringify(result.structuredContent, null, 2);
  }
  return parts.join("\n\n");
}

/** Render an MCP prompt into a single text block for the conversation. */
export function mcpPromptToText(result: McpPromptResult): string {
  const renderBlock = (block: McpContentBlock): string => {
    if (block.type === "text" && typeof block.text === "string") return block.text;
    if (block.type === "image") return `[image ${block.mimeType ?? "unknown"}]`;
    if (block.type === "resource") {
      const resource = block.resource;
      return resource?.text ?? `[resource ${resource?.uri ?? "unknown"}]`;
    }
    return JSON.stringify(block);
  };

  return result.messages
    .map((message) => {
      const blocks = Array.isArray(message.content) ? message.content : [message.content];
      return `[${message.role}]\n${blocks.map(renderBlock).join("\n")}`;
    })
    .join("\n\n");
}

export { JsonRpcError };

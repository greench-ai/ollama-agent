import type { Tool, ToolContext } from "../core/types.ts";
import {
  McpClient,
  mcpResultToText,
  type McpPromptInfo,
  type McpPromptResult,
  type McpResourceContent,
  type McpResourceInfo,
  type McpToolInfo,
} from "./client.ts";
import type { McpServerConfig } from "./config.ts";

export interface McpServerStatus {
  name: string;
  ok: boolean;
  toolCount: number;
  serverName?: string;
  error?: string;
}

export interface McpResourceEntry extends McpResourceInfo {
  server: string;
}

export interface McpPromptEntry extends McpPromptInfo {
  server: string;
}

export interface McpManagerOptions {
  timeoutMs?: number;
  onLog?: (line: string) => void;
}

function wrapTool(server: string, info: McpToolInfo, manager: McpManager): Tool {
  return {
    // Claude Code's convention: <server>__<tool>. Keeps MCP tools from
    // colliding with built-ins and makes the origin obvious to the model.
    name: `${server}__${info.name}`,
    description:
      info.description ??
      info.title ??
      `MCP tool "${info.name}" provided by the "${server}" server.`,
    inputSchema: info.inputSchema,
    // MCP annotations are advisory. Anything that does not explicitly claim to
    // be read-only still goes through the permission prompt.
    mutating: info.annotations?.readOnlyHint !== true,
    async run(input, ctx) {
      const result = await manager.callTool(server, info.name, input, ctx);
      return {
        content: mcpResultToText(result),
        isError: result.isError ?? false,
      };
    },
  };
}

export class McpManager {
  readonly tools: Tool[] = [];
  readonly servers: McpServerStatus[] = [];
  readonly resources: McpResourceEntry[] = [];
  readonly prompts: McpPromptEntry[] = [];

  private configs: Record<string, McpServerConfig> = {};
  private clients = new Map<string, McpClient>();
  private options: McpManagerOptions = {};

  private constructor() {}

  static async start(
    servers: Record<string, McpServerConfig>,
    options: McpManagerOptions = {},
  ): Promise<McpManager> {
    const manager = new McpManager();
    manager.options = options;
    manager.configs = { ...servers };

    await Promise.all(
      Object.entries(servers).map(async ([name, config]) => {
        try {
          await manager.connectServer(name, config);
        } catch {
          // connectServer already recorded the failure in servers[].
        }
      }),
    );

    manager.servers.sort((a, b) => a.name.localeCompare(b.name));
    manager.tools.sort((a, b) => a.name.localeCompare(b.name));
    return manager;
  }

  /** Connect (or reconnect) one configured server and refresh its inventory. */
  private async connectServer(
    name: string,
    config: McpServerConfig,
  ): Promise<McpClient> {
    try {
      const client = await McpClient.connect(name, config, {
        timeoutMs: this.options.timeoutMs,
        onLog: (line) => this.options.onLog?.(`[mcp:${name}] ${line}`),
      });
      this.clients.set(name, client);

      const toolInfos = await client.listTools();
      const prefix = `${name}__`;
      for (let index = this.tools.length - 1; index >= 0; index -= 1) {
        if (this.tools[index].name.startsWith(prefix)) this.tools.splice(index, 1);
      }
      this.tools.push(...toolInfos.map((info) => wrapTool(name, info, this)));
      this.tools.sort((a, b) => a.name.localeCompare(b.name));

      const resources = await client.listResources().catch(() => []);
      const prompts = await client.listPrompts().catch(() => []);
      const keptResources = this.resources.filter((entry) => entry.server !== name);
      const keptPrompts = this.prompts.filter((entry) => entry.server !== name);
      this.resources.length = 0;
      this.resources.push(...keptResources, ...resources.map((entry) => ({ server: name, ...entry })));
      this.prompts.length = 0;
      this.prompts.push(...keptPrompts, ...prompts.map((entry) => ({ server: name, ...entry })));

      this.setStatus({
        name,
        ok: true,
        toolCount: toolInfos.length,
        serverName: client.serverInfo.name,
      });
      return client;
    } catch (error) {
      this.setStatus({
        name,
        ok: false,
        toolCount: 0,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private setStatus(status: McpServerStatus): void {
    const index = this.servers.findIndex((entry) => entry.name === status.name);
    if (index >= 0) this.servers[index] = status;
    else this.servers.push(status);
    this.servers.sort((a, b) => a.name.localeCompare(b.name));
  }

  private async ensureClient(server: string): Promise<McpClient> {
    const existing = this.clients.get(server);
    if (existing?.isConnected) return existing;

    const config = this.configs[server];
    if (!config) throw new Error(`Unknown MCP server "${server}".`);
    if (existing) await existing.close().catch(() => {});
    return this.connectServer(server, config);
  }

  /** Call a tool, reconnecting once if the server dropped its connection. */
  async callTool(
    server: string,
    toolName: string,
    input: Record<string, unknown>,
    context: ToolContext,
  ) {
    const client = await this.ensureClient(server);
    try {
      return await client.callTool(toolName, input, { signal: context.signal });
    } catch (error) {
      if (client.isConnected) throw error;
      const fresh = await this.ensureClient(server);
      return fresh.callTool(toolName, input, { signal: context.signal });
    }
  }

  async readResource(server: string, uri: string): Promise<McpResourceContent[]> {
    const client = await this.ensureClient(server);
    return client.readResource(uri);
  }

  async getPrompt(
    server: string,
    name: string,
    args: Record<string, string> = {},
  ): Promise<McpPromptResult> {
    const client = await this.ensureClient(server);
    return client.getPrompt(name, args);
  }

  /** Reconnect one server, or all of them when no name is given. */
  async reconnect(server?: string): Promise<McpServerStatus[]> {
    const names = server ? [server] : Object.keys(this.configs);
    for (const name of names) {
      const config = this.configs[name];
      if (!config) throw new Error(`Unknown MCP server "${name}".`);
      const existing = this.clients.get(name);
      if (existing) {
        await existing.close().catch(() => {});
        this.clients.delete(name);
      }
      try {
        await this.connectServer(name, config);
      } catch {
        // Status carries the failure.
      }
    }
    return server
      ? this.servers.filter((entry) => entry.name === server)
      : [...this.servers];
  }

  /** Accessor used by diagnostics and tests. */
  clientFor(server: string): McpClient | undefined {
    return this.clients.get(server);
  }

  summary(): string {
    const ok = this.servers.filter((server) => server.ok).length;
    return `${ok}/${this.servers.length} server(s), ${this.tools.length} tool(s)`;
  }

  async close(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(clients.map((client) => client.close().catch(() => {})));
  }
}

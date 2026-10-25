import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Agent, type AgentEvent } from "./core/agent.ts";
import { OllamaProvider } from "./core/ollama.ts";
import {
  PERMISSION_MODES,
  PermissionEngine,
  type AskOutcome,
  type PermissionMode,
} from "./core/permissions.ts";
import { Session } from "./core/session.ts";
import { loadMcpConfig } from "./mcp/config.ts";
import { McpManager } from "./mcp/manager.ts";
import { allTools } from "./tools/index.ts";

interface ServerOptions {
  port: number;
  bind: string;
  host?: string;
  apiKey?: string;
  model?: string;
  cwd: string;
  mode: PermissionMode;
  mcpConfig?: string;
  noMcp: boolean;
}

function parseOptions(argv: string[]): ServerOptions {
  const options: ServerOptions = {
    port: 4317,
    bind: "127.0.0.1",
    cwd: process.cwd(),
    mode: "default",
    noMcp: false,
  };
  const take = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (!value) throw new Error(`Missing value for ${flag}`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--port":
        options.port = Number(take(index, arg));
        index += 1;
        break;
      case "--bind":
        options.bind = take(index, arg);
        index += 1;
        break;
      case "--host":
        options.host = take(index, arg);
        index += 1;
        break;
      case "--api-key":
        options.apiKey = take(index, arg);
        index += 1;
        break;
      case "--model":
      case "-m":
        options.model = take(index, arg);
        index += 1;
        break;
      case "--cwd":
        options.cwd = path.resolve(take(index, arg));
        index += 1;
        break;
      case "--mode": {
        const value = take(index, arg) as PermissionMode;
        if (!PERMISSION_MODES.includes(value)) {
          throw new Error(`Unknown mode "${value}".`);
        }
        options.mode = value;
        index += 1;
        break;
      }
      case "--mcp-config":
        options.mcpConfig = take(index, arg);
        index += 1;
        break;
      case "--no-mcp":
        options.noMcp = true;
        break;
      case "--help":
      case "-h":
        console.log(`ollama-agent server

  node src/server.ts [--port 4317] [--bind 127.0.0.1] [--model NAME]
                     [--host URL] [--api-key KEY] [--cwd DIR]
                     [--mode default|acceptEdits|plan|bypassPermissions]
                     [--mcp-config PATH] [--no-mcp]
`);
        process.exit(0);
      default:
        throw new Error(`Unknown argument "${arg}". Try --help.`);
    }
  }
  if (!Number.isFinite(options.port) || options.port <= 0) {
    throw new Error("--port must be a positive number.");
  }
  return options;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > 1_000_000) throw new Error("Request body too large.");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new Error("Invalid JSON body.");
  }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const provider = new OllamaProvider({
    host: options.host ?? process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434",
    apiKey: options.apiKey ?? process.env.OLLAMA_API_KEY,
  });

  const models = await provider.listModels();
  let model = options.model ?? process.env.OLLAMA_MODEL ?? models[0]?.name;
  if (!model) {
    console.error("No models found. Pull one first, e.g. ollama pull qwen3:8b");
    process.exit(1);
  }

  const session = await Session.create({ cwd: options.cwd, model });
  let mcp: McpManager | undefined;
  if (!options.noMcp) {
    try {
      const config = await loadMcpConfig(options.mcpConfig, options.cwd);
      if (Object.keys(config.servers).length > 0) {
        mcp = await McpManager.start(config.servers, {
          onLog: (line) => {
            if (process.env.OLLAMA_AGENT_MCP_LOG) console.error(line);
          },
        });
      }
    } catch (error) {
      console.error(`MCP config: ${error instanceof Error ? error.message : error}`);
    }
  }

  type Stream = { send: (event: string, data: unknown) => void };
  let stream: Stream | undefined;
  let busy = false;
  const approvals = new Map<string, (outcome: AskOutcome) => void>();

  const ask = async (request: {
    tool: string;
    input: Record<string, unknown>;
    summary: string;
  }): Promise<AskOutcome> => {
    if (!stream) return "deny";
    const id = randomUUID();
    const outcome = await new Promise<AskOutcome>((resolve) => {
      approvals.set(id, resolve);
      const timer = setTimeout(() => {
        if (approvals.delete(id)) resolve("deny");
      }, 120_000);
      timer.unref?.();
      stream?.send("approval", {
        id,
        tool: request.tool,
        summary: request.summary,
        input: request.input,
      });
    });
    approvals.delete(id);
    return outcome;
  };

  const permissions = new PermissionEngine(options.mode, ask);
  const agent = new Agent({
    provider,
    model,
    tools: [...allTools, ...(mcp?.tools ?? [])],
    permissions,
    session,
    cwd: options.cwd,
    system: `You are a coding agent working in ${options.cwd}. Use absolute paths, read files before editing them, prefer Read/Grep/Glob over shell equivalents, and summarize what you changed when you finish.`,
    onEvent: (event: AgentEvent) => {
      if (!stream) return;
      switch (event.type) {
        case "text":
          stream.send("text", { text: event.text });
          break;
        case "thinking":
          stream.send("thinking", { text: event.text });
          break;
        case "tool_start":
          stream.send("tool_start", {
            name: event.name,
            summary: event.summary,
            input: event.input,
          });
          break;
        case "tool_end":
          stream.send("tool_end", {
            name: event.name,
            content: event.content,
            isError: event.isError,
          });
          break;
        case "notice":
          stream.send("notice", { text: event.text });
          break;
        case "error":
          stream.send("error", { message: event.message });
          break;
        case "usage":
          break;
        case "turn_end":
          stream.send("step", {});
          break;
      }
    },
  });

  const here = path.dirname(fileURLToPath(import.meta.url));
  const webDir = path.join(here, "..", "web");
  const staticFiles: Record<string, string> = {
    "/": "index.html",
    "/index.html": "index.html",
    "/app.js": "app.js",
    "/browser-bridge.js": "browser-bridge.js",
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    try {
      const staticFile = staticFiles[url.pathname];
      if (request.method === "GET" && staticFile) {
        const body = await readFile(path.join(webDir, staticFile));
        response.writeHead(200, {
          "content-type": staticFile.endsWith(".js")
            ? "text/javascript; charset=utf-8"
            : "text/html; charset=utf-8",
        });
        response.end(body);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/state") {
        json(response, 200, {
          model: agent.model,
          mode: permissions.mode,
          cwd: options.cwd,
          session: session.file,
          mcp: mcp?.servers ?? [],
          resources: mcp?.resources ?? [],
          prompts: mcp?.prompts ?? [],
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/models") {
        json(response, 200, { models: await provider.listModels(), current: agent.model });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/state") {
        const body = await readJson(request);
        if (typeof body.model === "string" && body.model.trim()) {
          agent.model = body.model.trim();
          session.model = agent.model;
        }
        if (typeof body.mode === "string") {
          if (!PERMISSION_MODES.includes(body.mode as PermissionMode)) {
            json(response, 400, { error: "Unknown mode." });
            return;
          }
          permissions.setMode(body.mode as PermissionMode);
        }
        json(response, 200, { model: agent.model, mode: permissions.mode });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/approve") {
        const body = await readJson(request);
        const id = typeof body.id === "string" ? body.id : "";
        const resolver = approvals.get(id);
        if (!resolver) {
          json(response, 404, { error: "Unknown approval id." });
          return;
        }
        approvals.delete(id);
        const decision = body.decision;
        resolver(
          decision === "allow" || decision === "always" || decision === "deny"
            ? decision
            : "deny",
        );
        json(response, 200, { ok: true });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/reset") {
        agent.reset();
        json(response, 200, { ok: true });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/chat") {
        if (busy) {
          json(response, 409, { error: "A turn is already running." });
          return;
        }
        const body = await readJson(request);
        const message = typeof body.message === "string" ? body.message.trim() : "";
        if (!message) {
          json(response, 400, { error: "Missing message." });
          return;
        }

        busy = true;
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const send = (event: string, data: unknown): void => {
          response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        stream = { send };

        const controller = new AbortController();
        agent.signal = controller.signal;
        // response "close" means the client went away; abort the turn.
        response.on("close", () => controller.abort());

        send("start", { model: agent.model, mode: permissions.mode });
        try {
          await agent.run(message);
        } catch (error) {
          send("error", {
            message: error instanceof Error ? error.message : String(error),
          });
        } finally {
          send("done", agent.contextUsage());
          stream = undefined;
          busy = false;
          response.end();
        }
        return;
      }

      json(response, 404, { error: "Not found." });
    } catch (error) {
      if (!response.headersSent) {
        json(response, 500, {
          error: error instanceof Error ? error.message : String(error),
        });
      } else {
        response.end();
      }
    }
  });

  server.listen(options.port, options.bind, () => {
    console.log(`ollama-agent server on http://${options.bind}:${options.port}`);
    console.log(`model ${model} · mode ${permissions.mode} · cwd ${options.cwd}`);
    if (mcp) console.log(`mcp ${mcp.summary()}`);
  });

  const shutdown = async (): Promise<void> => {
    server.close();
    await mcp?.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

await main();

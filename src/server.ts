import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Agent, type AgentEvent } from "./core/agent.ts";
import { MAX_IMAGES, validateImageAttachment } from "./core/images.ts";
import type { ImageAttachment } from "./core/types.ts";
import { OllamaProvider } from "./core/ollama.ts";
import {
  PERMISSION_MODES,
  PermissionEngine,
  type AskOutcome,
  type PermissionMode,
} from "./core/permissions.ts";
import { Session } from "./core/session.ts";
import {
  deleteSession,
  listSessions,
  loadSession,
  renameSession,
} from "./core/sessions.ts";
import { loadSettings, updateSettings, type AppSettings } from "./core/settings.ts";
import { readProjectFile } from "./core/files.ts";
import {
  assertDirectory,
  buildSystemPrompt,
  loadProjectInstructions,
  type ProjectInstructions,
} from "./core/project.ts";
import { checkForLatestRelease } from "./core/updates.ts";
import { loadMcpConfig, type McpServerConfig } from "./mcp/config.ts";
import {
  defaultMcpConfigPath,
  readMcpConfigFile,
  removeMcpServer,
  saveMcpServer,
} from "./mcp/config-editor.ts";
import { clearToken } from "./mcp/oauth.ts";
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
  modeProvided: boolean;
  mcpConfig?: string;
  noMcp: boolean;
}

function parseOptions(argv: string[]): ServerOptions {
  const options: ServerOptions = {
    port: 4317,
    bind: "127.0.0.1",
    cwd: process.cwd(),
    mode: "default",
    modeProvided: false,
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
        options.modeProvided = true;
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
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version?: string };
  const appVersion = packageJson.version ?? "0.0.0";
  const provider = new OllamaProvider({
    host: options.host ?? process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434",
    apiKey: options.apiKey ?? process.env.OLLAMA_API_KEY,
  });

  let settings = await loadSettings();
  const models = await provider.listModels();
  let model =
    options.model ?? process.env.OLLAMA_MODEL ?? settings.model ?? models[0]?.name;
  if (!model) {
    console.error("No models found. Pull one first, e.g. ollama pull qwen3:8b");
    process.exit(1);
  }

  const session = await Session.create({ cwd: options.cwd, model });
  let projectInstructions: ProjectInstructions | undefined =
    await loadProjectInstructions(options.cwd);
  let mcpConfigPath = defaultMcpConfigPath();
  let mcp: McpManager | undefined;
  if (!options.noMcp) {
    try {
      const config = await loadMcpConfig(options.mcpConfig, options.cwd);
      if (config.path) mcpConfigPath = config.path;
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
  let currentRun: AbortController | null = null;
  const approvals = new Map<string, (outcome: AskOutcome) => void>();
  const planApprovals = new Map<
    string,
    (result: { approved: boolean; feedback?: string }) => void
  >();

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

  const planApprover = async (
    plan: string,
  ): Promise<{ approved: boolean; feedback?: string }> => {
    if (!stream) return { approved: false, feedback: "No active stream." };
    const id = randomUUID();
    return new Promise<{ approved: boolean; feedback?: string }>((resolve) => {
      planApprovals.set(id, resolve);
      const timer = setTimeout(() => {
        if (planApprovals.delete(id)) {
          resolve({ approved: false, feedback: "Plan approval timed out." });
        }
      }, 300_000);
      timer.unref?.();
      stream?.send("plan_approval", { id, plan });
    }).finally(() => planApprovals.delete(id));
  };

  const permissions = new PermissionEngine(
    options.modeProvided ? options.mode : settings.mode,
    ask,
  );
  const agent = new Agent({
    provider,
    model,
    tools: [...allTools, ...(mcp?.tools ?? [])],
    permissions,
    session,
    cwd: options.cwd,
    system: buildSystemPrompt(options.cwd, projectInstructions),
    planApprover,
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
        case "session_title":
          stream.send("session_title", { title: event.title });
          break;
        case "subagent_start":
          stream.send("subagent_start", {
            name: event.name,
            description: event.description,
            subagentType: event.subagentType,
            model: event.model,
          });
          break;
        case "subagent_end":
          stream.send("subagent_end", {
            name: event.name,
            description: event.description,
            subagentType: event.subagentType,
            ok: event.ok,
            messages: event.messages,
          });
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

  const statePayload = () => ({
    model: agent.model,
    mode: permissions.mode,
    cwd: options.cwd,
    session: agent.session.file,
    mcp: mcp?.servers ?? [],
    resources: mcp?.resources ?? [],
    prompts: mcp?.prompts ?? [],
    settings: {
      theme: settings.theme,
      showThinking: settings.showThinking,
      model: settings.model,
      mode: settings.mode,
    },
    mcpPath: mcpConfigPath,
    version: appVersion,
    projectInstructions: projectInstructions?.path ?? null,
  });

  const mcpListPayload = async () => {
    let configs: Record<string, unknown> = {};
    let error: string | undefined;
    try {
      const file = await readMcpConfigFile(mcpConfigPath);
      configs = file.raw.mcpServers;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    return {
      path: mcpConfigPath,
      servers: mcp?.servers ?? [],
      configs,
      error,
    };
  };

  const applyMcpServers = async (
    servers: Record<string, McpServerConfig>,
  ): Promise<void> => {
    await mcp?.close();
    mcp =
      Object.keys(servers).length > 0
        ? await McpManager.start(servers, {
            onLog: (line) => {
              if (process.env.OLLAMA_AGENT_MCP_LOG) console.error(line);
            },
          })
        : undefined;
    agent.tools = [...allTools, ...(mcp?.tools ?? [])];
  };

  const here = path.dirname(fileURLToPath(import.meta.url));
  const webDir = path.join(here, "..", "web");
  const staticFiles: Record<string, string> = {
    "/": "index.html",
    "/index.html": "index.html",
    "/app.js": "app.js",
    "/markdown.js": "markdown.js",
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
        json(response, 200, statePayload());
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/settings") {
        json(response, 200, settings);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/settings") {
        const body = await readJson(request);
        const patch: Partial<AppSettings> = {};
        if (body.theme === "system" || body.theme === "light" || body.theme === "dark") {
          patch.theme = body.theme;
        }
        if (typeof body.model === "string") patch.model = body.model;
        if (typeof body.mode === "string") patch.mode = body.mode as PermissionMode;
        if (typeof body.showThinking === "boolean") patch.showThinking = body.showThinking;
        settings = await updateSettings(patch);
        json(response, 200, settings);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/mcp") {
        json(response, 200, await mcpListPayload());
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/mcp/save") {
        if (busy) {
          json(response, 409, { error: "Stop the current turn first." });
          return;
        }
        if (options.noMcp) {
          json(response, 400, { error: "MCP is disabled (--no-mcp)." });
          return;
        }
        const body = await readJson(request);
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (!name) {
          json(response, 400, { error: "Connector name is required." });
          return;
        }
        const file = await saveMcpServer(mcpConfigPath, name, body.config);
        await applyMcpServers(file.servers);
        json(response, 200, await mcpListPayload());
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/mcp/remove") {
        if (busy) {
          json(response, 409, { error: "Stop the current turn first." });
          return;
        }
        if (options.noMcp) {
          json(response, 400, { error: "MCP is disabled (--no-mcp)." });
          return;
        }
        const body = await readJson(request);
        const name = typeof body.name === "string" ? body.name : "";
        if (!name) {
          json(response, 400, { error: "Missing connector name." });
          return;
        }
        const file = await removeMcpServer(mcpConfigPath, name);
        await clearToken(name).catch(() => {});
        await applyMcpServers(file.servers);
        json(response, 200, await mcpListPayload());
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/mcp/reconnect") {
        if (busy) {
          json(response, 409, { error: "Stop the current turn first." });
          return;
        }
        const body = await readJson(request);
        const name = typeof body.name === "string" && body.name ? body.name : undefined;
        await mcp?.reconnect(name);
        json(response, 200, await mcpListPayload());
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/mcp/logout") {
        const body = await readJson(request);
        const name = typeof body.name === "string" ? body.name : "";
        if (!name) {
          json(response, 400, { error: "Missing connector name." });
          return;
        }
        await clearToken(name);
        json(response, 200, await mcpListPayload());
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/update/status") {
        json(response, 200, {
          currentVersion: appVersion,
          packaged: false,
          state: "idle",
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/update/check") {
        json(response, 200, await checkForLatestRelease(appVersion));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/update/install") {
        json(response, 501, {
          error: "Updates are installed by the desktop app.",
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/project/set") {
        if (busy) {
          json(response, 409, { error: "Stop the current turn first." });
          return;
        }
        const body = await readJson(request);
        const raw = typeof body.path === "string" ? body.path : "";
        if (!raw) {
          json(response, 400, { error: "Missing project path." });
          return;
        }
        const directory = await assertDirectory(raw);
        options.cwd = directory;
        agent.cwd = directory;
        projectInstructions = await loadProjectInstructions(directory);
        agent.system = buildSystemPrompt(directory, projectInstructions);

        const next = await Session.create({ cwd: directory, model: agent.model });
        agent.restore(next, []);

        if (!options.noMcp && !options.mcpConfig) {
          try {
            const config = await loadMcpConfig(undefined, directory);
            mcpConfigPath = config.path ?? defaultMcpConfigPath();
            await applyMcpServers(config.servers);
          } catch (error) {
            console.error(
              `MCP config: ${error instanceof Error ? error.message : error}`,
            );
          }
        }

        json(response, 200, { ...statePayload(), title: "New chat" });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/file") {
        const requested = url.searchParams.get("path") ?? "";
        json(response, 200, await readProjectFile(agent.cwd, requested));
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
          agent.session.model = agent.model;
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

      if (request.method === "GET" && url.pathname === "/api/sessions") {
        json(response, 200, {
          sessions: await listSessions(),
          current: agent.session.id,
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/sessions/new") {
        if (agent.messages.length === 0) {
          json(response, 200, { ...statePayload(), title: "New chat" });
          return;
        }
        const next = await Session.create({ cwd: options.cwd, model: agent.model });
        agent.restore(next, []);
        json(response, 200, { ...statePayload(), title: "New chat" });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/sessions/load") {
        const body = await readJson(request);
        const id = typeof body.id === "string" ? body.id : "";
        if (!id) {
          json(response, 400, { error: "Missing session id." });
          return;
        }
        const loaded = await loadSession(id);
        const opened = await Session.open(id);
        agent.restore(opened, loaded.messages);
        if (loaded.model) {
          agent.model = loaded.model;
          agent.session.model = loaded.model;
        }
        json(response, 200, {
          ...statePayload(),
          title: loaded.title,
          messages: loaded.messages,
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/sessions/rename") {
        const body = await readJson(request);
        const id = typeof body.id === "string" ? body.id : "";
        const title = typeof body.title === "string" ? body.title : "";
        if (!id) {
          json(response, 400, { error: "Missing session id." });
          return;
        }
        json(response, 200, { id, title: await renameSession(id, title) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/sessions/delete") {
        const body = await readJson(request);
        const id = typeof body.id === "string" ? body.id : "";
        if (!id) {
          json(response, 400, { error: "Missing session id." });
          return;
        }
        await deleteSession(id);
        if (agent.session.id === id) {
          const next = await Session.create({ cwd: options.cwd, model: agent.model });
          agent.restore(next, []);
        }
        json(response, 200, statePayload());
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/cancel") {
        currentRun?.abort();
        json(response, 200, { ok: true });
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

      if (request.method === "POST" && url.pathname === "/api/approve-plan") {
        const body = await readJson(request);
        const id = typeof body.id === "string" ? body.id : "";
        const resolver = planApprovals.get(id);
        if (!resolver) {
          json(response, 404, { error: "Unknown plan approval id." });
          return;
        }
        planApprovals.delete(id);
        resolver({
          approved: body.approved === true,
          feedback:
            typeof body.feedback === "string"
              ? body.feedback.slice(0, 2000)
              : undefined,
        });
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

        const rawImages = Array.isArray(body.images) ? body.images : [];
        if (rawImages.length > MAX_IMAGES) {
          json(response, 400, { error: `At most ${MAX_IMAGES} images per message.` });
          return;
        }
        let images: ImageAttachment[];
        try {
          images = rawImages.map((value) => validateImageAttachment(value));
        } catch (error) {
          json(response, 400, {
            error: error instanceof Error ? error.message : String(error),
          });
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
        currentRun = controller;
        // response "close" means the client went away; abort the turn.
        response.on("close", () => controller.abort());

        send("start", { model: agent.model, mode: permissions.mode });
        try {
          await agent.run(message, images.length > 0 ? images : undefined);
        } catch (error) {
          send("error", {
            message: error instanceof Error ? error.message : String(error),
          });
        } finally {
          currentRun = null;
          agent.signal = undefined;
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

import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { Agent, type AgentEvent } from "./core/agent.ts";
import {
  agentCatalogPrompt,
  loadAgentDefinitions,
} from "./core/agent-definitions.ts";
import { loadSkills } from "./core/skills.ts";
import { HooksEngine } from "./core/hooks.ts";
import { OllamaProvider } from "./core/ollama.ts";
import {
  PERMISSION_MODES,
  PermissionEngine,
  type AskOutcome,
  type PermissionMode,
} from "./core/permissions.ts";
import { Session } from "./core/session.ts";
import {
  assertDirectory,
  buildSystemPrompt,
  loadProjectInstructions,
} from "./core/project.ts";
import type { ImageAttachment } from "./core/types.ts";
import { loadMcpConfig } from "./mcp/config.ts";
import { McpManager } from "./mcp/manager.ts";
import { allTools } from "./tools/index.ts";

const VERSION = "0.1.5";
const PROTOCOL_VERSION = 1;

interface AcpOptions {
  model?: string;
  host?: string;
  apiKey?: string;
  cwd: string;
  mode: PermissionMode;
  numCtx?: number;
  think: boolean;
  mcpConfig?: string;
  noMcp: boolean;
}

interface AcpSession {
  id: string;
  session: Session;
  agent: Agent;
  permission: PermissionEngine;
  mode: PermissionMode;
  controller?: AbortController;
  pendingPermissions: Set<string>;
  messageId?: string;
  toolCounter: number;
}

type JsonObject = Record<string, unknown>;

function parseArgs(argv: string[]): AcpOptions {
  const options: AcpOptions = {
    cwd: process.cwd(),
    mode: "default",
    think: false,
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
      case "--model":
      case "-m":
        options.model = take(index, arg);
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
      case "--cwd":
        options.cwd = take(index, arg);
        index += 1;
        break;
      case "--mode": {
        const mode = take(index, arg) as PermissionMode;
        if (!PERMISSION_MODES.includes(mode)) {
          throw new Error(`Unknown mode "${mode}".`);
        }
        options.mode = mode;
        index += 1;
        break;
      }
      case "--num-ctx": {
        const value = Number(take(index, arg));
        if (!Number.isFinite(value) || value <= 0) {
          throw new Error("--num-ctx must be positive.");
        }
        options.numCtx = Math.floor(value);
        index += 1;
        break;
      }
      case "--think":
        options.think = true;
        break;
      case "--mcp-config":
        options.mcpConfig = take(index, arg);
        index += 1;
        break;
      case "--no-mcp":
        options.noMcp = true;
        break;
      case "--help":
        process.stderr.write(
          "usage: ollama-agent-acp [--model m] [--cwd dir] [--mode mode] [--host url] [--no-mcp]\n",
        );
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument "${arg}".`);
    }
  }
  return options;
}

class JsonRpcConnection {
  private nextId = 1;
  private pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  onRequest?: (id: string | number, method: string, params: JsonObject) => void;
  onNotification?: (method: string, params: JsonObject) => void;

  send(message: JsonObject): void {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  }

  respond(id: string | number, result: unknown): void {
    this.send({ jsonrpc: "2.0", id, result });
  }

  error(id: string | number, code: number, message: string, data?: unknown): void {
    this.send({
      jsonrpc: "2.0",
      id,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    });
  }

  notify(method: string, params: JsonObject): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  request(
    method: string,
    params: JsonObject,
    onId?: (id: string) => void,
  ): Promise<unknown> {
    const id = `agent-${this.nextId}`;
    this.nextId += 1;
    onId?.(id);
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Client request "${method}" timed out.`));
      }, 300_000);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  cancelPending(id: string, result: unknown): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(result);
  }

  rejectPending(id: string, error: Error): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.reject(error);
  }

  receive(line: string): void {
    if (!line.trim()) return;
    let message: JsonObject;
    try {
      message = JSON.parse(line) as JsonObject;
    } catch {
      return;
    }
    const method = typeof message.method === "string" ? message.method : "";
    if (method && message.id !== undefined && message.id !== null) {
      this.onRequest?.(
        message.id as string | number,
        method,
        (message.params ?? {}) as JsonObject,
      );
      return;
    }
    if (method) {
      this.onNotification?.(method, (message.params ?? {}) as JsonObject);
      return;
    }
    if (message.id !== undefined && message.id !== null) {
      const id = String(message.id);
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      clearTimeout(entry.timer);
      if (message.error) {
        entry.reject(
          new Error(
            typeof (message.error as JsonObject)?.message === "string"
              ? String((message.error as JsonObject).message)
              : "Client request failed.",
          ),
        );
      } else {
        entry.resolve(message.result);
      }
    }
  }

  close(): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Connection closed."));
    }
    this.pending.clear();
  }
}

const TOOL_KINDS: Record<string, string> = {
  Read: "read",
  Glob: "search",
  Grep: "search",
  Write: "edit",
  Edit: "edit",
  MultiEdit: "edit",
  Bash: "execute",
  Task: "other",
  Skill: "other",
};

export function toolKind(name: string): string {
  if (TOOL_KINDS[name]) return TOOL_KINDS[name];
  if (name.startsWith("Team")) return "other";
  if (name.startsWith("mcp__") || name.includes("__")) return "other";
  return "other";
}

export function promptText(
  blocks: unknown[],
): { text: string; images: ImageAttachment[] } {
  const parts: string[] = [];
  const images: ImageAttachment[] = [];
  for (const raw of blocks) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as JsonObject;
    const type = typeof block.type === "string" ? block.type : "";
    if (type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (type === "resource_link") {
      const name = typeof block.name === "string" ? block.name : "resource";
      const uri = typeof block.uri === "string" ? block.uri : "";
      parts.push(`[resource] ${name}${uri ? ` (${uri})` : ""}`);
    } else if (type === "resource") {
      const resource =
        block.resource && typeof block.resource === "object"
          ? (block.resource as JsonObject)
          : block;
      if (typeof resource.text === "string") parts.push(resource.text);
      else {
        const uri = typeof resource.uri === "string" ? resource.uri : "resource";
        parts.push(`[resource] ${uri}`);
      }
    } else if (type === "image") {
      const data = typeof block.data === "string" ? block.data : "";
      const mimeType =
        typeof block.mimeType === "string" ? block.mimeType : "image/png";
      if (data) images.push({ data, mimeType, name: "image" });
    } else if (type === "audio") {
      parts.push("[audio content is not supported]");
    }
  }
  return {
    text: parts.join("\n\n").trim() || (images.length > 0 ? "See the attached image." : ""),
    images,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const cwd = await assertDirectory(options.cwd);
  const provider = new OllamaProvider({
    host: options.host ?? process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434",
    apiKey: options.apiKey ?? process.env.OLLAMA_API_KEY,
  });
  let model = options.model?.trim() ?? "";
  if (!model) {
    const models = await provider.listModels();
    model = models[0]?.name ?? "";
  }
  if (!model) throw new Error("No Ollama model is available.");

  let mcp: McpManager | undefined;
  if (!options.noMcp) {
    try {
      const config = await loadMcpConfig(options.mcpConfig, cwd);
      if (Object.keys(config.servers).length > 0) {
        mcp = await McpManager.start(config.servers, {
          onLog: (line) => process.stderr.write(`[acp] ${line}\n`),
        });
      }
    } catch (error) {
      process.stderr.write(
        `[acp] MCP config: ${error instanceof Error ? error.message : error}\n`,
      );
    }
  }

  const tools = [...allTools, ...(mcp?.tools ?? [])];
  const sessions = new Map<string, AcpSession>();
  const connection = new JsonRpcConnection();

  const sendUpdate = (session: AcpSession, update: JsonObject): void => {
    connection.notify("session/update", { sessionId: session.id, update });
  };

  const cancelSession = (session: AcpSession): void => {
    session.controller?.abort();
    for (const id of session.pendingPermissions) {
      connection.cancelPending(id, { outcome: "cancelled" });
    }
    session.pendingPermissions.clear();
  };

  const askPermission = async (
    session: AcpSession,
    request: {
      tool: string;
      input: Record<string, unknown>;
      summary: string;
    },
  ): Promise<AskOutcome> => {
    const optionIds = [
      ["allow_once", "Allow once", "allow_once"],
      ["allow_always", "Always allow", "allow_always"],
      ["reject_once", "Reject", "reject_once"],
      ["reject_always", "Always reject", "reject_always"],
    ] as const;
    let requestId = "";
    const promise = connection.request(
      "session/request_permission",
      {
        sessionId: session.id,
        toolCall: {
          toolCallId: `perm-${randomUUID().slice(0, 8)}`,
          title: `${request.tool}${request.summary ? `: ${request.summary}` : ""}`,
          kind: toolKind(request.tool),
          status: "pending",
          rawInput: request.input,
        },
        options: optionIds.map(([optionId, name, kind]) => ({
          optionId,
          name,
          kind,
        })),
      },
      (id) => {
        requestId = id;
        session.pendingPermissions.add(id);
      },
    );
    try {
      const result = (await promise) as JsonObject;
      if (result.outcome !== "selected") return "deny";
      const optionId = typeof result.optionId === "string" ? result.optionId : "";
      if (optionId === "allow_always") return "always";
      if (optionId === "allow_once") return "allow";
      return "deny";
    } catch {
      return "deny";
    } finally {
      session.pendingPermissions.delete(requestId);
    }
  };

  const createSession = async (params: JsonObject): Promise<AcpSession> => {
    const requestedCwd =
      typeof params.cwd === "string" ? params.cwd : "";
    if (!requestedCwd || !path.isAbsolute(requestedCwd)) {
      throw new Error("session/new requires an absolute cwd.");
    }
    const sessionCwd = await assertDirectory(requestedCwd);
    const [instructions, sessionDefinitions, sessionSkills, sessionHooks] =
      await Promise.all([
        loadProjectInstructions(sessionCwd),
        loadAgentDefinitions(sessionCwd),
        loadSkills(sessionCwd),
        HooksEngine.load(sessionCwd),
      ]);
    const system = `${buildSystemPrompt(sessionCwd, instructions)}\n\n${agentCatalogPrompt(sessionDefinitions)}`;
    const session = await Session.create({ cwd: sessionCwd, model });
    const acpSession: AcpSession = {
      id: session.id,
      session,
      agent: undefined as unknown as Agent,
      permission: undefined as unknown as PermissionEngine,
      mode: options.mode,
      pendingPermissions: new Set(),
      toolCounter: 0,
    };
    acpSession.permission = new PermissionEngine(acpSession.mode, (request) =>
      askPermission(acpSession, request),
    );
    acpSession.agent = new Agent({
      provider,
      model,
      tools,
      permissions: acpSession.permission,
      session,
      cwd: sessionCwd,
      system,
      think: options.think,
      numCtx: options.numCtx,
      agentDefinitions: sessionDefinitions,
      skills: sessionSkills,
      hooks: sessionHooks,
      onEvent: (event: AgentEvent) => {
        switch (event.type) {
          case "text": {
            if (!acpSession.messageId) acpSession.messageId = `msg-${randomUUID()}`;
            sendUpdate(acpSession, {
              sessionUpdate: "agent_message_chunk",
              messageId: acpSession.messageId,
              content: { type: "text", text: event.text },
            });
            break;
          }
          case "thinking": {
            if (!acpSession.messageId) acpSession.messageId = `msg-${randomUUID()}`;
            sendUpdate(acpSession, {
              sessionUpdate: "agent_thought_chunk",
              messageId: acpSession.messageId,
              content: { type: "text", text: event.text },
            });
            break;
          }
          case "tool_start": {
            acpSession.messageId = undefined;
            acpSession.toolCounter += 1;
            const toolCallId =
              event.id ?? `tool-${acpSession.toolCounter}-${randomUUID().slice(0, 4)}`;
            sendUpdate(acpSession, {
              sessionUpdate: "tool_call",
              toolCallId,
              title: `${event.name}${event.summary ? `: ${event.summary}` : ""}`,
              kind: toolKind(event.name),
              status: "in_progress",
              rawInput: event.input,
            });
            break;
          }
          case "tool_end": {
            sendUpdate(acpSession, {
              sessionUpdate: "tool_call_update",
              toolCallId:
                event.id ??
                `tool-${acpSession.toolCounter}-${randomUUID().slice(0, 4)}`,
              status: event.isError ? "failed" : "completed",
              content: [
                {
                  type: "content",
                  content: {
                    type: "text",
                    text: event.content.slice(0, 8_000),
                  },
                },
              ],
            });
            break;
          }
          case "error": {
            acpSession.messageId = `msg-${randomUUID()}`;
            sendUpdate(acpSession, {
              sessionUpdate: "agent_message_chunk",
              messageId: acpSession.messageId,
              content: { type: "text", text: `\n[error] ${event.message}` },
            });
            break;
          }
          default:
            break;
        }
      },
    });
    sessions.set(acpSession.id, acpSession);
    return acpSession;
  };

  connection.onNotification = (method, params) => {
    if (method === "session/cancel") {
      const id = typeof params.sessionId === "string" ? params.sessionId : "";
      const session = sessions.get(id);
      if (session) cancelSession(session);
      return;
    }
    if (method === "$/cancel_request") {
      const id = params.requestId;
      if (typeof id === "string" || typeof id === "number") {
        connection.cancelPending(String(id), { outcome: "cancelled" });
      }
    }
  };

  connection.onRequest = (id, method, params) => {
    void (async () => {
      try {
        switch (method) {
          case "initialize": {
            const requested =
              typeof params.protocolVersion === "number"
                ? params.protocolVersion
                : PROTOCOL_VERSION;
            connection.respond(id, {
              protocolVersion:
                requested === PROTOCOL_VERSION ? requested : PROTOCOL_VERSION,
              agentCapabilities: {
                loadSession: false,
                promptCapabilities: {
                  image: true,
                  audio: false,
                  embeddedContext: true,
                },
                mcpCapabilities: { http: false, sse: false },
                sessionCapabilities: { close: true },
              },
              authMethods: [],
              agentInfo: {
                name: "ollama-agent",
                title: "Ollama Agent",
                version: VERSION,
              },
            });
            return;
          }
          case "authenticate":
          case "logout": {
            connection.respond(id, {});
            return;
          }
          case "session/new": {
            const session = await createSession(params);
            const modes = PERMISSION_MODES.map((mode) => ({
              id: mode,
              name: mode,
              description:
                mode === "default"
                  ? "Ask before mutating tools"
                  : mode === "acceptEdits"
                    ? "Allow file edits; ask for commands"
                    : mode === "plan"
                      ? "Read-only planning"
                      : "Allow every tool",
            }));
            connection.respond(id, {
              sessionId: session.id,
              modes: {
                currentModeId: session.mode,
                availableModes: modes,
              },
            });
            return;
          }
          case "session/prompt": {
            const sessionId =
              typeof params.sessionId === "string" ? params.sessionId : "";
            const session = sessions.get(sessionId);
            if (!session) throw new Error(`Unknown session "${sessionId}".`);
            if (session.controller) {
              throw new Error("A prompt is already running for this session.");
            }
            if (!Array.isArray(params.prompt)) {
              throw new Error("session/prompt requires a prompt array.");
            }
            const prompt = promptText(params.prompt);
            if (!prompt.text && prompt.images.length === 0) {
              throw new Error("The prompt is empty.");
            }
            const controller = new AbortController();
            session.controller = controller;
            session.agent.signal = controller.signal;
            try {
              await session.agent.run(
                prompt.text,
                prompt.images.length > 0 ? prompt.images : undefined,
              );
              connection.respond(id, {
                stopReason: controller.signal.aborted ? "cancelled" : "end_turn",
              });
            } catch (error) {
              if (controller.signal.aborted) {
                connection.respond(id, { stopReason: "cancelled" });
              } else {
                connection.error(
                  id,
                  -32603,
                  error instanceof Error ? error.message : String(error),
                );
              }
            } finally {
              session.controller = undefined;
              session.agent.signal = undefined;
              session.messageId = undefined;
            }
            return;
          }
          case "session/set_mode": {
            const sessionId =
              typeof params.sessionId === "string" ? params.sessionId : "";
            const session = sessions.get(sessionId);
            if (!session) throw new Error(`Unknown session "${sessionId}".`);
            const modeId =
              typeof params.modeId === "string" ? params.modeId : "";
            if (!PERMISSION_MODES.includes(modeId as PermissionMode)) {
              throw new Error(`Unknown mode "${modeId}".`);
            }
            session.mode = modeId as PermissionMode;
            session.permission.setMode(session.mode);
            sendUpdate(session, {
              sessionUpdate: "current_mode_update",
              currentModeId: session.mode,
            });
            connection.respond(id, {});
            return;
          }
          case "session/close": {
            const sessionId =
              typeof params.sessionId === "string" ? params.sessionId : "";
            const session = sessions.get(sessionId);
            if (!session) throw new Error(`Unknown session "${sessionId}".`);
            cancelSession(session);
            await session.agent.close();
            sessions.delete(sessionId);
            connection.respond(id, {});
            return;
          }
          default:
            connection.error(id, -32601, `Method not found: ${method}`);
        }
      } catch (error) {
        connection.error(
          id,
          -32603,
          error instanceof Error ? error.message : String(error),
        );
      }
    })();
  };

  process.stderr.write(
    `[acp] ollama-agent ${VERSION} · ${model} · ${cwd}\n`,
  );

  const reader = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
  reader.on("line", (line) => connection.receive(line));
  reader.on("close", () => {
    for (const session of sessions.values()) {
      cancelSession(session);
    }
    connection.close();
    void mcp?.close();
    process.exit(0);
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    process.stderr.write(
      `[acp] ${error instanceof Error ? error.stack ?? error.message : error}\n`,
    );
    process.exit(1);
  });
}

import { app, BrowserWindow, Menu, dialog, ipcMain, session as electronSession } from "electron";
import { autoUpdater } from "electron-updater";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { Agent, type AgentEvent } from "../src/core/agent.ts";
import { MAX_IMAGES, validateImageAttachment } from "../src/core/images.ts";
import type { FileAttachment, ImageAttachment } from "../src/core/types.ts";
import { OllamaProvider } from "../src/core/ollama.ts";
import {
  PERMISSION_MODES,
  PermissionEngine,
  type AskOutcome,
  type PermissionMode,
} from "../src/core/permissions.ts";
import { Session } from "../src/core/session.ts";
import {
  deleteSession,
  listSessions,
  loadSession,
  renameSession,
} from "../src/core/sessions.ts";
import {
  loadSettings,
  updateSettings,
  type AppSettings,
  type SettingsPatch,
} from "../src/core/settings.ts";
import { importTweakcnTheme } from "../src/core/theme.ts";
import { purgeAllSessions, purgeSession } from "../src/core/purge.ts";
import { readProjectFile } from "../src/core/files.ts";
import {
  MAX_ATTACHMENTS,
  attachmentMimeTypeForPath,
  validateFileAttachment,
} from "../src/core/files.ts";
import {
  assertDirectory,
  loadProjectInstructions,
  type ProjectInstructions,
} from "../src/core/project.ts";
import { buildSystemPrompt } from "../src/core/prompt.ts";
import { checkForLatestRelease } from "../src/core/updates.ts";
import {
  agentCatalogPrompt,
  loadAgentDefinitions,
  summarizeAgentDefinitions,
  type AgentDefinition,
} from "../src/core/agent-definitions.ts";
import {
  loadSkills,
  summarizeSkills,
  type SkillDefinition,
} from "../src/core/skills.ts";
import { HooksEngine } from "../src/core/hooks.ts";
import { BackgroundManager } from "../src/core/background.ts";
import { createBackgroundAgent } from "../src/core/background-agent.ts";
import { loadMcpConfig, type McpServerConfig } from "../src/mcp/config.ts";
import {
  defaultMcpConfigPath,
  readMcpConfigFile,
  removeMcpServer,
  saveMcpServer,
} from "../src/mcp/config-editor.ts";
import { McpManager } from "../src/mcp/manager.ts";
import { clearToken } from "../src/mcp/oauth.ts";
import { allTools } from "../src/tools/index.ts";

interface Options {
  host?: string;
  apiKey?: string;
  model?: string;
  cwd: string;
  mode: PermissionMode;
  modeProvided: boolean;
  mcpConfig?: string;
  noMcp: boolean;
  devtools: boolean;
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    cwd: process.cwd(),
    mode: "default",
    modeProvided: false,
    noMcp: false,
    devtools: Boolean(process.env.AGENT_DEVTOOLS),
  };
  const take = (index: number): string => argv[index + 1] ?? "";
  for (let index = 0; index < argv.length; index += 1) {
    switch (argv[index]) {
      case "--host":
        options.host = take(index);
        index += 1;
        break;
      case "--api-key":
        options.apiKey = take(index);
        index += 1;
        break;
      case "--model":
      case "-m":
        options.model = take(index);
        index += 1;
        break;
      case "--cwd":
        options.cwd = path.resolve(take(index));
        index += 1;
        break;
      case "--mode": {
        const value = take(index) as PermissionMode;
        if (PERMISSION_MODES.includes(value)) {
          options.mode = value;
          options.modeProvided = true;
        }
        index += 1;
        break;
      }
      case "--mcp-config":
        options.mcpConfig = take(index);
        index += 1;
        break;
      case "--no-mcp":
        options.noMcp = true;
        break;
      case "--devtools":
        options.devtools = true;
        break;
    }
  }
  return options;
}

const options = parseOptions(process.argv.slice(1));

let mainWindow: BrowserWindow | null = null;
let provider: OllamaProvider;
let agent: Agent;
let permissions: PermissionEngine;
let session: Session;
let settings: AppSettings;
let mcpConfigPath: string;
let projectInstructions: ProjectInstructions | undefined;
let agentDefinitions: Map<string, AgentDefinition> = new Map();
let skills: Map<string, SkillDefinition> = new Map();
let hooks = new HooksEngine();
let mcp: McpManager | undefined;
let background: BackgroundManager;

type UpdaterStateName =
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "error";

interface UpdaterState {
  state: UpdaterStateName;
  version?: string;
  percent?: number;
  error?: string;
}

let updaterState: UpdaterState = { state: "idle" };

function publishUpdaterState(next: UpdaterState): void {
  updaterState = next;
  sendEvent("update_status", {
    ...next,
    currentVersion: app.getVersion(),
    packaged: app.isPackaged,
  });
}
let busy = false;
let currentRun: AbortController | null = null;
const approvals = new Map<string, (outcome: AskOutcome) => void>();
const planApprovals = new Map<
  string,
  (result: { approved: boolean; feedback?: string }) => void
>();

function sendEvent(event: string, data: unknown): void {
  mainWindow?.webContents.send("agent:event", { event, data });
}

/** IPC payloads are untrusted input even though the renderer is local. */
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const ask = async (request: {
  tool: string;
  input: Record<string, unknown>;
  summary: string;
}): Promise<AskOutcome> => {
  if (!mainWindow) return "deny";
  const id = randomUUID();
  return new Promise<AskOutcome>((resolve) => {
    approvals.set(id, resolve);
    const timer = setTimeout(() => {
      if (approvals.delete(id)) resolve("deny");
    }, 120_000);
    timer.unref?.();
    sendEvent("approval", {
      id,
      tool: request.tool,
      summary: request.summary,
      input: request.input,
    });
  }).finally(() => approvals.delete(id));
};

const planApprover = async (
  plan: string,
): Promise<{ approved: boolean; feedback?: string }> => {
  if (!mainWindow) return { approved: false, feedback: "No window." };
  const id = randomUUID();
  return new Promise<{ approved: boolean; feedback?: string }>((resolve) => {
    planApprovals.set(id, resolve);
    const timer = setTimeout(() => {
      if (planApprovals.delete(id)) {
        resolve({ approved: false, feedback: "Plan approval timed out." });
      }
    }, 300_000);
    timer.unref?.();
    sendEvent("plan_approval", { id, plan });
  }).finally(() => planApprovals.delete(id));
};

function statePayload() {
  return {
    model: agent.model,
    contextWindow: agent.contextWindow,
    contextBudget: agent.contextUsage().budget,
    mode: permissions.mode,
    cwd: options.cwd,
    session: agent.session.file,
    mcp: mcp?.servers ?? [],
    resources: mcp?.resources ?? [],
    prompts: mcp?.prompts ?? [],
    settings: {
      theme: settings.theme,
      customTheme: settings.customTheme,
      showThinking: settings.showThinking,
      model: settings.model,
      mode: settings.mode,
    },
    mcpPath: mcpConfigPath,
    version: app.getVersion(),
    projectInstructions: projectInstructions?.path ?? null,
  };
}

async function mcpListPayload() {
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
}

async function applyMcpServers(
  servers: Record<string, McpServerConfig>,
): Promise<void> {
  await mcp?.close();
  mcp =
    Object.keys(servers).length > 0
      ? await McpManager.start(servers, {
          onLog: (line) => {
            if (process.env.OLLAMA_AGENT_MCP_LOG) console.error(line);
          },
        })
      : undefined;
  agent.setTools([...allTools, ...(mcp?.tools ?? [])]);
}

function forwardAgentEvent(event: AgentEvent): void {
  switch (event.type) {
    case "text":
      sendEvent("text", { text: event.text });
      break;
    case "thinking":
      sendEvent("thinking", { text: event.text });
      break;
    case "tool_start":
      sendEvent("tool_start", {
        name: event.name,
        summary: event.summary,
        input: event.input,
        id: event.id,
      });
      break;
    case "tool_end":
      sendEvent("tool_end", {
        name: event.name,
        content: event.content,
        isError: event.isError,
        id: event.id,
      });
      break;
    case "notice":
      sendEvent("notice", { text: event.text });
      break;
    case "session_title":
      sendEvent("session_title", { title: event.title });
      break;
    case "team_event":
      sendEvent("team_event", { event: event.event });
      break;
    case "subagent_start":
      sendEvent("subagent_start", {
        name: event.name,
        description: event.description,
        subagentType: event.subagentType,
        model: event.model,
      });
      break;
    case "subagent_end":
      sendEvent("subagent_end", {
        name: event.name,
        description: event.description,
        subagentType: event.subagentType,
        ok: event.ok,
        messages: event.messages,
      });
      break;
    case "error":
      sendEvent("error", { message: event.message });
      break;
    case "usage":
      break;
    case "turn_end":
      sendEvent("step", {});
      break;
  }
}

async function initCore(): Promise<void> {
  settings = await loadSettings();
  projectInstructions = await loadProjectInstructions(options.cwd);
  provider = new OllamaProvider({
    host: options.host ?? process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434",
    apiKey: options.apiKey ?? process.env.OLLAMA_API_KEY,
  });

  let models: Awaited<ReturnType<OllamaProvider["listModels"]>> = [];
  try {
    models = await provider.listModels();
  } catch (error) {
    console.error(`[electron] Ollama unavailable: ${error instanceof Error ? error.message : error}`);
  }
  const model =
    options.model ?? process.env.OLLAMA_MODEL ?? settings.model ?? models[0]?.name ?? "";

  session = await Session.create({ cwd: options.cwd, model });

  mcpConfigPath = defaultMcpConfigPath();
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
      console.error(
        `[electron] MCP config: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  permissions = new PermissionEngine(
    options.modeProvided ? options.mode : settings.mode,
    ask,
  );
  agentDefinitions = await loadAgentDefinitions(options.cwd);
  skills = await loadSkills(options.cwd);
  hooks = await HooksEngine.load(options.cwd);
  agent = new Agent({
    provider,
    model,
    tools: [...allTools, ...(mcp?.tools ?? [])],
    permissions,
    session,
    cwd: options.cwd,
    system: buildSystemPrompt({
      cwd: options.cwd,
      toolNames: [...allTools, ...(mcp?.tools ?? [])].map((tool) => tool.name),
      mode: permissions.mode,
      instructions: projectInstructions,
      subagents: [...agentDefinitions.keys()],
      extra: [agentCatalogPrompt(agentDefinitions)],
    }),
    planApprover,
    agentDefinitions,
    skills,
    hooks,
    onEvent: forwardAgentEvent,
  });

  await agent.refreshContextWindow();

  background = await BackgroundManager.load({
    createAgent: async ({ cwd, model: jobModel, mode }) => {
      const [instructions, jobDefinitions, jobSkills, jobHooks] =
        await Promise.all([
          loadProjectInstructions(cwd),
          loadAgentDefinitions(cwd),
          loadSkills(cwd),
          HooksEngine.load(cwd),
        ]);
      return createBackgroundAgent({
        provider,
        tools: [...allTools, ...(mcp?.tools ?? [])],
        system: buildSystemPrompt({
          cwd,
          toolNames: [...allTools, ...(mcp?.tools ?? [])].map((tool) => tool.name),
          mode,
          instructions,
          subagents: [...jobDefinitions.keys()],
          extra: [agentCatalogPrompt(jobDefinitions)],
        }),
        cwd,
        model: jobModel,
        mode,
        agentDefinitions: jobDefinitions,
        skills: jobSkills,
        hooks: jobHooks,
      });
    },
    onEvent: (event) => {
      mainWindow?.webContents.send("agent:event", {
        type: "background_event",
        event,
      });
    },
  });
}

function registerIpc(): void {
  ipcMain.handle("agent:state", () => statePayload());

  ipcMain.handle("agent:models", async () => ({
    models: await provider.listModels(),
    current: agent.model,
  }));

  ipcMain.handle("agents:list", () => ({
    agents: summarizeAgentDefinitions(agentDefinitions),
    skills: summarizeSkills(skills),
  }));

  ipcMain.handle("telemetry:get", async () => ({
    summary: agent.telemetry ? await agent.telemetry.summary() : null,
    runs: agent.telemetry ? await agent.telemetry.list(20) : [],
  }));

  ipcMain.handle("background:state", async () => ({
    state: await background.stateSnapshot(),
  }));

  ipcMain.handle("background:dispatch", async (_event, payload: unknown) => {
    const body = asRecord(payload);
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) throw new Error("Missing background prompt.");
    const cwd =
      typeof body.cwd === "string" && body.cwd
        ? await assertDirectory(body.cwd)
        : options.cwd;
    const mode =
      typeof body.mode === "string" &&
      PERMISSION_MODES.includes(body.mode as PermissionMode)
        ? (body.mode as PermissionMode)
        : permissions.mode;
    const job = await background.dispatch({
      prompt,
      cwd,
      model:
        typeof body.model === "string" && body.model.trim()
          ? body.model.trim()
          : agent.model,
      mode,
      title: typeof body.title === "string" ? body.title : undefined,
    });
    return { job, state: await background.stateSnapshot() };
  });

  ipcMain.handle("background:cancel", async (_event, payload: unknown) => {
    const id = asRecord(payload).id;
    if (typeof id !== "string" || !id) throw new Error("Missing job id.");
    await background.cancel(id);
    return { state: await background.stateSnapshot() };
  });

  ipcMain.handle("background:transcript", async (_event, payload: unknown) => {
    const id = asRecord(payload).id;
    return {
      messages: await background.transcript(typeof id === "string" ? id : ""),
    };
  });

  ipcMain.handle("background:schedule:add", async (_event, payload: unknown) => {
    const body = asRecord(payload);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const cron = typeof body.cron === "string" ? body.cron.trim() : "";
    if (!name || !prompt || !cron) {
      throw new Error("Schedule needs name, prompt, and cron.");
    }
    const cwd =
      typeof body.cwd === "string" && body.cwd
        ? await assertDirectory(body.cwd)
        : options.cwd;
    const mode =
      typeof body.mode === "string" &&
      PERMISSION_MODES.includes(body.mode as PermissionMode)
        ? (body.mode as PermissionMode)
        : permissions.mode;
    const schedule = await background.addSchedule({
      name,
      prompt,
      cron,
      cwd,
      model:
        typeof body.model === "string" && body.model.trim()
          ? body.model.trim()
          : agent.model,
      mode,
      enabled: body.enabled !== false,
    });
    return { schedule, state: await background.stateSnapshot() };
  });

  ipcMain.handle("background:schedule:remove", async (_event, payload: unknown) => {
    const id = asRecord(payload).id;
    if (typeof id !== "string" || !id) throw new Error("Missing schedule id.");
    await background.removeSchedule(id);
    return { state: await background.stateSnapshot() };
  });

  ipcMain.handle("checkpoints:list", async () => ({
    checkpoints: agent.checkpoints ? await agent.checkpoints.list(50) : [],
  }));

  ipcMain.handle("checkpoints:restore", async (_event, payload: unknown) => {
    if (!agent.checkpoints) throw new Error("Checkpoints are disabled.");
    const id = asRecord(payload).id;
    if (typeof id !== "string" || !id) throw new Error("Missing checkpoint id.");
    const report = await agent.checkpoints.restore(id);
    return { report, checkpoints: await agent.checkpoints.list(50) };
  });

  ipcMain.handle("team:status", async () => ({
    team: (await agent.team?.snapshot()) ?? null,
  }));

  ipcMain.handle("team:message", async (_event, payload: unknown) => {
    if (!agent.team) throw new Error("Team mode is not enabled.");
    const body = asRecord(payload);
    const to = typeof body.to === "string" ? body.to : "";
    const text = typeof body.text === "string" ? body.text : "";
    if (!to || !text.trim()) throw new Error("Missing recipient or message.");
    await agent.team.sendMessage("user", to, text);
    return { team: await agent.team.snapshot() };
  });

  ipcMain.handle("team:stop", async (_event, payload: unknown) => {
    if (!agent.team) throw new Error("Team mode is not enabled.");
    const name = asRecord(payload).name;
    if (typeof name !== "string" || !name) throw new Error("Missing teammate name.");
    await agent.team.shutdown("lead", name);
    return { team: await agent.team.snapshot() };
  });

  ipcMain.handle("team:transcript", async (_event, payload: unknown) => {
    if (!agent.team) return { messages: [] };
    const name = asRecord(payload).name;
    return { messages: await agent.team.transcript(typeof name === "string" ? name : "") };
  });

  ipcMain.handle("team:review", async (_event, payload: unknown) => {
    if (!agent.team) throw new Error("Team mode is not enabled.");
    const record = asRecord(payload);
    const name = typeof record.name === "string" ? record.name : "";
    if (!name) throw new Error("Missing teammate name.");
    return {
      report: await agent.team.review("lead", name, { diff: record.diff === true }),
    };
  });

  ipcMain.handle(
    "agent:set-state",
    async (_event, payload: unknown) => {
      const patch = asRecord(payload);
      if (typeof patch.model === "string" && patch.model.trim()) {
        agent.model = patch.model.trim();
        agent.session.model = agent.model;
        await agent.refreshContextWindow();
      }
      if (typeof patch.mode === "string") {
        if (!PERMISSION_MODES.includes(patch.mode as PermissionMode)) {
          throw new Error("Unknown mode.");
        }
        permissions.setMode(patch.mode as PermissionMode);
      }
      return {
        model: agent.model,
        contextWindow: agent.contextWindow,
        contextBudget: agent.contextUsage().budget,
        mode: permissions.mode,
      };
    },
  );

  ipcMain.handle("agent:approve-plan", (_event, payload: unknown) => {
    const body = asRecord(payload);
    const id = typeof body.id === "string" ? body.id : "";
    const resolver = planApprovals.get(id);
    if (!resolver) throw new Error("Unknown plan approval id.");
    planApprovals.delete(id);
    resolver({
      approved: body.approved === true,
      feedback:
        typeof body.feedback === "string"
          ? body.feedback.slice(0, 2000)
          : undefined,
    });
    return { ok: true };
  });

  ipcMain.handle("agent:approve", (_event, payload: unknown) => {
    const body = asRecord(payload);
    const id = typeof body.id === "string" ? body.id : "";
    const resolver = approvals.get(id);
    if (!resolver) throw new Error("Unknown approval id.");
    approvals.delete(id);
    const decision = body.decision;
    resolver(
      decision === "allow" || decision === "always" || decision === "deny"
        ? decision
        : "deny",
    );
    return { ok: true };
  });

  ipcMain.handle("agent:reset", () => {
    agent.reset();
    return { ok: true };
  });

  ipcMain.handle("agent:chat", async (_event, payload: unknown) => {
    if (busy) throw new Error("A turn is already running.");
    const body = asRecord(payload);
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) throw new Error("Missing message.");
    if (message.length > 200_000) throw new Error("Message is too long.");

    const rawImages = Array.isArray(body.images) ? body.images : [];
    if (rawImages.length > MAX_IMAGES) {
      throw new Error(`At most ${MAX_IMAGES} images per message.`);
    }
    let images: ImageAttachment[];
    try {
      images = rawImages.map((value) => validateImageAttachment(value));
    } catch (error) {
      throw new Error(
        `Invalid image: ${error instanceof Error ? error.message : error}`,
      );
    }

    const rawFiles = Array.isArray(body.files) ? body.files : [];
    if (rawFiles.length > MAX_ATTACHMENTS) {
      throw new Error(`At most ${MAX_ATTACHMENTS} files per message.`);
    }
    let files: FileAttachment[];
    try {
      files = await Promise.all(rawFiles.map((value) => validateFileAttachment(value)));
    } catch (error) {
      throw new Error(
        `Invalid attachment: ${error instanceof Error ? error.message : error}`,
      );
    }

    busy = true;
    const controller = new AbortController();
    agent.signal = controller.signal;
    currentRun = controller;
    let finalContext: { used: number; budget: number } | undefined;
    sendEvent("start", { model: agent.model, mode: permissions.mode });
    try {
      await agent.run(
        message,
        images.length > 0 ? images : undefined,
        files.length > 0 ? files : undefined,
      );
    } finally {
      currentRun = null;
      agent.signal = undefined;
      finalContext = agent.contextUsage();
      sendEvent("done", finalContext);
      busy = false;
    }
    return { ok: true, context: finalContext };
  });

  ipcMain.handle("agent:cancel", () => {
    currentRun?.abort();
    return { ok: true };
  });

  ipcMain.handle("sessions:list", async () => ({
    sessions: await listSessions(),
    current: agent.session.id,
  }));

  ipcMain.handle("sessions:new", async () => {
    if (agent.messages.length === 0) {
      return { ...statePayload(), title: "New chat" };
    }
    const next = await Session.create({ cwd: options.cwd, model: agent.model });
    agent.restore(next, []);
    return { ...statePayload(), title: "New chat" };
  });

  ipcMain.handle("sessions:load", async (_event, payload: unknown) => {
    const id = asRecord(payload).id;
    if (typeof id !== "string" || !id) throw new Error("Missing session id.");
    const loaded = await loadSession(id);
    const opened = await Session.open(id);
    agent.restore(opened, loaded.messages);
    if (loaded.model) {
      agent.model = loaded.model;
      agent.session.model = loaded.model;
      await agent.refreshContextWindow();
    }
    return { ...statePayload(), title: loaded.title, messages: loaded.messages };
  });

  ipcMain.handle("sessions:rename", async (_event, payload: unknown) => {
    const body = asRecord(payload);
    const id = typeof body.id === "string" ? body.id : "";
    const title = typeof body.title === "string" ? body.title : "";
    if (!id) throw new Error("Missing session id.");
    const cleaned = await renameSession(id, title);
    return { id, title: cleaned };
  });

  ipcMain.handle("sessions:delete", async (_event, payload: unknown) => {
    const id = asRecord(payload).id;
    if (typeof id !== "string" || !id) throw new Error("Missing session id.");
    await deleteSession(id);
    if (agent.session.id === id) {
      const next = await Session.create({ cwd: options.cwd, model: agent.model });
      agent.restore(next, []);
    }
    return statePayload();
  });

  ipcMain.handle("sessions:purge", async (_event, payload: unknown) => {
    if (busy) throw new Error("Stop the current turn before purging sessions.");
    const body = asRecord(payload);
    const id = typeof body.id === "string" ? body.id : "";
    if (!id) throw new Error("Missing session id.");
    await background.purgeSessions([id]);
    const result = await purgeSession(id, {
      deleteFiles: body.deleteFiles === true,
    });
    if (agent.session.id === id) {
      const next = await Session.create({ cwd: options.cwd, model: agent.model });
      agent.restore(next, []);
    }
    return { ...statePayload(), purge: result };
  });

  ipcMain.handle("sessions:purge-all", async (_event, payload: unknown) => {
    if (busy) throw new Error("Stop the current turn before purging sessions.");
    const body = asRecord(payload);
    await background.purgeSessions("all");
    const result = await purgeAllSessions({
      deleteFiles: body.deleteFiles === true,
    });
    const next = await Session.create({ cwd: options.cwd, model: agent.model });
    agent.restore(next, []);
    return { ...statePayload(), purge: result };
  });

  ipcMain.handle("settings:get", () => settings);

  ipcMain.handle("settings:update", async (_event, payload: unknown) => {
    const body = asRecord(payload);
    const patch: SettingsPatch = {};
    if (
      body.theme === "system" ||
      body.theme === "light" ||
      body.theme === "dark" ||
      body.theme === "custom"
    ) {
      patch.theme = body.theme;
    }
    if (body.customTheme === null) patch.customTheme = null;
    else if (body.customTheme && typeof body.customTheme === "object") {
      patch.customTheme = body.customTheme as AppSettings["customTheme"];
    }
    if (typeof body.model === "string") patch.model = body.model;
    if (typeof body.mode === "string") patch.mode = body.mode as PermissionMode;
    if (typeof body.showThinking === "boolean") patch.showThinking = body.showThinking;
    settings = await updateSettings(patch);
    return settings;
  });

  ipcMain.handle("theme:import", async (_event, payload: unknown) => {
    const body = asRecord(payload);
    const theme = await importTweakcnTheme({
      url: typeof body.url === "string" ? body.url : undefined,
      css: typeof body.css === "string" ? body.css : undefined,
    });
    settings = await updateSettings({ theme: "custom", customTheme: theme });
    return settings;
  });

  ipcMain.handle("mcp:list", () => mcpListPayload());

  ipcMain.handle("mcp:save", async (_event, payload: unknown) => {
    if (busy) throw new Error("Stop the current turn before changing connectors.");
    if (options.noMcp) throw new Error("MCP is disabled (--no-mcp).");
    const body = asRecord(payload);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) throw new Error("Connector name is required.");
    const file = await saveMcpServer(mcpConfigPath, name, body.config);
    await applyMcpServers(file.servers);
    return mcpListPayload();
  });

  ipcMain.handle("mcp:remove", async (_event, payload: unknown) => {
    if (busy) throw new Error("Stop the current turn before changing connectors.");
    if (options.noMcp) throw new Error("MCP is disabled (--no-mcp).");
    const name = asRecord(payload).name;
    if (typeof name !== "string" || !name) throw new Error("Missing connector name.");
    const file = await removeMcpServer(mcpConfigPath, name);
    await clearToken(name).catch(() => {});
    await applyMcpServers(file.servers);
    return mcpListPayload();
  });

  ipcMain.handle("mcp:reconnect", async (_event, payload: unknown) => {
    if (busy) throw new Error("Stop the current turn before reconnecting.");
    if (!mcp) return mcpListPayload();
    const name = asRecord(payload).name;
    await mcp.reconnect(typeof name === "string" && name ? name : undefined);
    return mcpListPayload();
  });

  ipcMain.handle("mcp:logout", async (_event, payload: unknown) => {
    const name = asRecord(payload).name;
    if (typeof name !== "string" || !name) throw new Error("Missing connector name.");
    await clearToken(name);
    return mcpListPayload();
  });

  ipcMain.handle("update:status", () => ({
    currentVersion: app.getVersion(),
    packaged: app.isPackaged,
    ...updaterState,
  }));

  ipcMain.handle("update:check", async () => {
    const info = await checkForLatestRelease(app.getVersion());
    if (app.isPackaged) {
      publishUpdaterState({ state: "checking" });
      try {
        await autoUpdater.checkForUpdates();
      } catch (error) {
        publishUpdaterState({
          state: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      ...info,
      currentVersion: app.getVersion(),
      packaged: app.isPackaged,
      updater: updaterState,
    };
  });

  ipcMain.handle("update:install", () => {
    if (updaterState.state !== "downloaded") {
      throw new Error("No downloaded update is ready to install.");
    }
    setImmediate(() => autoUpdater.quitAndInstall());
    return { ok: true };
  });

  ipcMain.handle("project:pick", async () => {
    if (!mainWindow) return undefined;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? undefined : result.filePaths[0];
  });

  ipcMain.handle("project:set", async (_event, payload: unknown) => {
    if (busy) throw new Error("Stop the current turn before switching projects.");
    const raw = asRecord(payload).path;
    if (typeof raw !== "string" || !raw) throw new Error("Missing project path.");
    const directory = await assertDirectory(raw);

    options.cwd = directory;
    agent.cwd = directory;
    projectInstructions = await loadProjectInstructions(directory);
    agentDefinitions = await loadAgentDefinitions(directory);
    skills = await loadSkills(directory);
    hooks = await HooksEngine.load(directory);
    agent.agentDefinitions = agentDefinitions;
    agent.skills = skills;
    agent.hooks = hooks;
    agent.setSystem(
      buildSystemPrompt({
        cwd: directory,
        toolNames: agent.tools.map((tool) => tool.name),
        mode: agent.permissions.mode,
        instructions: projectInstructions,
        subagents: [...agentDefinitions.keys()],
        extra: [agentCatalogPrompt(agentDefinitions)],
      }),
      skills,
    );

    const next = await Session.create({ cwd: directory, model: agent.model });
    agent.restore(next, []);

    if (!options.noMcp && !options.mcpConfig) {
      try {
        const config = await loadMcpConfig(undefined, directory);
        mcpConfigPath = config.path ?? defaultMcpConfigPath();
        await applyMcpServers(config.servers);
      } catch (error) {
        console.error(
          `[electron] MCP config: ${error instanceof Error ? error.message : error}`,
        );
      }
    }

    return { ...statePayload(), title: "New chat" };
  });

  ipcMain.handle("file:read", async (_event, payload: unknown) => {
    const pathValue = asRecord(payload).path;
    if (typeof pathValue !== "string" || !pathValue) {
      throw new Error("Missing file path.");
    }
    return readProjectFile(agent.cwd, pathValue);
  });
}

interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized?: boolean;
}

function windowStatePath(): string {
  return path.join(app.getPath("userData"), "window-state.json");
}

async function loadWindowState(): Promise<WindowState> {
  try {
    const raw = JSON.parse(
      await readFile(windowStatePath(), "utf8"),
    ) as Record<string, unknown>;
    const width = Number(raw.width);
    const height = Number(raw.height);
    return {
      width: Number.isFinite(width) && width >= 760 ? width : 1180,
      height: Number.isFinite(height) && height >= 520 ? height : 800,
      x: Number.isFinite(raw.x) ? Number(raw.x) : undefined,
      y: Number.isFinite(raw.y) ? Number(raw.y) : undefined,
      maximized: raw.maximized === true,
    };
  } catch {
    return { width: 1180, height: 800 };
  }
}

async function saveWindowState(win: BrowserWindow): Promise<void> {
  try {
    const maximized = win.isMaximized();
    const bounds = maximized ? win.getNormalBounds() : win.getBounds();
    await mkdir(path.dirname(windowStatePath()), { recursive: true });
    await writeFile(
      windowStatePath(),
      JSON.stringify({ ...bounds, maximized }),
      "utf8",
    );
  } catch {
    // Never block shutdown on state persistence.
  }
}

function setupUpdater(): void {
  // Only packaged builds have app-update.yml (generated by electron-builder).
  if (!app.isPackaged) {
    publishUpdaterState({ state: "idle" });
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("checking-for-update", () => {
    publishUpdaterState({ state: "checking" });
  });
  autoUpdater.on("update-available", (info) => {
    publishUpdaterState({ state: "available", version: info.version });
  });
  autoUpdater.on("update-not-available", () => {
    publishUpdaterState({ state: "not-available" });
  });
  autoUpdater.on("download-progress", (progress) => {
    publishUpdaterState({
      state: "downloading",
      version: updaterState.version,
      percent: Math.round(progress.percent),
    });
  });
  autoUpdater.on("update-downloaded", (info) => {
    publishUpdaterState({ state: "downloaded", version: info.version });
  });
  autoUpdater.on("error", (error) => {
    console.error(`[updater] ${error.message}`);
    publishUpdaterState({ state: "error", error: error.message });
  });
  void autoUpdater
    .checkForUpdatesAndNotify()
    .then((result) => {
      console.log(
        `[updater] checked; latest=${result?.updateInfo.version ?? "unknown"} current=${app.getVersion()}`,
      );
    })
    .catch((error) => {
      console.error(`[updater] check failed: ${error.message}`);
    });
}

async function createWindow(): Promise<void> {
  const root = app.getAppPath();
  const state = await loadWindowState();
  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    ...(state.x !== undefined && state.y !== undefined
      ? { x: state.x, y: state.y }
      : {}),
    minWidth: 760,
    minHeight: 520,
    backgroundColor: "#0f1115",
    title: "ollama-agent",
    webPreferences: {
      preload: path.join(root, "dist-electron", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });

  if (state.maximized) mainWindow.maximize();

  // The renderer is a local static page; never open or navigate elsewhere.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, target) => {
    if (target !== mainWindow?.webContents.getURL()) event.preventDefault();
  });
  mainWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());

  void mainWindow.loadFile(path.join(root, "web", "index.html"));

  if (options.devtools) mainWindow.webContents.openDevTools({ mode: "detach" });

  mainWindow.webContents.on("did-finish-load", () => {
    console.log("[electron] renderer loaded");
    if (!process.env.AGENT_SMOKE && !process.env.AGENT_SMOKE_CHAT) return;
    void (async () => {
      try {
        const stateInfo = await mainWindow?.webContents.executeJavaScript(
          `Promise.all([window.agentBridge.getState(), window.agentBridge.listSessions()]).then(([s, l]) => JSON.stringify({ model: s.model, mode: s.mode, mcp: s.mcp.length, sessions: l.sessions.length, appLoaded: Boolean(window.__agentAppLoaded) }))`,
        );
        console.log("[electron] ipc state:", stateInfo);
        if (process.env.AGENT_SMOKE_DROP_FILE) {
          const filePath = process.env.AGENT_SMOKE_DROP_FILE;
          const buffer = await readFile(filePath);
          const name = path.basename(filePath);
          const mime = attachmentMimeTypeForPath(filePath);
          await mainWindow?.webContents.executeJavaScript(`
            (() => {
              const bytes = Uint8Array.from(atob(${JSON.stringify(buffer.toString("base64"))}), (c) => c.charCodeAt(0));
              const file = new File([bytes], ${JSON.stringify(name)}, { type: ${JSON.stringify(mime)} });
              const transfer = new DataTransfer();
              transfer.items.add(file);
              window.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
            })()
          `);
          await new Promise((resolve) => setTimeout(resolve, 800));
        }
        if (process.env.AGENT_SMOKE_APPROVAL) {
          const prompt =
            process.env.AGENT_SMOKE_PROMPT ||
            "Use the Write tool to create /tmp/ui-demo/approval.txt containing \"please review\".";
          await mainWindow?.webContents.executeJavaScript(`
            const input = document.getElementById("input");
            input.value = ${JSON.stringify(prompt)};
            input.dispatchEvent(new Event("input", { bubbles: true }));
            document.getElementById("composer").requestSubmit();
          `);
          await new Promise((resolve) => setTimeout(resolve, 8000));
        }
        if (process.env.AGENT_SMOKE_CHAT && !process.env.AGENT_SMOKE_APPROVAL) {
          const imagePath = process.env.AGENT_SMOKE_IMAGE;
          const prompt =
            process.env.AGENT_SMOKE_PROMPT ||
            (imagePath
              ? "What number is shown? Answer with just the number."
              : "Reply with exactly: ipc ok");
          let images = "[]";
          if (imagePath) {
            const buffer = await readFile(imagePath);
            images = JSON.stringify([
              {
                data: buffer.toString("base64"),
                mimeType: "image/png",
                name: path.basename(imagePath),
              },
            ]);
          }
          if (imagePath) {
            const chat = await mainWindow?.webContents.executeJavaScript(`
              new Promise((resolve) => {
                let text = "";
                const events = [];
                const timer = setTimeout(() => resolve(JSON.stringify({ timeout: true, text, events })), 90000);
                window.agentBridge.chat(${JSON.stringify(prompt)}, ${images}, (event, data) => {
                  events.push(event);
                  if (event === "text") text += data.text;
                  if (event === "done") {
                    clearTimeout(timer);
                    resolve(JSON.stringify({ text, events }));
                  }
                }).catch((error) => { clearTimeout(timer); resolve("error: " + error.message); });
              })
            `);
            console.log("[electron] ipc chat:", chat);
          } else {
            const chat = await mainWindow?.webContents.executeJavaScript(`
              (async () => {
                const before = window.__agentTurns || 0;
                const input = document.getElementById("input");
                input.value = ${JSON.stringify(prompt)};
                input.dispatchEvent(new Event("input", { bubbles: true }));
                document.getElementById("composer").requestSubmit();
                const deadline = Date.now() + 300000;
                while ((window.__agentTurns || 0) <= before) {
                  if (Date.now() > deadline) {
                    return JSON.stringify({ timeout: true, events: window.__agentEventLog, errors: window.__agentErrors });
                  }
                  await new Promise((resolve) => setTimeout(resolve, 300));
                }
                const thread = document.getElementById("thread");
                return JSON.stringify({
                  messages: thread.querySelectorAll(".msg").length,
                  text: thread.innerText.slice(0, 300),
                  events: window.__agentEventLog,
                  errors: window.__agentErrors,
                });
              })()
            `);
            console.log("[electron] ui chat:", chat);
          }
        }
        if (process.env.AGENT_SMOKE_MODAL) {
          const modalState = await mainWindow?.webContents.executeJavaScript(`
            (() => {
              document.getElementById("settings-btn").click();
              const tab = document.querySelector('.tab[data-tab="${process.env.AGENT_SMOKE_MODAL}"]');
              if (tab) tab.click();
              return JSON.stringify({
                hidden: document.getElementById("modal").hidden,
                tab: Boolean(tab),
                body: document.body.className,
                checkpoints: (document.getElementById("checkpoints-list")?.innerText || "").slice(0, 200),
              });
            })()
          `);
          console.log("[electron] modal smoke:", modalState);
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
        if (process.env.AGENT_SMOKE_UPDATE) {
          await mainWindow?.webContents.executeJavaScript(`
            const button = document.getElementById("update-check");
            if (button) button.click();
          `);
          await new Promise((resolve) => setTimeout(resolve, 2500));
        }
        if (process.env.AGENT_SMOKE_TEAM) {
          const teamState = await mainWindow?.webContents.executeJavaScript(`
            (() => {
              const button = document.getElementById("team-btn");
              const panel = document.getElementById("team-panel");
              const send = document.getElementById("send");
              const stop = document.getElementById("stop");
              const before = {
                buttonHidden: button ? button.hidden : null,
                panelHidden: panel ? panel.hidden : null,
                running: stop ? !stop.hidden : null,
                sendHidden: send ? send.hidden : null,
              };
              if (button) button.click();
              const view = document.querySelector(".team-member-actions button");
              if (view) view.click();
              return JSON.stringify({
                before,
                after: {
                  buttonHidden: button ? button.hidden : null,
                  panelHidden: panel ? panel.hidden : null,
                  panelDisplay: panel ? getComputedStyle(panel).display : null,
                  members: document.querySelectorAll(".team-member").length,
                  bodyClass: document.body.className,
                },
              });
            })()
          `);
          console.log("[electron] team smoke:", teamState);
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        if (process.env.AGENT_SMOKE_ARTIFACTS) {
          await mainWindow?.webContents.executeJavaScript(`
            const button = document.getElementById("artifacts-btn");
            if (button) button.click();
            const first = document.querySelector(".artifact-item");
            if (first) first.click();
          `);
          await new Promise((resolve) => setTimeout(resolve, 800));
        }
        if (process.env.AGENT_SMOKE_PURGE) {
          await mainWindow?.webContents.executeJavaScript(`
            document.getElementById("purge-all-sessions")?.click();
          `);
          await new Promise((resolve) => setTimeout(resolve, 800));
        }
        if (process.env.AGENT_SMOKE_SCREENSHOT) {
          await new Promise((resolve) => setTimeout(resolve, 1200));
          mainWindow?.show();
          mainWindow?.focus();
          mainWindow?.webContents.invalidate();
          await new Promise((resolve) => setTimeout(resolve, 800));
          const image = await mainWindow?.webContents.capturePage();
          if (image) {
            await writeFile(process.env.AGENT_SMOKE_SCREENSHOT, image.toPNG());
            console.log("[electron] screenshot saved");
          }
        }
      } catch (error) {
        console.error(
          `[electron] ipc smoke failed: ${error instanceof Error ? error.message : error}`,
        );
      } finally {
        app.quit();
      }
    })();
  });

  mainWindow.webContents.on("console-message", (event: unknown) => {
    if (!process.env.AGENT_SMOKE) return;
    const message = (event as { message?: string }).message;
    if (message) console.log(`[renderer] ${message}`);
  });

  mainWindow.on("close", () => {
    if (mainWindow) void saveWindowState(mainWindow);
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  void app.whenReady().then(async () => {
    try {
      await initCore();
    } catch (error) {
      console.error(
        `[electron] failed to start: ${error instanceof Error ? error.stack : error}`,
      );
      app.quit();
      return;
    }

    // The app needs no camera, microphone, notifications, or device access.
    electronSession.defaultSession.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );
    electronSession.defaultSession.setPermissionCheckHandler(() => false);

    registerIpc();
    if (process.platform === "darwin") {
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }]),
      );
    } else {
      Menu.setApplicationMenu(null);
    }
    await createWindow();
    setupUpdater();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    void background?.close();
    void agent?.close();
    void mcp?.close();
  });
}

import { app, BrowserWindow, Menu, dialog, ipcMain, session as electronSession } from "electron";
import { autoUpdater } from "electron-updater";
import type { MenuItemConstructorOptions } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { Agent, type AgentEvent } from "../src/core/agent.ts";
import { MAX_IMAGES, validateImageAttachment } from "../src/core/images.ts";
import type { ImageAttachment } from "../src/core/types.ts";
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
import { loadSettings, updateSettings, type AppSettings } from "../src/core/settings.ts";
import { readProjectFile } from "../src/core/files.ts";
import {
  assertDirectory,
  buildSystemPrompt,
  loadProjectInstructions,
  type ProjectInstructions,
} from "../src/core/project.ts";
import { checkForLatestRelease } from "../src/core/updates.ts";
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
let mcp: McpManager | undefined;

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
  agent.tools = [...allTools, ...(mcp?.tools ?? [])];
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
      });
      break;
    case "tool_end":
      sendEvent("tool_end", {
        name: event.name,
        content: event.content,
        isError: event.isError,
      });
      break;
    case "notice":
      sendEvent("notice", { text: event.text });
      break;
    case "session_title":
      sendEvent("session_title", { title: event.title });
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
  agent = new Agent({
    provider,
    model,
    tools: [...allTools, ...(mcp?.tools ?? [])],
    permissions,
    session,
    cwd: options.cwd,
    system: buildSystemPrompt(options.cwd, projectInstructions),
    planApprover,
    onEvent: forwardAgentEvent,
  });
}

function registerIpc(): void {
  ipcMain.handle("agent:state", () => statePayload());

  ipcMain.handle("agent:models", async () => ({
    models: await provider.listModels(),
    current: agent.model,
  }));

  ipcMain.handle(
    "agent:set-state",
    (_event, payload: unknown) => {
      const patch = asRecord(payload);
      if (typeof patch.model === "string" && patch.model.trim()) {
        agent.model = patch.model.trim();
        agent.session.model = agent.model;
      }
      if (typeof patch.mode === "string") {
        if (!PERMISSION_MODES.includes(patch.mode as PermissionMode)) {
          throw new Error("Unknown mode.");
        }
        permissions.setMode(patch.mode as PermissionMode);
      }
      return { model: agent.model, mode: permissions.mode };
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

    busy = true;
    const controller = new AbortController();
    agent.signal = controller.signal;
    currentRun = controller;
    sendEvent("start", { model: agent.model, mode: permissions.mode });
    try {
      await agent.run(message, images.length > 0 ? images : undefined);
    } finally {
      currentRun = null;
      agent.signal = undefined;
      sendEvent("done", agent.contextUsage());
      busy = false;
    }
    return { ok: true };
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

  ipcMain.handle("settings:get", () => settings);

  ipcMain.handle("settings:update", async (_event, payload: unknown) => {
    const body = asRecord(payload);
    const patch: Partial<AppSettings> = {};
    if (body.theme === "system" || body.theme === "light" || body.theme === "dark") {
      patch.theme = body.theme;
    }
    if (typeof body.model === "string") patch.model = body.model;
    if (typeof body.mode === "string") patch.mode = body.mode as PermissionMode;
    if (typeof body.showThinking === "boolean") patch.showThinking = body.showThinking;
    settings = await updateSettings(patch);
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

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    { label: "File", submenu: [{ role: "quit" }] },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "About ollama-agent",
          click: () => {
            void dialog.showMessageBox({
              type: "info",
              title: "ollama-agent",
              message: `ollama-agent ${app.getVersion()}`,
              detail: "Agentic coding client for Ollama local and cloud models.",
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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
        if (process.env.AGENT_SMOKE_CHAT) {
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
                const deadline = Date.now() + 120000;
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
          await mainWindow?.webContents.executeJavaScript(`
            document.getElementById("settings-btn").click();
            const tab = document.querySelector('.tab[data-tab="${process.env.AGENT_SMOKE_MODAL}"]');
            if (tab) tab.click();
          `);
          await new Promise((resolve) => setTimeout(resolve, 900));
        }
        if (process.env.AGENT_SMOKE_UPDATE) {
          await mainWindow?.webContents.executeJavaScript(`
            const button = document.getElementById("update-check");
            if (button) button.click();
          `);
          await new Promise((resolve) => setTimeout(resolve, 2500));
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
        if (process.env.AGENT_SMOKE_SCREENSHOT) {
          await new Promise((resolve) => setTimeout(resolve, 1200));
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

  app.whenReady().then(async () => {
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
    buildMenu();
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
    void mcp?.close();
  });
}

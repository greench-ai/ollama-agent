import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";

type EventPayload = { event: string; data: unknown };

const bridge = {
  runtime: "electron" as const,

  getState: () => ipcRenderer.invoke("agent:state"),

  getModels: () => ipcRenderer.invoke("agent:models"),

  setState: (patch: { model?: string; mode?: string }) =>
    ipcRenderer.invoke("agent:set-state", patch),

  reset: () => ipcRenderer.invoke("agent:reset"),

  approve: (id: string, decision: string) =>
    ipcRenderer.invoke("agent:approve", { id, decision }),

  approvePlan: (id: string, approved: boolean, feedback?: string) =>
    ipcRenderer.invoke("agent:approve-plan", { id, approved, feedback }),

  cancel: () => ipcRenderer.invoke("agent:cancel"),

  listSessions: () => ipcRenderer.invoke("sessions:list"),

  newSession: () => ipcRenderer.invoke("sessions:new"),

  loadSession: (id: string) => ipcRenderer.invoke("sessions:load", { id }),

  renameSession: (id: string, title: string) =>
    ipcRenderer.invoke("sessions:rename", { id, title }),

  deleteSession: (id: string) => ipcRenderer.invoke("sessions:delete", { id }),

  getSettings: () => ipcRenderer.invoke("settings:get"),

  listAgents: () => ipcRenderer.invoke("agents:list"),

  getTelemetry: () => ipcRenderer.invoke("telemetry:get"),

  backgroundState: () => ipcRenderer.invoke("background:state"),

  backgroundDispatch: (prompt: string, title?: string) =>
    ipcRenderer.invoke("background:dispatch", { prompt, title }),

  backgroundCancel: (id: string) =>
    ipcRenderer.invoke("background:cancel", { id }),

  backgroundTranscript: (id: string) =>
    ipcRenderer.invoke("background:transcript", { id }),

  backgroundAddSchedule: (input: {
    name: string;
    prompt: string;
    cron: string;
    enabled?: boolean;
  }) => ipcRenderer.invoke("background:schedule:add", input),

  backgroundRemoveSchedule: (id: string) =>
    ipcRenderer.invoke("background:schedule:remove", { id }),

  listCheckpoints: () => ipcRenderer.invoke("checkpoints:list"),

  restoreCheckpoint: (id: string) =>
    ipcRenderer.invoke("checkpoints:restore", { id }),

  teamStatus: () => ipcRenderer.invoke("team:status"),

  teamMessage: (to: string, text: string) =>
    ipcRenderer.invoke("team:message", { to, text }),

  teamStop: (name: string) => ipcRenderer.invoke("team:stop", { name }),

  teamTranscript: (name: string) =>
    ipcRenderer.invoke("team:transcript", { name }),

  teamReview: (name: string, diff = false) =>
    ipcRenderer.invoke("team:review", { name, diff }),

  updateSettings: (patch: {
    theme?: string;
    customTheme?: unknown;
    model?: string;
    mode?: string;
    showThinking?: boolean;
  }) => ipcRenderer.invoke("settings:update", patch),

  importTheme: (input: { url?: string; css?: string }) =>
    ipcRenderer.invoke("theme:import", input),

  mcpList: () => ipcRenderer.invoke("mcp:list"),

  mcpSave: (name: string, config: unknown) =>
    ipcRenderer.invoke("mcp:save", { name, config }),

  mcpRemove: (name: string) => ipcRenderer.invoke("mcp:remove", { name }),

  mcpReconnect: (name?: string) =>
    ipcRenderer.invoke("mcp:reconnect", { name }),

  mcpLogout: (name: string) => ipcRenderer.invoke("mcp:logout", { name }),

  checkForUpdates: () => ipcRenderer.invoke("update:check"),

  updateStatus: () => ipcRenderer.invoke("update:status"),

  installUpdate: () => ipcRenderer.invoke("update:install"),

  pickProject: () => ipcRenderer.invoke("project:pick"),

  setProject: (path: string) => ipcRenderer.invoke("project:set", { path }),

  readFile: (path: string) => ipcRenderer.invoke("file:read", { path }),

  chat: async (
    message: string,
    images: Array<{ data: string; mimeType: string; name?: string }>,
    files: Array<{
      name: string;
      mimeType: string;
      content?: string;
      data?: string;
      size?: number;
    }>,
    onEvent: (event: string, data: unknown) => void,
  ): Promise<unknown> => {
    const listener = (_event: IpcRendererEvent, payload: EventPayload) => {
      try {
        onEvent(payload.event, payload.data);
      } catch (error) {
        console.error("[preload] agent event handler failed", error);
      }
    };
    ipcRenderer.on("agent:event", listener);
    try {
      return await ipcRenderer.invoke("agent:chat", { message, images, files });
    } finally {
      ipcRenderer.removeListener("agent:event", listener);
    }
  },
};

contextBridge.exposeInMainWorld("agentBridge", bridge);

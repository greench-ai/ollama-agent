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

  chat: async (
    message: string,
    images: Array<{ data: string; mimeType: string; name?: string }>,
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
      return await ipcRenderer.invoke("agent:chat", { message, images });
    } finally {
      ipcRenderer.removeListener("agent:event", listener);
    }
  },
};

contextBridge.exposeInMainWorld("agentBridge", bridge);

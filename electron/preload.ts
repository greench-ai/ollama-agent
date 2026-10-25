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

  chat: async (
    message: string,
    images: Array<{ data: string; mimeType: string; name?: string }>,
    onEvent: (event: string, data: unknown) => void,
  ): Promise<unknown> => {
    const listener = (_event: IpcRendererEvent, payload: EventPayload) => {
      onEvent(payload.event, payload.data);
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

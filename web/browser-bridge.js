// Browser fallback bridge. In Electron the preload script installs
// window.agentBridge first, so this file does nothing there.
(function () {
  if (window.agentBridge) return;

  async function post(url, body) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || response.statusText);
    }
    return response.json().catch(() => ({}));
  }

  window.agentBridge = {
    runtime: "browser",

    getState: () => fetch("/api/state").then((response) => response.json()),

    getModels: () => fetch("/api/models").then((response) => response.json()),

    setState: (patch) => post("/api/state", patch),

    reset: () => post("/api/reset", {}),

    approve: (id, decision) => post("/api/approve", { id, decision }),

    approvePlan: (id, approved, feedback) =>
      post("/api/approve-plan", { id, approved, feedback }),

    cancel: () => post("/api/cancel", {}),

    listSessions: () => fetch("/api/sessions").then((response) => response.json()),

    newSession: () => post("/api/sessions/new", {}),

    loadSession: (id) => post("/api/sessions/load", { id }),

    renameSession: (id, title) => post("/api/sessions/rename", { id, title }),

    deleteSession: (id) => post("/api/sessions/delete", { id }),

    getSettings: () => fetch("/api/settings").then((response) => response.json()),

    updateSettings: (patch) => post("/api/settings", patch),

    mcpList: () => fetch("/api/mcp").then((response) => response.json()),

    mcpSave: (name, config) => post("/api/mcp/save", { name, config }),

    mcpRemove: (name) => post("/api/mcp/remove", { name }),

    mcpReconnect: (name) => post("/api/mcp/reconnect", { name }),

    mcpLogout: (name) => post("/api/mcp/logout", { name }),

    updateStatus: () =>
      fetch("/api/update/status").then((response) => response.json()),

    checkForUpdates: () => post("/api/update/check", {}),

    installUpdate: () => post("/api/update/install", {}),

    setProject: (path) => post("/api/project/set", { path }),

    async readFile(path) {
      const response = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || response.statusText);
      }
      return response.json();
    },

    async chat(message, images, onEvent) {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, images: images ?? [] }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || response.statusText);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
          let event = "message";
          const dataLines = [];
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
          }
          if (dataLines.length === 0) continue;
          let data = {};
          try {
            data = JSON.parse(dataLines.join("\n"));
          } catch {
            continue;
          }
          onEvent(event, data);
        }
      }
    },
  };
})();

// Desktop/browser client. One UI over two transports:
//   Electron: window.agentBridge from the preload script
//   Browser:  window.agentBridge from browser-bridge.js (HTTP/SSE)
(function () {
  const bridge = window.agentBridge;
  const $ = (id) => document.getElementById(id);

  const log = $("log");
  const thread = $("thread");
  const composer = $("composer");
  const input = $("input");
  const send = $("send");
  const stop = $("stop");
  const attach = $("attach");
  const fileInput = $("file");
  const previews = $("previews");
  const modelSelect = $("model");
  const modeSelect = $("mode");
  const titleEl = $("chat-title");
  const chatsEl = $("chats");
  const searchEl = $("search");
  const mcpEl = $("mcp");
  const themeBtn = $("theme");
  const collapseBtn = $("collapse");
  const expandBtn = $("expand");
  const newChatBtn = $("new-chat");
  const settingsBtn = $("settings-btn");

  const modal = $("modal");
  const modalClose = $("modal-close");
  const settingTheme = $("set-theme");
  const settingModel = $("set-model");
  const settingMode = $("set-mode");
  const settingThinking = $("set-thinking");
  const settingsSave = $("settings-save");
  const settingsError = $("settings-error");
  const mcpPathEl = $("mcp-path");
  const mcpListEl = $("mcp-list");
  const mcpAdd = $("mcp-add");
  const mcpForm = $("mcp-form");
  const mcpName = $("mcp-name");
  const mcpTransport = $("mcp-transport");
  const mcpCommand = $("mcp-command");
  const mcpArgs = $("mcp-args");
  const mcpEnv = $("mcp-env");
  const mcpCwd = $("mcp-cwd");
  const mcpUrl = $("mcp-url");
  const mcpHeaders = $("mcp-headers");
  const mcpAuth = $("mcp-auth");
  const mcpAuthExplicit = $("mcp-auth-explicit");
  const mcpAuthUrl = $("mcp-auth-url");
  const mcpTokenUrl = $("mcp-token-url");
  const mcpClientId = $("mcp-client-id");
  const mcpClientSecret = $("mcp-client-secret");
  const mcpScopes = $("mcp-scopes");
  const mcpRedirectPort = $("mcp-redirect-port");
  const mcpError = $("mcp-error");
  const mcpSave = $("mcp-save");
  const mcpCancel = $("mcp-cancel");
  const aboutCwd = $("about-cwd");
  const aboutSession = $("about-session");
  const aboutMcp = $("about-mcp");

  if (!bridge) {
    thread.appendChild(
      Object.assign(document.createElement("div"), {
        className: "notice error",
        textContent:
          "No agent bridge available. Start the Electron app or src/server.ts.",
      }),
    );
    return;
  }

  window.__agentAppLoaded = true;
  window.__agentTurns = 0;
  window.__agentEventLog = [];
  window.__agentErrors = [];
  const pushBounded = (list, value) => {
    if (list.length < 500) list.push(value);
  };
  window.addEventListener("error", (event) => {
    pushBounded(window.__agentErrors, String(event.message || event));
  });
  window.addEventListener("unhandledrejection", (event) => {
    pushBounded(window.__agentErrors, String(event.reason));
  });

  const state = {
    sessionId: null,
    title: "New chat",
    running: false,
    sessions: [],
    models: [],
    model: "",
    mode: "default",
    stagedImages: [],
    theme: "system",
    settings: { theme: "system", showThinking: true, model: "", mode: "default" },
    cwd: "",
    sessionFile: "",
    mcpPath: "",
    mcpData: { path: "", servers: [], configs: {} },
  };

  let current = null;

  /* ---------- helpers ---------- */

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function nearBottom() {
    return log.scrollHeight - log.scrollTop - log.clientHeight < 180;
  }

  function scrollIfNear() {
    if (nearBottom()) log.scrollTop = log.scrollHeight;
  }

  function scrollToBottom() {
    log.scrollTop = log.scrollHeight;
  }

  function setHasChat(has) {
    document.body.classList.toggle("has-chat", has);
  }

  function md(text) {
    return typeof window.renderMarkdown === "function"
      ? window.renderMarkdown(text)
      : String(text).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        area.remove();
        return true;
      } catch {
        return false;
      }
    }
  }

  function enhance(container) {
    container.querySelectorAll("pre").forEach((pre) => {
      if (pre.querySelector(".copy")) return;
      const button = el("button", "copy", "Copy");
      button.type = "button";
      button.addEventListener("click", async () => {
        const code = pre.querySelector("code");
        const ok = await copyText(code ? code.textContent : pre.textContent);
        button.textContent = ok ? "Copied" : "Failed";
        setTimeout(() => {
          button.textContent = "Copy";
        }, 1200);
      });
      pre.appendChild(button);
    });
  }

  function renderMarkdownInto(node, text) {
    node.innerHTML = md(text);
    enhance(node);
  }

  function summarize(name, input) {
    if (!input || typeof input !== "object") return "";
    switch (name) {
      case "Bash":
        return typeof input.command === "string" ? input.command : "";
      case "Read":
      case "Write":
      case "Edit":
      case "MultiEdit":
        return typeof input.file_path === "string" ? input.file_path : "";
      case "Glob":
      case "Grep":
        return typeof input.pattern === "string" ? input.pattern : "";
      case "TodoWrite":
        return `${Array.isArray(input.todos) ? input.todos.length : 0} item(s)`;
      case "Task":
        return typeof input.description === "string" ? input.description : "";
      default: {
        const entry = Object.entries(input)[0];
        if (!entry) return "";
        const value = typeof entry[1] === "string" ? entry[1] : JSON.stringify(entry[1]);
        return `${entry[0]}=${String(value).slice(0, 110)}`;
      }
    }
  }

  /* ---------- theme + sidebar ---------- */

  const THEMES = ["system", "light", "dark"];

  function applyTheme(theme, persist = true) {
    state.theme = THEMES.includes(theme) ? theme : "system";
    state.settings.theme = state.theme;
    document.documentElement.dataset.theme = state.theme;
    themeBtn.textContent = `Theme: ${state.theme}`;
    try {
      localStorage.setItem("ollama-agent-theme", state.theme);
    } catch {
      // private mode / blocked storage
    }
    if (persist && bridge && bridge.updateSettings) {
      bridge.updateSettings({ theme: state.theme }).catch(() => {});
    }
  }

  applyTheme(localStorage.getItem("ollama-agent-theme") || "system", false);
  themeBtn.addEventListener("click", () => {
    const index = THEMES.indexOf(state.theme);
    applyTheme(THEMES[(index + 1) % THEMES.length], true);
  });

  function setCollapsed(collapsed) {
    document.body.classList.toggle("sidebar-collapsed", collapsed);
    expandBtn.hidden = !collapsed;
    try {
      localStorage.setItem("ollama-agent-sidebar", collapsed ? "collapsed" : "open");
    } catch {
      // ignore
    }
  }

  setCollapsed(localStorage.getItem("ollama-agent-sidebar") === "collapsed");
  collapseBtn.addEventListener("click", () => setCollapsed(true));
  expandBtn.addEventListener("click", () => setCollapsed(false));

  /* ---------- messages ---------- */

  function addUserMessage(text, images, scroll = true) {
    const wrap = el("div", "msg user");
    const bubble = el("div", "bubble");
    if (images && images.length > 0) {
      const thumbs = el("div", "thumbs");
      for (const image of images) {
        const img = document.createElement("img");
        img.src = image.dataUrl;
        img.alt = image.name || "image";
        thumbs.appendChild(img);
      }
      bubble.appendChild(thumbs);
    }
    if (text) bubble.appendChild(document.createTextNode(text));
    else if (images && images.length > 0) {
      bubble.appendChild(document.createTextNode("(image)"));
    }
    wrap.appendChild(bubble);
    thread.appendChild(wrap);
    if (scroll) {
      setHasChat(true);
      scrollIfNear();
    }
  }

  function addThinking(parent) {
    if (!state.settings.showThinking) return null;
    const details = el("details", "thinking");
    details.appendChild(el("summary", "", "Thinking"));
    const pre = el("pre");
    details.appendChild(pre);
    parent.appendChild(details);
    return pre;
  }

  function addToolCard(parent, name, summary, output, isError, open) {
    const details = el("details", `tool${isError ? " error" : ""}`);
    if (open) details.open = true;
    const head = el("summary");
    head.appendChild(el("span", "name", name));
    if (summary) head.appendChild(el("span", "arg", summary));
    details.appendChild(head);
    const pre = el("pre", "", output === undefined ? "" : output);
    details.appendChild(pre);
    parent.appendChild(details);
    return { details, pre };
  }

  function addNotice(text) {
    thread.appendChild(el("div", "notice", text));
    scrollIfNear();
  }

  function addError(text) {
    thread.appendChild(el("div", "notice error", text));
    scrollIfNear();
  }

  function addApproval(event) {
    const card = el("div", "approval");
    const text = el("div", "text");
    text.appendChild(el("strong", "", "Allow " + event.tool + "?"));
    if (event.summary) text.appendChild(el("span", "muted", event.summary));
    card.appendChild(text);

    const actions = el("div", "actions");
    const buttons = [];
    const decide = async (decision) => {
      buttons.forEach((button) => (button.disabled = true));
      try {
        await bridge.approve(event.id, decision);
        actions.remove();
        card.appendChild(
          el("span", "done", decision === "deny" ? "denied" : decision),
        );
      } catch {
        card.appendChild(el("span", "done error", "failed"));
      }
    };
    for (const [label, decision, className] of [
      ["Allow", "allow", "allow"],
      ["Deny", "deny", "deny"],
      ["Always", "always", "always"],
    ]) {
      const button = el("button", className, label);
      button.type = "button";
      button.addEventListener("click", () => decide(decision));
      buttons.push(button);
      actions.appendChild(button);
    }
    card.appendChild(actions);
    thread.appendChild(card);
    scrollIfNear();
  }

  function addPlanApproval(event) {
    const card = el("div", "plan");
    card.appendChild(el("div", "title", "Plan approval"));
    card.appendChild(el("pre", "", event.plan));

    const feedback = el("textarea");
    feedback.placeholder = "Optional feedback if rejecting";
    feedback.rows = 2;
    card.appendChild(feedback);

    const actions = el("div", "actions");
    const buttons = [];
    const finish = async (approved) => {
      buttons.forEach((button) => (button.disabled = true));
      try {
        await bridge.approvePlan(
          event.id,
          approved,
          approved ? undefined : feedback.value.trim() || undefined,
        );
        actions.remove();
        feedback.disabled = true;
        card.appendChild(el("span", "done", approved ? "approved" : "rejected"));
      } catch {
        card.appendChild(el("span", "done error", "failed"));
      }
    };

    const approve = el("button", "approve", "Approve");
    approve.type = "button";
    approve.addEventListener("click", () => finish(true));
    const reject = el("button", "reject", "Reject");
    reject.type = "button";
    reject.addEventListener("click", () => finish(false));
    buttons.push(approve, reject);
    actions.append(approve, reject);
    card.appendChild(actions);
    thread.appendChild(card);
    scrollIfNear();
  }

  /* ---------- history ---------- */

  function renderHistory(messages) {
    thread.innerHTML = "";
    const results = new Map();
    for (const message of messages) {
      for (const block of message.content || []) {
        if (block.type === "tool_result") results.set(block.tool_use_id, block);
      }
    }

    for (const message of messages) {
      const blocks = message.content || [];
      if (message.role === "user") {
        const toolResults = blocks.filter((block) => block.type === "tool_result");
        if (toolResults.length > 0 && toolResults.length === blocks.length) continue;
        const text = blocks
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n");
        const images = blocks
          .filter((block) => block.type === "image")
          .map((image) => ({
            dataUrl: `data:${image.mimeType};base64,${image.data}`,
            name: image.name,
          }));
        if (text || images.length > 0) addUserMessage(text, images, false);
        continue;
      }
      if (message.role !== "assistant") continue;

      const wrap = el("div", "msg assistant");
      let buffer = "";
      const flush = () => {
        if (!buffer) return;
        const block = el("div", "md");
        renderMarkdownInto(block, buffer);
        wrap.appendChild(block);
        buffer = "";
      };

      for (const block of blocks) {
        if (block.type === "thinking") {
          flush();
          const pre = addThinking(wrap);
          if (pre) pre.textContent = block.thinking;
        } else if (block.type === "text") {
          buffer += block.text;
        } else if (block.type === "tool_use") {
          flush();
          const result = results.get(block.id);
          addToolCard(
            wrap,
            block.name,
            summarize(block.name, block.input),
            result ? result.content : "(no result)",
            Boolean(result && result.is_error),
            false,
          );
        }
      }
      flush();
      if (wrap.childElementCount > 0) thread.appendChild(wrap);
    }

    setHasChat(thread.childElementCount > 0);
    scrollToBottom();
  }

  /* ---------- streaming ---------- */

  function startAssistant() {
    const wrap = el("div", "msg assistant");
    const block = el("div", "md");
    wrap.appendChild(block);
    thread.appendChild(wrap);
    setHasChat(true);
    current = {
      wrap,
      mdEl: block,
      text: "",
      thinking: null,
      tool: null,
      scheduled: false,
    };
    return current;
  }

  function scheduleRender() {
    if (!current || current.scheduled) return;
    current.scheduled = true;
    requestAnimationFrame(() => {
      if (!current) return;
      current.scheduled = false;
      renderMarkdownInto(current.mdEl, current.text);
      scrollIfNear();
    });
  }

  function handleEvent(event, data) {
    if (window.__agentEventLog.length < 500) window.__agentEventLog.push(event);
    switch (event) {
      case "start":
        break;
      case "text":
        if (!current) startAssistant();
        current.text += data.text || "";
        scheduleRender();
        break;
      case "thinking":
        if (!current) startAssistant();
        if (!state.settings.showThinking) break;
        if (!current.thinking) current.thinking = addThinking(current.wrap);
        if (current.thinking) current.thinking.textContent += data.text || "";
        break;
      case "tool_start":
        if (!current) startAssistant();
        current.tool = addToolCard(
          current.wrap,
          data.name,
          data.summary,
          "running…",
          false,
          true,
        );
        scrollIfNear();
        break;
      case "tool_end":
        if (current && current.tool) {
          current.tool.pre.textContent = data.content || "(no output)";
          if (data.isError) current.tool.details.classList.add("error");
          current.tool = null;
        }
        break;
      case "notice":
        addNotice(data.text);
        break;
      case "session_title":
        state.title = data.title || "New chat";
        titleEl.textContent = state.title;
        refreshSessions();
        break;
      case "approval":
        addApproval(data);
        break;
      case "plan_approval":
        addPlanApproval(data);
        break;
      case "subagent_start":
        addNotice(`subagent ${data.name} (${data.subagentType}) · ${data.description}`);
        break;
      case "subagent_end":
        addNotice(`subagent ${data.name} ${data.ok ? "finished" : "failed"}`);
        break;
      case "error":
        if (!/abort/i.test(String(data.message || ""))) addError(data.message);
        break;
      case "step":
      case "done":
      case "usage":
        break;
    }
  }

  /* ---------- attachments ---------- */

  const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

  function readFileAsAttachment(file) {
    return new Promise((resolve, reject) => {
      if (!file.type.startsWith("image/")) {
        reject(new Error("Only images are supported."));
        return;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        reject(new Error(file.name + " is larger than 10 MB."));
        return;
      }
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Could not read " + file.name));
      reader.onload = () => {
        const dataUrl = String(reader.result);
        const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
        if (!match) {
          reject(new Error("Unsupported image encoding."));
          return;
        }
        resolve({ data: match[2], mimeType: match[1], name: file.name, dataUrl });
      };
      reader.readAsDataURL(file);
    });
  }

  function renderPreviews() {
    previews.innerHTML = "";
    state.stagedImages.forEach((image, index) => {
      const chip = el("div", "chip");
      const img = document.createElement("img");
      img.src = image.dataUrl;
      img.alt = image.name || "image";
      const remove = el("button", "", "×");
      remove.type = "button";
      remove.title = "Remove";
      remove.addEventListener("click", () => {
        state.stagedImages.splice(index, 1);
        renderPreviews();
      });
      chip.append(img, remove);
      previews.appendChild(chip);
    });
  }

  async function addFiles(files) {
    for (const file of files) {
      if (state.stagedImages.length >= 8) {
        addError("At most 8 images per message.");
        break;
      }
      try {
        state.stagedImages.push(await readFileAsAttachment(file));
      } catch (error) {
        addError(error instanceof Error ? error.message : String(error));
      }
    }
    renderPreviews();
  }

  attach.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const files = Array.from(fileInput.files || []);
    fileInput.value = "";
    if (files.length > 0) void addFiles(files);
  });
  input.addEventListener("paste", (event) => {
    const files = Array.from((event.clipboardData && event.clipboardData.files) || [])
      .filter((file) => file.type.startsWith("image/"));
    if (files.length > 0) {
      event.preventDefault();
      void addFiles(files);
    }
  });

  /* ---------- sessions ---------- */

  function sessionIdFromPath(file) {
    if (!file) return null;
    return String(file).split(/[\\/]/).pop().replace(/\.jsonl$/, "");
  }

  function groupLabel(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "Older";
    const now = new Date();
    const startOf = (value) =>
      new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
    const days = Math.round((startOf(now) - startOf(date)) / 86400000);
    if (days <= 0) return "Today";
    if (days === 1) return "Yesterday";
    if (days < 7) return "Previous 7 days";
    if (days < 30) return "Previous 30 days";
    return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  }

  function renderSessions() {
    const filter = searchEl.value.trim().toLowerCase();
    chatsEl.innerHTML = "";
    const groups = new Map();
    for (const session of state.sessions) {
      if (filter && !String(session.title || "").toLowerCase().includes(filter)) {
        continue;
      }
      const label = groupLabel(session.updatedAt);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(session);
    }
    if (groups.size === 0) {
      chatsEl.appendChild(
        el("div", "empty-list", filter ? "No matching chats" : "No chats yet"),
      );
      return;
    }
    for (const [label, items] of groups) {
      chatsEl.appendChild(el("div", "chat-group", label));
      for (const session of items) chatsEl.appendChild(renderChatItem(session));
    }
  }

  function renderChatItem(session) {
    const item = el(
      "div",
      `chat-item${session.id === state.sessionId ? " active" : ""}`,
    );
    const name = el("div", "name", session.title || "New chat");
    const actions = el("div", "actions");
    const rename = el("button", "", "✎");
    rename.type = "button";
    rename.title = "Rename";
    rename.addEventListener("click", (event) => {
      event.stopPropagation();
      startRename(item, session);
    });
    const remove = el("button", "", "×");
    remove.type = "button";
    remove.title = "Delete";
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      void removeSession(session);
    });
    actions.append(rename, remove);
    item.append(name, actions);
    item.addEventListener("click", () => void selectSession(session.id));
    name.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      startRename(item, session);
    });
    return item;
  }

  function startRename(item, session) {
    const name = item.querySelector(".name");
    if (!name) return;
    const inputEl = document.createElement("input");
    inputEl.value = session.title || "New chat";
    name.replaceWith(inputEl);
    inputEl.focus();
    inputEl.select();
    let finished = false;

    const finish = async (save) => {
      if (finished) return;
      finished = true;
      const value = inputEl.value.trim();
      const restored = el("div", "name", session.title || "New chat");
      inputEl.replaceWith(restored);
      if (!save || !value || value === session.title) return;
      try {
        const result = await bridge.renameSession(session.id, value);
        session.title = result.title || value;
        if (session.id === state.sessionId) {
          state.title = session.title;
          titleEl.textContent = session.title;
        }
        await refreshSessions();
      } catch (error) {
        addError(error instanceof Error ? error.message : String(error));
      }
    };

    inputEl.addEventListener("blur", () => void finish(true));
    inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        void finish(false);
      }
    });
  }

  async function removeSession(session) {
    if (!confirm(`Delete “${session.title || "New chat"}”? This removes its transcript.`)) {
      return;
    }
    try {
      const next = await bridge.deleteSession(session.id);
      if (session.id === state.sessionId) {
        applyState(next);
        state.title = "New chat";
        titleEl.textContent = state.title;
        thread.innerHTML = "";
        setHasChat(false);
      }
      await refreshSessions();
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    }
  }

  async function selectSession(id) {
    if (state.running) {
      addNotice("Stop the current turn before switching chats.");
      return;
    }
    if (id === state.sessionId && thread.childElementCount > 0) return;
    try {
      const data = await bridge.loadSession(id);
      applyState(data);
      state.sessionId = id;
      state.title = data.title || "New chat";
      titleEl.textContent = state.title;
      renderHistory(data.messages || []);
      await refreshSessions();
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    }
  }

  async function newChat() {
    if (state.running) {
      addNotice("Stop the current turn before starting a new chat.");
      return;
    }
    try {
      const data = await bridge.newSession();
      applyState(data);
      state.sessionId = sessionIdFromPath(data.session) || state.sessionId;
      state.title = "New chat";
      titleEl.textContent = state.title;
      thread.innerHTML = "";
      setHasChat(false);
      await refreshSessions();
      input.focus();
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    }
  }

  async function refreshSessions() {
    try {
      const data = await bridge.listSessions();
      state.sessions = data.sessions || [];
      if (data.current) state.sessionId = data.current;
      renderSessions();
    } catch {
      // Listing is best-effort; do not interrupt the conversation.
    }
  }

  newChatBtn.addEventListener("click", () => void newChat());
  searchEl.addEventListener("input", renderSessions);

  /* ---------- turn control ---------- */

  function setRunning(running) {
    state.running = running;
    send.hidden = running;
    stop.hidden = !running;
    stop.disabled = false;
  }

  stop.addEventListener("click", async () => {
    stop.disabled = true;
    addNotice("stopping…");
    try {
      await bridge.cancel();
    } catch {
      // The run may already have finished.
    }
  });

  async function runTurn(text) {
    if (state.running) return;
    if (!text && state.stagedImages.length === 0) return;

    const images = state.stagedImages.slice();
    state.stagedImages = [];
    renderPreviews();

    setRunning(true);
    addUserMessage(text, images);
    startAssistant();

    try {
      await bridge.chat(
        text,
        images.map(({ data, mimeType, name }) => ({ data, mimeType, name })),
        handleEvent,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/abort/i.test(message)) addError(message);
    } finally {
      if (current) {
        renderMarkdownInto(current.mdEl, current.text);
        scrollIfNear();
      }
      current = null;
      setRunning(false);
      window.__agentTurns = (window.__agentTurns || 0) + 1;
      void refreshSessions();
      input.focus();
    }
  }

  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text && state.stagedImages.length === 0) return;
    input.value = "";
    autoGrow();
    void runTurn(text);
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      composer.requestSubmit();
    }
  });

  function autoGrow() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 220) + "px";
  }

  input.addEventListener("input", autoGrow);

  for (const suggestion of document.querySelectorAll(".suggestion")) {
    suggestion.addEventListener("click", () => {
      const prompt = suggestion.dataset.prompt || "";
      input.value = "";
      autoGrow();
      void runTurn(prompt);
    });
  }

  /* ---------- state ---------- */

  function applyState(data) {
    if (!data || typeof data !== "object") return;
    if (data.model) {
      state.model = data.model;
      if (![...modelSelect.options].some((option) => option.value === data.model)) {
        const option = el("option", "", data.model);
        option.value = data.model;
        modelSelect.appendChild(option);
      }
      modelSelect.value = data.model;
    }
    if (data.mode) {
      state.mode = data.mode;
      modeSelect.value = data.mode;
    }
    if (data.session) {
      state.sessionFile = data.session;
      state.sessionId = sessionIdFromPath(data.session) || state.sessionId;
    }
    if (data.settings) {
      state.settings = { ...state.settings, ...data.settings };
      applyTheme(state.settings.theme, false);
    }
    if (data.cwd) state.cwd = data.cwd;
    if (data.mcpPath) state.mcpPath = data.mcpPath;
    if (Array.isArray(data.mcp)) updateMcp(data.mcp);
  }

  function updateMcp(servers) {
    if (!servers || servers.length === 0) {
      mcpEl.textContent = "No MCP servers";
      mcpEl.title = "";
      return;
    }
    const ok = servers.filter((server) => server.ok).length;
    mcpEl.textContent = `MCP ${ok}/${servers.length} connected`;
    mcpEl.title = servers
      .map(
        (server) =>
          `${server.name}: ${server.ok ? `${server.toolCount} tool(s)` : server.error || "failed"}`,
      )
      .join("\n");
  }

  function populateModels(data, current) {
    const models = (data && data.models) || [];
    state.models = models;
    modelSelect.innerHTML = "";
    for (const model of models) {
      const option = el("option", "", model.name);
      option.value = model.name;
      modelSelect.appendChild(option);
    }
    const selected = current || (models[0] && models[0].name) || "";
    if (selected) {
      if (![...modelSelect.options].some((option) => option.value === selected)) {
        const option = el("option", "", selected);
        option.value = selected;
        modelSelect.appendChild(option);
      }
      modelSelect.value = selected;
    }
  }

  /* ---------- settings + connectors ---------- */

  function selectTab(name) {
    for (const tab of document.querySelectorAll(".tab")) {
      tab.classList.toggle("active", tab.dataset.tab === name);
    }
    for (const panel of document.querySelectorAll(".tab-panels")) {
      panel.hidden = panel.dataset.panel !== name;
    }
    if (name === "connectors") void refreshConnectors();
    if (name === "about") fillAbout();
  }

  function fillAbout() {
    aboutCwd.textContent = state.cwd || "—";
    aboutSession.textContent = state.sessionFile || "—";
    aboutMcp.textContent = state.mcpPath || "—";
  }

  function openModal(tab) {
    modal.hidden = false;
    resetConnectorForm();
    selectTab(tab || "general");
    void loadSettingsPanel();
    void refreshConnectors();
    fillAbout();
  }

  function closeModal() {
    modal.hidden = true;
  }

  function populateSettingsModels(current) {
    settingModel.innerHTML = "";
    const none = el("option", "", "First available");
    none.value = "";
    settingModel.appendChild(none);
    for (const model of state.models) {
      const option = el("option", "", model.name);
      option.value = model.name;
      settingModel.appendChild(option);
    }
    if (current && !state.models.some((model) => model.name === current)) {
      const option = el("option", "", current);
      option.value = current;
      settingModel.appendChild(option);
    }
    settingModel.value = current || "";
  }

  async function loadSettingsPanel() {
    try {
      const settings = await bridge.getSettings();
      state.settings = { ...state.settings, ...settings };
      settingTheme.value = settings.theme || "system";
      settingMode.value = settings.mode || "default";
      settingThinking.checked = settings.showThinking !== false;
      populateSettingsModels(settings.model || "");
      settingsError.hidden = true;
    } catch (error) {
      settingsError.textContent = error instanceof Error ? error.message : String(error);
      settingsError.hidden = false;
    }
  }

  settingsSave.addEventListener("click", async () => {
    settingsError.hidden = true;
    settingsSave.disabled = true;
    try {
      const next = await bridge.updateSettings({
        theme: settingTheme.value,
        model: settingModel.value,
        mode: settingMode.value,
        showThinking: settingThinking.checked,
      });
      state.settings = { ...state.settings, ...next };
      applyTheme(next.theme || "system", false);
      closeModal();
    } catch (error) {
      settingsError.textContent = error instanceof Error ? error.message : String(error);
      settingsError.hidden = false;
    } finally {
      settingsSave.disabled = false;
    }
  });

  function splitLines(text) {
    return String(text || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function parsePairs(text) {
    const out = {};
    for (const line of splitLines(text)) {
      const index = line.indexOf("=");
      if (index <= 0) {
        throw new Error(`Invalid line "${line}" (expected KEY=VALUE).`);
      }
      out[line.slice(0, index).trim()] = line.slice(index + 1).trim();
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  function pairsToLines(value) {
    if (!value || typeof value !== "object") return "";
    return Object.entries(value)
      .map(([key, entry]) => `${key}=${entry}`)
      .join("\n");
  }

  function updateTransportSections() {
    for (const section of document.querySelectorAll(".mcp-section[data-transport]")) {
      section.hidden = section.dataset.transport !== mcpTransport.value;
    }
  }

  function updateAuthSections() {
    mcpAuthExplicit.hidden = mcpAuth.value !== "explicit";
  }

  function resetConnectorForm() {
    mcpForm.hidden = true;
    mcpError.hidden = true;
    mcpName.value = "";
    mcpName.disabled = false;
    mcpTransport.value = "stdio";
    mcpCommand.value = "";
    mcpArgs.value = "";
    mcpEnv.value = "";
    mcpCwd.value = "";
    mcpUrl.value = "";
    mcpHeaders.value = "";
    mcpAuth.value = "none";
    mcpAuthUrl.value = "";
    mcpTokenUrl.value = "";
    mcpClientId.value = "";
    mcpClientSecret.value = "";
    mcpScopes.value = "";
    mcpRedirectPort.value = "";
    updateTransportSections();
    updateAuthSections();
  }

  function fillConnectorForm(name, config) {
    mcpError.hidden = true;
    mcpForm.hidden = false;
    mcpName.value = name;
    mcpName.disabled = true;

    if (config && typeof config.command === "string") {
      mcpTransport.value = "stdio";
      mcpCommand.value = config.command;
      mcpArgs.value = Array.isArray(config.args) ? config.args.join("\n") : "";
      mcpEnv.value = pairsToLines(config.env);
      mcpCwd.value = typeof config.cwd === "string" ? config.cwd : "";
    } else {
      mcpTransport.value = "http";
      mcpUrl.value = config && typeof config.url === "string" ? config.url : "";
      mcpHeaders.value = pairsToLines(config && config.headers);
      const auth = config && config.auth;
      if (!auth) {
        mcpAuth.value = "none";
      } else if (auth.authorizationUrl || auth.clientId) {
        mcpAuth.value = "explicit";
        mcpAuthUrl.value = auth.authorizationUrl || "";
        mcpTokenUrl.value = auth.tokenUrl || "";
        mcpClientId.value = auth.clientId || "";
        mcpClientSecret.value = auth.clientSecret || "";
        mcpScopes.value = Array.isArray(auth.scopes) ? auth.scopes.join(" ") : "";
        mcpRedirectPort.value = auth.redirectPort ? String(auth.redirectPort) : "";
      } else {
        mcpAuth.value = "discover";
      }
    }
    updateTransportSections();
    updateAuthSections();
  }

  function buildConnectorConfig() {
    if (mcpTransport.value === "stdio") {
      const command = mcpCommand.value.trim();
      if (!command) throw new Error("Command is required for stdio connectors.");
      const config = { type: "stdio", command };
      const args = splitLines(mcpArgs.value);
      if (args.length > 0) config.args = args;
      const env = parsePairs(mcpEnv.value);
      if (env) config.env = env;
      const cwd = mcpCwd.value.trim();
      if (cwd) config.cwd = cwd;
      return config;
    }

    const url = mcpUrl.value.trim();
    if (!url) throw new Error("URL is required for http connectors.");
    const config = { type: "http", url };
    const headers = parsePairs(mcpHeaders.value);
    if (headers) config.headers = headers;

    if (mcpAuth.value === "discover") {
      config.auth = { type: "oauth" };
    } else if (mcpAuth.value === "explicit") {
      const authorizationUrl = mcpAuthUrl.value.trim();
      const tokenUrl = mcpTokenUrl.value.trim();
      const clientId = mcpClientId.value.trim();
      if (!authorizationUrl || !tokenUrl || !clientId) {
        throw new Error("Authorization URL, token URL, and client ID are required.");
      }
      const auth = { type: "oauth", authorizationUrl, tokenUrl, clientId };
      const clientSecret = mcpClientSecret.value.trim();
      if (clientSecret) auth.clientSecret = clientSecret;
      const scopes = mcpScopes.value
        .split(/[\s,]+/)
        .map((scope) => scope.trim())
        .filter(Boolean);
      if (scopes.length > 0) auth.scopes = scopes;
      const port = Number(mcpRedirectPort.value);
      if (Number.isFinite(port) && port > 0) auth.redirectPort = port;
      config.auth = auth;
    }
    return config;
  }

  function describeConnector(config) {
    if (!config || typeof config !== "object") return "not in config file";
    if (typeof config.command === "string") {
      const args = Array.isArray(config.args) ? ` ${config.args.join(" ")}` : "";
      return `stdio · ${config.command}${args}`.slice(0, 140);
    }
    if (typeof config.url === "string") {
      return `http · ${config.url}${config.auth ? " · OAuth" : ""}`.slice(0, 140);
    }
    return "unknown";
  }

  function renderConnectors(data) {
    mcpListEl.innerHTML = "";
    const statuses = data.servers || [];
    const configs = data.configs || {};
    const names = new Set([
      ...statuses.map((server) => server.name),
      ...Object.keys(configs),
    ]);
    if (names.size === 0) {
      mcpListEl.appendChild(el("div", "empty-list", "No connectors configured."));
      return;
    }

    for (const name of [...names].sort()) {
      const status = statuses.find((server) => server.name === name);
      const config = configs[name];
      const row = el("div", "connector");
      const main = el("div", "connector-main");
      const title = el("div", "connector-name");
      title.appendChild(document.createTextNode(name));
      if (status && status.ok) {
        title.appendChild(
          el("span", "badge ok", `${status.toolCount} tool${status.toolCount === 1 ? "" : "s"}`),
        );
      } else if (status) {
        title.appendChild(el("span", "badge bad", "failed"));
      } else {
        title.appendChild(el("span", "badge", "not connected"));
      }
      main.appendChild(title);
      main.appendChild(el("div", "connector-sub", describeConnector(config)));
      if (status && !status.ok && status.error) {
        main.appendChild(el("div", "connector-error", status.error));
      }
      row.appendChild(main);

      const actions = el("div", "connector-actions");
      const reconnect = el("button", "", "Reconnect");
      reconnect.type = "button";
      reconnect.addEventListener("click", async () => {
        reconnect.disabled = true;
        reconnect.textContent = "Connecting…";
        try {
          const next = await bridge.mcpReconnect(name);
          state.mcpData = next;
          updateMcp(next.servers || []);
          renderConnectors(next);
        } catch (error) {
          showMcpError(error instanceof Error ? error.message : String(error));
        } finally {
          reconnect.disabled = false;
          reconnect.textContent = "Reconnect";
        }
      });
      actions.appendChild(reconnect);

      if (config && config.auth) {
        const logout = el("button", "", "Sign out");
        logout.type = "button";
        logout.addEventListener("click", async () => {
          try {
            const next = await bridge.mcpLogout(name);
            state.mcpData = next;
            renderConnectors(next);
          } catch (error) {
            showMcpError(error instanceof Error ? error.message : String(error));
          }
        });
        actions.appendChild(logout);
      }

      if (config) {
        const edit = el("button", "", "Edit");
        edit.type = "button";
        edit.addEventListener("click", () => fillConnectorForm(name, config));
        actions.appendChild(edit);

        const remove = el("button", "", "Delete");
        remove.type = "button";
        remove.addEventListener("click", async () => {
          if (!confirm(`Delete connector "${name}"?`)) return;
          try {
            const next = await bridge.mcpRemove(name);
            state.mcpData = next;
            updateMcp(next.servers || []);
            renderConnectors(next);
            resetConnectorForm();
          } catch (error) {
            showMcpError(error instanceof Error ? error.message : String(error));
          }
        });
        actions.appendChild(remove);
      }

      row.appendChild(actions);
      mcpListEl.appendChild(row);
    }
  }

  async function refreshConnectors() {
    try {
      const data = await bridge.mcpList();
      state.mcpData = data;
      if (data.path) state.mcpPath = data.path;
      updateMcp(data.servers || []);
      mcpPathEl.textContent = data.error
        ? `${data.path} — ${data.error}`
        : `Editing ${data.path}`;
      aboutMcp.textContent = data.path || "—";
      renderConnectors(data);
    } catch (error) {
      mcpPathEl.textContent = error instanceof Error ? error.message : String(error);
    }
  }

  function showMcpError(message) {
    mcpError.textContent = message;
    mcpError.hidden = false;
  }

  settingsBtn.addEventListener("click", () => openModal("general"));
  modalClose.addEventListener("click", closeModal);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal.hidden) closeModal();
  });
  for (const tab of document.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => selectTab(tab.dataset.tab));
  }
  mcpAdd.addEventListener("click", () => {
    resetConnectorForm();
    mcpForm.hidden = false;
    mcpName.focus();
  });
  mcpCancel.addEventListener("click", resetConnectorForm);
  mcpTransport.addEventListener("change", updateTransportSections);
  mcpAuth.addEventListener("change", updateAuthSections);
  mcpForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    mcpError.hidden = true;
    mcpSave.disabled = true;
    const label = mcpSave.textContent;
    mcpSave.textContent = "Saving…";
    try {
      const name = mcpName.value.trim();
      if (!name) throw new Error("Connector name is required.");
      const config = buildConnectorConfig();
      const data = await bridge.mcpSave(name, config);
      state.mcpData = data;
      state.mcpPath = data.path || state.mcpPath;
      updateMcp(data.servers || []);
      mcpPathEl.textContent = `Editing ${data.path}`;
      aboutMcp.textContent = data.path || "—";
      renderConnectors(data);
      resetConnectorForm();
    } catch (error) {
      showMcpError(error instanceof Error ? error.message : String(error));
    } finally {
      mcpSave.disabled = false;
      mcpSave.textContent = label;
    }
  });

  modelSelect.addEventListener("change", async () => {
    try {
      const result = await bridge.setState({ model: modelSelect.value });
      applyState(result);
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    }
  });

  modeSelect.addEventListener("change", async () => {
    try {
      const result = await bridge.setState({ mode: modeSelect.value });
      applyState(result);
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    }
  });

  async function init() {
    try {
      const settings = await bridge.getSettings();
      state.settings = { ...state.settings, ...settings };
      applyTheme(settings.theme || "system", false);
    } catch {
      // Settings are optional; localStorage already applied a theme.
    }
    try {
      const stateData = await bridge.getState();
      applyState(stateData);
      titleEl.textContent = state.title;
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    }
    try {
      const models = await bridge.getModels();
      populateModels(models, state.model);
    } catch (error) {
      addError(`Models unavailable: ${error instanceof Error ? error.message : error}`);
    }
    await refreshSessions();
    input.focus();
  }

  void init();
})();

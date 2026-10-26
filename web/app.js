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
  const agentsList = $("agents-list");
  const skillsList = $("skills-list");
  const checkpointsList = $("checkpoints-list");
  const checkpointReport = $("checkpoint-report");
  const aboutVersion = $("about-version");
  const aboutInstructions = $("about-instructions");
  const aboutUpdateStatus = $("about-update-status");
  const updateCheck = $("update-check");
  const updateInstall = $("update-install");
  const projectBtn = $("project-btn");
  const projectName = $("project-name");
  const artifactsBtn = $("artifacts-btn");
  const artifactsCount = $("artifact-count");
  const artifactsPanel = $("artifacts");
  const artifactsClose = $("artifacts-close");
  const artifactsList = $("artifacts-list");
  const artifactsPreview = $("artifacts-preview");
  const teamBtn = $("team-btn");
  const teamCount = $("team-count");
  const teamPanel = $("team-panel");
  const teamClose = $("team-close");
  const teamMembersEl = $("team-members");
  const teamTasksEl = $("team-tasks");
  const teamTranscriptEl = $("team-transcript");
  const teamTranscriptTitle = $("team-transcript-title");
  const teamMessageForm = $("team-message-form");
  const teamMessageInput = $("team-message-input");
  const teamMessageSend = $("team-message-send");
  const contextEl = $("context");
  const srStatus = $("sr-status");
  const dropOverlay = $("drop-overlay");

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
    stagedFiles: [],
    theme: "system",
    settings: { theme: "system", showThinking: true, model: "", mode: "default" },
    cwd: "",
    sessionFile: "",
    mcpPath: "",
    mcpData: { path: "", servers: [], configs: {} },
    version: "",
    projectInstructions: null,
    artifacts: new Map(),
    artifactPath: null,
    updater: null,
    team: null,
    teamSelected: null,
    teamTranscripts: new Map(),
    teamPoll: null,
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
    const prism = window.Prism;
    if (prism) {
      const aliases = {
        ts: "typescript",
        js: "javascript",
        sh: "bash",
        shell: "bash",
        yml: "yaml",
        md: "markdown",
        py: "python",
        rs: "rust",
      };
      container.querySelectorAll("pre > code").forEach((code) => {
        if (code.dataset.highlighted) return;
        const languageClass = [...code.classList].find((name) =>
          name.startsWith("language-"),
        );
        const language = languageClass
          ? languageClass.slice("language-".length)
          : "";
        if (!language) return;
        const resolved = aliases[language] || language;
        if (!prism.languages[resolved]) return;
        code.className = `language-${resolved}`;
        try {
          prism.highlightElement(code);
        } catch {
          // Highlighting is cosmetic; keep the plain code block.
        }
      });
    }

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
    node.innerHTML = "";
    const blocks =
      typeof window.renderMarkdownBlocks === "function"
        ? window.renderMarkdownBlocks(text)
        : [{ html: md(text) }];
    for (const block of blocks) {
      const wrapper = el("div", "md-block");
      wrapper.innerHTML = block.html;
      node.appendChild(wrapper);
      enhance(wrapper);
    }
  }

  function renderCurrentBlocks(target) {
    const blocks =
      typeof window.renderMarkdownBlocks === "function"
        ? window.renderMarkdownBlocks(target.text)
        : [{ html: md(target.text) }];
    if (!target.blocks) target.blocks = [];
    if (!target.htmls) target.htmls = [];
    while (target.blocks.length > blocks.length) {
      const node = target.blocks.pop();
      if (node) node.remove();
      target.htmls.pop();
    }
    blocks.forEach((block, index) => {
      let node = target.blocks[index];
      if (!node) {
        node = el("div", "md-block");
        node.innerHTML = block.html;
        target.mdEl.appendChild(node);
        target.blocks[index] = node;
        target.htmls[index] = block.html;
        enhance(node);
        return;
      }
      if (target.htmls[index] !== block.html) {
        node.innerHTML = block.html;
        target.htmls[index] = block.html;
        enhance(node);
      }
    });
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

  function addMessageActions(wrap, getText) {
    if (wrap.querySelector(".msg-actions")) return;
    const actions = el("div", "msg-actions");
    const copy = el("button", "", "Copy");
    copy.type = "button";
    copy.addEventListener("click", async () => {
      const ok = await copyText(getText() || "");
      copy.textContent = ok ? "Copied" : "Failed";
      setTimeout(() => {
        copy.textContent = "Copy";
      }, 1200);
    });
    actions.appendChild(copy);
    wrap.appendChild(actions);
  }

  function addUserMessage(text, images, files, scroll = true) {
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
    if (files && files.length > 0) {
      const list = el("div", "file-chips");
      for (const file of files) {
        const chip = el("div", "file-chip");
        chip.appendChild(el("span", "file-name", file.name || "file"));
        if (file.size) {
          chip.appendChild(el("span", "file-size", formatSize(file.size)));
        }
        list.appendChild(chip);
      }
      bubble.appendChild(list);
    }
    if (text) {
      bubble.appendChild(document.createTextNode(text));
    } else if (images && images.length > 0 && (!files || files.length === 0)) {
      bubble.appendChild(document.createTextNode("(image)"));
    }
    wrap.appendChild(bubble);
    addMessageActions(wrap, () => text);
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

  function approvalLines(tool, input) {
    const lines = [];
    if (!input || typeof input !== "object") return lines;
    if (tool === "Bash" && typeof input.command === "string") {
      lines.push(["", input.command]);
    } else if (tool === "Write" && typeof input.content === "string") {
      for (const line of input.content.split("\n").slice(0, 80)) {
        lines.push(["add", line]);
      }
    } else if (tool === "Edit" && typeof input.old_string === "string") {
      for (const line of input.old_string.split("\n")) lines.push(["del", line]);
      for (const line of String(input.new_string ?? "").split("\n")) {
        lines.push(["add", line]);
      }
    } else if (tool === "MultiEdit" && Array.isArray(input.edits)) {
      for (const edit of input.edits.slice(0, 10)) {
        for (const line of String(edit.old_string ?? "").split("\n")) {
          lines.push(["del", line]);
        }
        for (const line of String(edit.new_string ?? "").split("\n")) {
          lines.push(["add", line]);
        }
      }
    }
    return lines;
  }

  function buildApprovalPreview(tool, input) {
    const lines = approvalLines(tool, input);
    if (lines.length === 0) return null;
    const preview = el("div", "approval-preview");
    for (const [kind, line] of lines.slice(0, 140)) {
      const prefix = kind === "add" ? "+ " : kind === "del" ? "- " : "";
      preview.appendChild(
        el(
          "span",
          `line ${kind}`.trim(),
          prefix + (line.length > 300 ? `${line.slice(0, 300)}…` : line),
        ),
      );
    }
    if (lines.length > 140) {
      preview.appendChild(el("span", "line", `… ${lines.length - 140} more lines`));
    }
    return preview;
  }

  function addApproval(event) {
    const card = el("div", "approval");
    const text = el("div", "text");
    text.appendChild(el("strong", "", "Allow " + event.tool + "?"));
    if (event.summary) text.appendChild(el("span", "muted", event.summary));
    card.appendChild(text);

    const preview = buildApprovalPreview(event.tool, event.input);
    if (preview) card.appendChild(preview);

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
    clearArtifacts();
    clearContext();
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
        const files = blocks
          .filter((block) => block.type === "file")
          .map((file) => ({
            name: file.name,
            size: file.size,
            kind: file.kind,
            mimeType: file.mimeType,
          }));
        if (text || images.length > 0 || files.length > 0) {
          addUserMessage(text, images, files, false);
        }
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
          if (
            ["Write", "Edit", "MultiEdit"].includes(block.name) &&
            block.input &&
            typeof block.input.file_path === "string"
          ) {
            addArtifact(block.input.file_path);
          }
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
      if (wrap.childElementCount > 0) {
        const text = blocks
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n");
        addMessageActions(wrap, () => text);
        thread.appendChild(wrap);
      }
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
      blocks: [],
      htmls: [],
    };
    return current;
  }

  function scheduleRender() {
    if (!current || current.scheduled) return;
    current.scheduled = true;
    requestAnimationFrame(() => {
      if (!current) return;
      current.scheduled = false;
      renderCurrentBlocks(current);
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
        if (
          ["Write", "Edit", "MultiEdit"].includes(data.name) &&
          data.input &&
          typeof data.input.file_path === "string"
        ) {
          addArtifact(data.input.file_path);
        }
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
      case "update_status":
        renderUpdater(data);
        break;
      case "team_event":
        handleTeamEvent(data.event);
        break;
      case "approval":
        announce(`Approval needed for ${data.tool}.`);
        addApproval(data);
        break;
      case "plan_approval":
        announce("Plan approval needed.");
        addPlanApproval(data);
        break;
      case "subagent_start":
        addNotice(`subagent ${data.name} (${data.subagentType}) · ${data.description}`);
        break;
      case "subagent_end":
        addNotice(`subagent ${data.name} ${data.ok ? "finished" : "failed"}`);
        break;
      case "error":
        if (!/abort/i.test(String(data.message || ""))) {
          addError(data.message);
          announce(`Error: ${data.message}`);
        }
        break;
      case "done":
        if (data && typeof data.used === "number") {
          setContext(data.used, data.budget);
        }
        break;
      case "step":
      case "usage":
        break;
    }
  }

  /* ---------- attachments ---------- */

  const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
  const MAX_FILE_BYTES = 1_000_000;
  const MAX_PDF_BYTES = 10 * 1024 * 1024;
  const MAX_ATTACHMENTS = 8;
  const TEXT_EXTENSIONS = new Set([
    "txt", "md", "markdown", "json", "jsonc", "yaml", "yml", "toml", "ini",
    "csv", "tsv", "log", "xml", "html", "htm", "css", "scss", "less", "js",
    "mjs", "cjs", "jsx", "ts", "tsx", "py", "rb", "go", "rs", "java", "kt",
    "c", "h", "cc", "cpp", "hpp", "cs", "php", "sh", "bash", "zsh", "fish",
    "sql", "graphql", "gql", "env",
  ]);

  function isPdfFile(file) {
    return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  }

  function isTextFile(file) {
    if (file.type.startsWith("text/")) return true;
    if (
      [
        "application/json",
        "application/xml",
        "application/javascript",
        "application/x-yaml",
        "application/yaml",
        "application/toml",
      ].includes(file.type)
    ) {
      return true;
    }
    const match = /\.([A-Za-z0-9]+)$/.exec(file.name);
    const extension = match ? match[1].toLowerCase() : "";
    return (
      TEXT_EXTENSIONS.has(extension) ||
      ["dockerfile", "makefile", "readme", "license", "changelog"].includes(
        file.name.toLowerCase(),
      )
    );
  }

  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Could not read " + file.name));
      reader.onload = () => resolve(String(reader.result));
      reader.readAsDataURL(file);
    });
  }

  async function readAttachment(file) {
    if (file.type.startsWith("image/")) {
      if (file.size > MAX_IMAGE_BYTES) {
        throw new Error(file.name + " is larger than 10 MB.");
      }
      const dataUrl = await readAsDataUrl(file);
      const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
      if (!match) throw new Error("Unsupported image encoding.");
      return {
        kind: "image",
        data: match[2],
        mimeType: match[1],
        name: file.name,
        dataUrl,
      };
    }

    if (isPdfFile(file)) {
      if (file.size > MAX_PDF_BYTES) {
        throw new Error(file.name + " is larger than 10 MB.");
      }
      const dataUrl = await readAsDataUrl(file);
      const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
      if (!match) throw new Error("Unsupported PDF encoding.");
      return {
        kind: "pdf",
        data: match[2],
        mimeType: "application/pdf",
        name: file.name,
        size: file.size,
      };
    }

    if (isTextFile(file)) {
      if (file.size > MAX_FILE_BYTES) {
        throw new Error(file.name + " is larger than 1 MB.");
      }
      const content = await file.text();
      return {
        kind: "text",
        content,
        mimeType: file.type || "text/plain",
        name: file.name,
        size: file.size,
      };
    }

    throw new Error(
      `Unsupported file type: ${file.name}. Attach images, PDFs, or text/code files.`,
    );
  }

  function formatSize(bytes) {
    if (!bytes) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
    state.stagedFiles.forEach((file, index) => {
      const chip = el("div", "chip file-chip");
      chip.appendChild(el("span", "file-name", file.name));
      chip.appendChild(el("span", "file-size", formatSize(file.size)));
      const remove = el("button", "", "×");
      remove.type = "button";
      remove.title = "Remove";
      remove.addEventListener("click", () => {
        state.stagedFiles.splice(index, 1);
        renderPreviews();
      });
      chip.appendChild(remove);
      previews.appendChild(chip);
    });
  }

  async function addFiles(files) {
    for (const file of files) {
      const image = file.type.startsWith("image/");
      if (image && state.stagedImages.length >= MAX_ATTACHMENTS) {
        addError(`At most ${MAX_ATTACHMENTS} images per message.`);
        break;
      }
      if (!image && state.stagedFiles.length >= MAX_ATTACHMENTS) {
        addError(`At most ${MAX_ATTACHMENTS} files per message.`);
        break;
      }
      try {
        const attachment = await readAttachment(file);
        if (attachment.kind === "image") state.stagedImages.push(attachment);
        else state.stagedFiles.push(attachment);
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
    const files = Array.from((event.clipboardData && event.clipboardData.files) || []);
    if (files.length > 0) {
      event.preventDefault();
      void addFiles(files);
    }
  });

  let dragDepth = 0;

  function hasFiles(event) {
    try {
      return Array.from((event.dataTransfer && event.dataTransfer.types) || []).includes(
        "Files",
      );
    } catch {
      return false;
    }
  }

  window.addEventListener("dragenter", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    dropOverlay.hidden = false;
  });
  window.addEventListener("dragover", (event) => {
    if (hasFiles(event)) event.preventDefault();
  });
  window.addEventListener("dragleave", () => {
    if (dropOverlay.hidden) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropOverlay.hidden = true;
  });
  window.addEventListener("dragend", () => {
    dragDepth = 0;
    dropOverlay.hidden = true;
  });
  window.addEventListener("drop", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    dropOverlay.hidden = true;
    const files = Array.from((event.dataTransfer && event.dataTransfer.files) || []);
    if (files.length > 0) void addFiles(files);
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
        clearArtifacts();
        clearContext();
        setHasChat(false);
      }
      await refreshSessions();
      void refreshTeam();
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
      void refreshTeam();
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
      clearArtifacts();
      clearContext();
      state.stagedImages = [];
      state.stagedFiles = [];
      renderPreviews();
      setHasChat(false);
      await refreshSessions();
      void refreshTeam();
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

  function setContext(used, budget) {
    if (
      typeof used !== "number" ||
      typeof budget !== "number" ||
      budget <= 0
    ) {
      clearContext();
      return;
    }
    const format = (value) =>
      value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
    contextEl.textContent = `ctx ${format(used)} / ${format(budget)}`;
    contextEl.title = `${used} of ${budget} tokens used (estimated)`;
    contextEl.classList.toggle("warn", used / budget > 0.85);
  }

  function clearContext() {
    contextEl.textContent = "";
    contextEl.title = "";
    contextEl.classList.remove("warn");
  }

  function announce(text) {
    if (!srStatus) return;
    srStatus.textContent = "";
    setTimeout(() => {
      srStatus.textContent = text;
    }, 40);
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

  async function runTurn(text, images = [], files = []) {
    if (state.running) return;
    if (!text && images.length === 0 && files.length === 0) return;

    setRunning(true);
    addUserMessage(text, images, files);
    startAssistant();

    try {
      const result = await bridge.chat(
        text,
        images.map(({ data, mimeType, name }) => ({ data, mimeType, name })),
        files.map(({ name, mimeType, content, data, size }) => ({
          name,
          mimeType,
          content,
          data,
          size,
        })),
        handleEvent,
      );
      const context =
        result && (result.context || (typeof result.used === "number" ? result : undefined));
      if (context && typeof context.used === "number") {
        setContext(context.used, context.budget);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/abort/i.test(message)) addError(message);
    } finally {
      if (current) {
        const finished = current;
        renderCurrentBlocks(finished);
        addMessageActions(finished.wrap, () => finished.text);
        scrollIfNear();
      }
      current = null;
      setRunning(false);
      announce("Response complete.");
      window.__agentTurns = (window.__agentTurns || 0) + 1;
      void refreshSessions();
      input.focus();
    }
  }

  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (
      !text &&
      state.stagedImages.length === 0 &&
      state.stagedFiles.length === 0
    ) {
      return;
    }
    const images = state.stagedImages.slice();
    const files = state.stagedFiles.slice();
    state.stagedImages = [];
    state.stagedFiles = [];
    renderPreviews();
    input.value = "";
    autoGrow();
    void runTurn(text, images, files);
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
    if (data.cwd) {
      state.cwd = data.cwd;
      updateProjectLabel();
    }
    if (data.version) {
      state.version = String(data.version);
      aboutVersion.textContent = state.version;
    }
    if (data.projectInstructions !== undefined) {
      state.projectInstructions = data.projectInstructions;
    }
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

  /* ---------- project, artifacts, updates ---------- */

  function updateProjectLabel() {
    const parts = String(state.cwd || "")
      .split(/[\\/]/)
      .filter(Boolean);
    projectName.textContent = parts.length > 0 ? parts[parts.length - 1] : "…";
    projectBtn.title = state.cwd || "Change project folder";
  }

  async function chooseProject() {
    if (state.running) {
      addNotice("Stop the current turn before switching projects.");
      return;
    }
    let target;
    try {
      target = bridge.pickProject
        ? await bridge.pickProject()
        : window.prompt("Project folder", state.cwd || "");
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
      return;
    }
    if (!target) return;
    try {
      const data = await bridge.setProject(target);
      applyState(data);
      state.sessionId = sessionIdFromPath(data.session) || state.sessionId;
      state.title = "New chat";
      titleEl.textContent = state.title;
      thread.innerHTML = "";
      clearArtifacts();
      clearContext();
      state.stagedImages = [];
      state.stagedFiles = [];
      renderPreviews();
      setHasChat(false);
      await refreshSessions();
      void refreshTeam();
      input.focus();
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    }
  }

  function relativePath(filePath) {
    if (!filePath) return "";
    const root = String(state.cwd || "").replace(/[\\/]+$/, "");
    if (root && (filePath === root || filePath.startsWith(`${root}/`) || filePath.startsWith(`${root}\\`))) {
      return filePath.slice(root.length + 1);
    }
    return filePath;
  }

  function addArtifact(filePath) {
    if (typeof filePath !== "string" || !filePath) return;
    if (!state.artifacts.has(filePath)) {
      state.artifacts.set(filePath, { path: filePath });
      renderArtifactList();
    }
    updateArtifactsButton();
  }

  function updateArtifactsButton() {
    const count = state.artifacts.size;
    artifactsCount.textContent = String(count);
    artifactsBtn.hidden = count === 0;
    if (count === 0 && !artifactsPanel.hidden) setArtifactsOpen(false);
  }

  function setArtifactsOpen(open) {
    if (open && teamPanel && !teamPanel.hidden) setTeamOpen(false);
    artifactsPanel.hidden = !open;
    document.body.classList.toggle("artifacts-open", open);
    if (open) renderArtifactList();
  }

  function renderArtifactList() {
    artifactsList.innerHTML = "";
    const items = [...state.artifacts.values()].sort((a, b) =>
      relativePath(a.path).localeCompare(relativePath(b.path)),
    );
    if (items.length === 0) {
      artifactsList.appendChild(el("div", "artifacts-empty", "No files yet."));
      return;
    }
    for (const item of items) {
      const row = el(
        "div",
        `artifact-item${item.path === state.artifactPath ? " active" : ""}`,
      );
      const relative = relativePath(item.path);
      const parts = relative.split(/[\\/]/);
      row.appendChild(el("div", "file-name", parts[parts.length - 1]));
      row.appendChild(el("div", "file-path", relative));
      row.addEventListener("click", () => void previewArtifact(item.path));
      artifactsList.appendChild(row);
    }
  }

  async function previewArtifact(filePath) {
    state.artifactPath = filePath;
    renderArtifactList();
    artifactsPreview.textContent = "Loading…";
    try {
      const file = await bridge.readFile(filePath);
      artifactsPreview.textContent =
        file.content + (file.truncated ? "\n\n[truncated]" : "");
    } catch (error) {
      artifactsPreview.textContent =
        error instanceof Error ? error.message : String(error);
    }
  }

  function clearArtifacts() {
    state.artifacts = new Map();
    state.artifactPath = null;
    artifactsPreview.textContent = "Select a file to preview.";
    renderArtifactList();
    updateArtifactsButton();
  }

  /* ---------- team ---------- */

  function setTeamOpen(open) {
    if (open && !artifactsPanel.hidden) setArtifactsOpen(false);
    teamPanel.hidden = !open;
    document.body.classList.toggle("team-open", open);
    if (open) {
      renderTeam();
      if (state.teamPoll) clearInterval(state.teamPoll);
      state.teamPoll = setInterval(() => {
        void refreshTeam();
      }, 1800);
    } else if (state.teamPoll) {
      clearInterval(state.teamPoll);
      state.teamPoll = null;
    }
  }

  async function refreshTeam() {
    try {
      const data = await bridge.teamStatus();
      if (data && data.team) {
        state.team = data.team;
        renderTeam();
      }
    } catch {
      // Team status is best-effort.
    }
  }

  function renderTeam() {
    const team = state.team;
    const members = team ? team.members : [];
    teamCount.textContent = String(members.length);
    teamBtn.hidden = members.length === 0;
    teamMembersEl.innerHTML = "";
    teamTasksEl.innerHTML = "";
    if (!team || members.length === 0) {
      state.teamSelected = null;
      teamTranscriptTitle.textContent = "Transcript";
      teamTranscriptEl.textContent = "Select a teammate.";
      teamMessageInput.placeholder = "Message selected teammate…";
      teamMembersEl.appendChild(
        el("div", "artifacts-empty", "No team yet. Ask the lead to spawn teammates."),
      );
      return;
    }

    for (const member of members) {
      const row = el(
        "div",
        `team-member${member.name === state.teamSelected ? " selected" : ""}`,
      );
      row.appendChild(el("span", `team-dot ${member.status}`, ""));
      const main = el("div", "team-member-main");
      main.appendChild(el("div", "team-member-name", member.name));
      const task = (team.tasks || []).find((entry) => entry.id === member.currentTaskId);
      const sub = [
        member.role,
        member.model,
        member.status,
        member.mergedAt ? "· merged" : member.worktreePath ? "· worktree" : "",
        task ? `· ${task.title}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      main.appendChild(el("div", "team-member-sub", sub));
      row.appendChild(main);

      const actions = el("div", "team-member-actions");
      const view = el("button", "", "View");
      view.type = "button";
      view.addEventListener("click", (event) => {
        event.stopPropagation();
        void selectTeamMember(member.name);
      });
      actions.appendChild(view);
      if (member.branch && member.worktreePath && bridge.teamReview) {
        const review = el("button", "", "Review");
        review.type = "button";
        review.title = member.branch;
        review.addEventListener("click", async (event) => {
          event.stopPropagation();
          review.disabled = true;
          try {
            const data = await bridge.teamReview(member.name, false);
            state.teamSelected = member.name;
            teamTranscriptTitle.textContent = `Review — ${member.name}`;
            teamTranscriptEl.textContent = data.report || data.error || "No report.";
            renderTeam();
          } catch (error) {
            addError(error instanceof Error ? error.message : String(error));
          } finally {
            review.disabled = false;
          }
        });
        actions.appendChild(review);
      }
      if (member.status !== "offline") {
        const stop = el("button", "", "Stop");
        stop.type = "button";
        stop.addEventListener("click", async (event) => {
          event.stopPropagation();
          stop.disabled = true;
          try {
            const data = await bridge.teamStop(member.name);
            if (data.team) {
              state.team = data.team;
              renderTeam();
            }
          } catch (error) {
            addError(error instanceof Error ? error.message : String(error));
          }
        });
        actions.appendChild(stop);
      }
      row.appendChild(actions);
      row.addEventListener("click", () => void selectTeamMember(member.name));
      teamMembersEl.appendChild(row);
    }

    const tasks = team.tasks || [];
    if (tasks.length === 0) {
      teamTasksEl.appendChild(el("div", "artifacts-empty", "No tasks."));
    }
    for (const task of tasks) {
      const row = el("div", "team-task");
      const tone =
        task.status === "completed" ? " ok" : task.status === "blocked" ? " bad" : "";
      row.appendChild(el("span", `badge${tone}`, task.status));
      row.appendChild(el("span", "", task.title));
      if (task.assignee) {
        row.appendChild(el("span", "team-member-sub", `@${task.assignee}`));
      }
      teamTasksEl.appendChild(row);
    }
  }

  async function selectTeamMember(name) {
    state.teamSelected = name;
    teamTranscriptTitle.textContent = `Transcript — ${name}`;
    teamMessageInput.placeholder = `Message ${name}…`;
    renderTeam();
    await refreshTeamTranscript(name);
  }

  async function refreshTeamTranscript(name) {
    try {
      const data = await bridge.teamTranscript(name);
      const text = formatTeamMessages(data.messages || []);
      state.teamTranscripts.set(name, text);
      if (state.teamSelected === name) {
        teamTranscriptEl.textContent = text || "(no transcript yet)";
        teamTranscriptEl.scrollTop = teamTranscriptEl.scrollHeight;
      }
    } catch (error) {
      state.teamTranscripts.set(
        name,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  function formatTeamMessages(messages) {
    const parts = [];
    for (const message of messages) {
      if (message.role === "user") {
        const text = message.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n")
          .trim();
        if (text) parts.push(`→ ${text}`);
      } else if (message.role === "assistant") {
        for (const block of message.content) {
          if (block.type === "text" && block.text.trim()) {
            parts.push(block.text.trim());
          } else if (block.type === "tool_use") {
            parts.push(`[tool] ${block.name}`);
          }
        }
      }
    }
    return parts.join("\n\n");
  }

  function handleTeamEvent(event) {
    if (!event || typeof event !== "object") return;
    if (event.type === "team_state") {
      const previous = state.teamStatuses || new Map();
      state.teamStatuses = new Map(
        (event.state.members || []).map((member) => [member.name, member.status]),
      );
      state.team = event.state;
      renderTeam();
      if (state.teamSelected) {
        const before = previous.get(state.teamSelected);
        const after = state.teamStatuses.get(state.teamSelected);
        if (before === "running" && after && after !== "running") {
          void refreshTeamTranscript(state.teamSelected);
        }
        if (!after) {
          state.teamSelected = null;
          teamTranscriptTitle.textContent = "Transcript";
          teamTranscriptEl.textContent = "Select a teammate.";
        }
      }
      return;
    }
    if (event.type === "notice") {
      addNotice(event.text);
      return;
    }
    if (event.type !== "stream") return;

    const name = event.agent;
    let buffer = state.teamTranscripts.get(name) || "";
    if (event.kind === "text") buffer += event.text || "";
    else if (event.kind === "tool_start") {
      buffer += `\n[${event.name}${event.summary ? `: ${event.summary}` : ""}]\n`;
    } else if (event.kind === "tool_end") {
      buffer += `${(event.content || "").slice(0, 600)}${event.isError ? " [error]" : ""}\n`;
    } else if (event.kind === "error") {
      buffer += `\n[error] ${event.content || ""}\n`;
    } else if (event.kind === "done") {
      buffer += "\n";
    }
    state.teamTranscripts.set(name, buffer);
    if (state.teamSelected === name && !teamPanel.hidden) {
      teamTranscriptEl.textContent = buffer || "(no transcript yet)";
      teamTranscriptEl.scrollTop = teamTranscriptEl.scrollHeight;
    }
  }

  teamBtn.addEventListener("click", () => setTeamOpen(teamPanel.hidden));
  teamClose.addEventListener("click", () => setTeamOpen(false));
  teamMessageForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.teamSelected) return;
    const text = teamMessageInput.value.trim();
    if (!text) return;
    teamMessageSend.disabled = true;
    try {
      const data = await bridge.teamMessage(state.teamSelected, text);
      if (data.team) {
        state.team = data.team;
        renderTeam();
      }
      teamMessageInput.value = "";
      await refreshTeamTranscript(state.teamSelected);
      setTeamOpen(true);
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    } finally {
      teamMessageSend.disabled = false;
    }
  });

  function renderUpdater(status) {
    if (!status || typeof status !== "object") return;
    state.updater = status;
    if (status.currentVersion) {
      state.version = status.currentVersion;
      aboutVersion.textContent = status.currentVersion;
    }
    let text = "";
    switch (status.state) {
      case "checking":
        text = "Checking for updates…";
        break;
      case "available":
        text = `Update available: v${status.version || "?"} — downloading…`;
        break;
      case "downloading":
        text = `Downloading update… ${status.percent ?? 0}%`;
        break;
      case "downloaded":
        text = `Update v${status.version || ""} ready. Restart to install.`;
        break;
      case "not-available":
        text = `Up to date (v${status.currentVersion || state.version}).`;
        break;
      case "error":
        text = `Update check failed: ${status.error || "unknown error"}`;
        break;
      default:
        text =
          status.packaged === false
            ? "Development build — use the packaged app for automatic updates."
            : "";
    }
    aboutUpdateStatus.textContent = text;
    updateInstall.hidden = !(
      status.state === "downloaded" && status.packaged !== false
    );
    settingsBtn.textContent =
      status.state === "available" || status.state === "downloaded"
        ? "Settings •"
        : "Settings";
  }

  function renderCheck(info) {
    if (!info) return;
    if (info.currentVersion) {
      state.version = info.currentVersion;
      aboutVersion.textContent = info.currentVersion;
    }
    if (info.error) {
      aboutUpdateStatus.textContent = `Could not check: ${info.error}`;
    } else if (info.available) {
      aboutUpdateStatus.textContent = `Update available: v${info.latestVersion} (current v${info.currentVersion}).`;
    } else {
      aboutUpdateStatus.textContent = `Up to date (v${info.currentVersion}).`;
    }
    if (info.updater) {
      const updater = {
        ...info.updater,
        currentVersion: info.currentVersion,
        packaged: info.packaged,
      };
      const meaningful = ["available", "downloading", "downloaded", "error"].includes(
        updater.state,
      );
      if (meaningful) {
        renderUpdater(updater);
      } else {
        state.updater = updater;
        updateInstall.hidden = true;
        settingsBtn.textContent = "Settings";
      }
    } else {
      updateInstall.hidden = true;
    }
  }

  async function refreshUpdateStatus() {
    try {
      renderUpdater(await bridge.updateStatus());
    } catch {
      // Status is best effort.
    }
  }

  projectBtn.addEventListener("click", () => void chooseProject());
  artifactsBtn.addEventListener("click", () => setArtifactsOpen(artifactsPanel.hidden));
  artifactsClose.addEventListener("click", () => setArtifactsOpen(false));
  updateCheck.addEventListener("click", async () => {
    updateCheck.disabled = true;
    const label = updateCheck.textContent;
    updateCheck.textContent = "Checking…";
    try {
      renderCheck(await bridge.checkForUpdates());
    } catch (error) {
      aboutUpdateStatus.textContent =
        error instanceof Error ? error.message : String(error);
    } finally {
      updateCheck.disabled = false;
      updateCheck.textContent = label;
    }
  });
  updateInstall.addEventListener("click", async () => {
    updateInstall.disabled = true;
    try {
      await bridge.installUpdate();
    } catch (error) {
      aboutUpdateStatus.textContent =
        error instanceof Error ? error.message : String(error);
      updateInstall.disabled = false;
    }
  });

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
    if (name === "agents") void refreshAgents();
    if (name === "rewind") void refreshCheckpoints();
    if (name === "about") fillAbout();
  }

  async function refreshAgents() {
    agentsList.innerHTML = "";
    if (skillsList) skillsList.innerHTML = "";
    try {
      const data = await bridge.listAgents();
      for (const agent of data.agents || []) {
        const row = el("div", "connector");
        const main = el("div", "connector-main");
        const title = el("div", "connector-name");
        title.appendChild(document.createTextNode(agent.name));
        title.appendChild(
          el("span", `badge${agent.builtin ? "" : " ok"}`, agent.builtin ? "builtin" : "custom"),
        );
        main.appendChild(title);
        main.appendChild(el("div", "connector-sub", agent.description));
        const meta = [];
        if (agent.model) meta.push(`model: ${agent.model}`);
        if (agent.permissionMode) meta.push(`mode: ${agent.permissionMode}`);
        if (agent.tools && agent.tools.length > 0) {
          meta.push(`${agent.tools.length} tools`);
        }
        if (agent.isolation) meta.push(`isolation: ${agent.isolation}`);
        if (meta.length > 0) {
          main.appendChild(el("div", "connector-sub", meta.join(" · ")));
        }
        if (!agent.builtin) {
          main.appendChild(el("div", "connector-sub", agent.source));
        }
        row.appendChild(main);
        agentsList.appendChild(row);
      }

      if (skillsList) {
        const skills = data.skills || [];
        if (skills.length === 0) {
          skillsList.appendChild(el("div", "artifacts-empty", "No skills found."));
        }
        for (const skill of skills) {
          const row = el("div", "connector");
          const main = el("div", "connector-main");
          const title = el("div", "connector-name");
          title.appendChild(document.createTextNode(skill.name));
          main.appendChild(title);
          main.appendChild(el("div", "connector-sub", skill.description));
          const meta = [];
          if (skill.files && skill.files.length > 0) {
            meta.push(`${skill.files.length} files`);
          }
          if (skill.source) meta.push(skill.source);
          if (meta.length > 0) {
            main.appendChild(el("div", "connector-sub", meta.join(" · ")));
          }
          row.appendChild(main);
          skillsList.appendChild(row);
        }
      }
    } catch (error) {
      agentsList.appendChild(
        el("div", "connector-error", error instanceof Error ? error.message : String(error)),
      );
    }
  }

  async function refreshCheckpoints() {
    if (!checkpointsList) return;
    checkpointsList.innerHTML = "";
    try {
      const data = await bridge.listCheckpoints();
      const checkpoints = data.checkpoints || [];
      if (checkpoints.length === 0) {
        checkpointsList.appendChild(
          el("div", "artifacts-empty", "No checkpoints in this session yet."),
        );
        return;
      }
      for (const checkpoint of checkpoints) {
        const row = el("div", "connector");
        const main = el("div", "connector-main");
        const title = el("div", "connector-name");
        title.appendChild(document.createTextNode(checkpoint.id));
        main.appendChild(title);
        main.appendChild(
          el(
            "div",
            "connector-sub",
            `${checkpoint.at.replace("T", " ").slice(0, 19)} · ${checkpoint.tool}`,
          ),
        );
        main.appendChild(
          el("div", "connector-sub", checkpoint.files.join(", ")),
        );
        const restore = el("button", "", "Restore");
        restore.type = "button";
        restore.addEventListener("click", async () => {
          if (
            !confirm(
              `Restore ${checkpoint.id}? Files touched by ${checkpoint.tool} will revert.`,
            )
          ) {
            return;
          }
          restore.disabled = true;
          try {
            const result = await bridge.restoreCheckpoint(checkpoint.id);
            if (checkpointReport) {
              checkpointReport.hidden = false;
              checkpointReport.textContent = result.report || "";
            }
            await refreshCheckpoints();
          } catch (error) {
            addError(error instanceof Error ? error.message : String(error));
          } finally {
            restore.disabled = false;
          }
        });
        row.appendChild(main);
        row.appendChild(restore);
        checkpointsList.appendChild(row);
      }
    } catch (error) {
      checkpointsList.appendChild(
        el("div", "connector-error", error instanceof Error ? error.message : String(error)),
      );
    }
  }

  function fillAbout() {
    aboutCwd.textContent = state.cwd || "—";
    aboutSession.textContent = state.sessionFile || "—";
    aboutMcp.textContent = state.mcpPath || "—";
    aboutVersion.textContent = state.version || "—";
    aboutInstructions.textContent = state.projectInstructions || "none";
    void refreshUpdateStatus();
  }

  let lastFocus = null;

  function backgroundInert(value) {
    const sidebar = $("sidebar");
    const main = document.querySelector(".main");
    if (sidebar) sidebar.inert = value;
    if (main) main.inert = value;
  }

  function openModal(tab) {
    if (modal.hidden) lastFocus = document.activeElement;
    modal.hidden = false;
    backgroundInert(true);
    resetConnectorForm();
    selectTab(tab || "general");
    void loadSettingsPanel();
    void refreshConnectors();
    fillAbout();
    requestAnimationFrame(() => modalClose.focus());
  }

  function closeModal() {
    modal.hidden = true;
    backgroundInert(false);
    if (lastFocus && typeof lastFocus.focus === "function") {
      lastFocus.focus();
    }
    lastFocus = null;
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
    if (!modal.hidden) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeModal();
        return;
      }
      if (event.key === "Tab") {
        const focusables = [
          ...modal.querySelectorAll(
            'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])',
          ),
        ].filter((node) => !node.disabled && node.offsetParent !== null);
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
      return;
    }

    const mod = event.metaKey || event.ctrlKey;
    if (!mod) return;
    const key = event.key.toLowerCase();
    if (key === "k") {
      event.preventDefault();
      if (document.body.classList.contains("sidebar-collapsed")) setCollapsed(false);
      searchEl.focus();
      searchEl.select();
    } else if (key === "n") {
      event.preventDefault();
      void newChat();
    } else if (event.key === ",") {
      event.preventDefault();
      openModal("general");
    }
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
      updateProjectLabel();
      updateArtifactsButton();
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
    void refreshTeam();
    input.focus();
  }

  void init();
})();

// Renderer for both the Electron shell (IPC bridge) and the browser
// (HTTP/SSE bridge). Keep DOM logic here; transport lives in the bridges.
(function () {
  const bridge = window.agentBridge;
  const log = document.getElementById("log");
  const input = document.getElementById("input");
  const send = document.getElementById("send");
  const modelSelect = document.getElementById("model");
  const modeSelect = document.getElementById("mode");
  const mcpLabel = document.getElementById("mcp");
  const attachButton = document.getElementById("attach");
  const fileInput = document.getElementById("file");
  const previews = document.getElementById("previews");
  let running = false;
  let stagedImages = [];

  if (!bridge) {
    log.appendChild(el("div", "notice error", "No agent bridge available. Start the Electron app or src/server.ts."));
    return;
  }

  // Used by the Electron smoke test to prove the page scripts executed.
  window.__agentAppLoaded = true;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function scrollIfNearBottom() {
    if (log.scrollHeight - log.scrollTop - log.clientHeight < 160) {
      log.scrollTop = log.scrollHeight;
    }
  }

  function addUser(text, images) {
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
    else if (images && images.length > 0) bubble.appendChild(document.createTextNode("(image)"));
    wrap.appendChild(bubble);
    log.appendChild(wrap);
    scrollIfNearBottom();
  }

  function addAssistant() {
    const wrap = el("div", "msg assistant");
    const bubble = el("div", "bubble");
    wrap.appendChild(bubble);
    log.appendChild(wrap);
    return bubble;
  }

  function addTool(name, summary) {
    const details = el("details", "tool");
    const head = el("summary");
    head.appendChild(el("span", "name", name));
    if (summary) head.appendChild(el("span", "arg", summary));
    details.appendChild(head);
    const pre = el("pre", "", "running…");
    details.appendChild(pre);
    details.open = true;
    log.appendChild(details);
    scrollIfNearBottom();
    return { details, pre };
  }

  function addThinking() {
    const details = el("details", "thinking");
    details.appendChild(el("summary", "", "thinking"));
    const pre = el("pre");
    details.appendChild(pre);
    log.appendChild(details);
    return pre;
  }

  function addNotice(text) {
    log.appendChild(el("div", "notice", text));
    scrollIfNearBottom();
  }

  function addError(text) {
    log.appendChild(el("div", "notice error", text));
    scrollIfNearBottom();
  }

  function addApproval(event) {
    const card = el("div", "approval");
    const text = el("div", "text");
    text.appendChild(el("strong", "", "Allow " + event.tool + "? "));
    if (event.summary) text.appendChild(el("span", "muted", event.summary));
    card.appendChild(text);

    const buttons = [];
    const decide = async (decision) => {
      buttons.forEach((button) => (button.disabled = true));
      try {
        await bridge.approve(event.id, decision);
        card.appendChild(el("span", "done", decision === "deny" ? "denied" : decision));
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
      card.appendChild(button);
    }
    log.appendChild(card);
    scrollIfNearBottom();
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
        card.appendChild(el("span", "done", approved ? "approved" : "rejected"));
        actions.remove();
        feedback.disabled = true;
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

    log.appendChild(card);
    scrollIfNearBottom();
  }

  async function loadState() {
    const [state, models] = await Promise.all([bridge.getState(), bridge.getModels()]);
    modelSelect.innerHTML = "";
    for (const entry of models.models ?? []) {
      const option = el("option", "", entry.name);
      option.value = entry.name;
      modelSelect.appendChild(option);
    }
    if (state.model) modelSelect.value = state.model;
    modeSelect.value = state.mode;
    const servers = state.mcp ?? [];
    mcpLabel.textContent = servers.length
      ? "mcp " + servers.filter((server) => server.ok).length + "/" + servers.length
      : "";
  }

  async function updateState(patch) {
    try {
      await bridge.setState(patch);
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    }
  }

  modelSelect.addEventListener("change", () => updateState({ model: modelSelect.value }));
  modeSelect.addEventListener("change", () => updateState({ mode: modeSelect.value }));

  function handleEvent(event, data, target) {
    switch (event) {
      case "start":
        return;
      case "text":
        target.bubble.textContent += data.text;
        break;
      case "thinking":
        if (!target.thinking) target.thinking = addThinking();
        target.thinking.textContent += data.text;
        break;
      case "tool_start":
        target.currentTool = addTool(data.name, data.summary);
        break;
      case "tool_end":
        if (target.currentTool) {
          target.currentTool.pre.textContent = data.content || "(no output)";
          if (data.isError) target.currentTool.details.classList.add("error");
          target.currentTool = null;
        }
        break;
      case "notice":
        addNotice(data.text);
        break;
      case "subagent_start":
        addNotice(
          "subagent " + data.name + " (" + data.subagentType + ") · " + data.description,
        );
        break;
      case "subagent_end":
        addNotice("subagent " + data.name + (data.ok ? " finished" : " failed"));
        break;
      case "error":
        addError(data.message);
        break;
      case "approval":
        addApproval(data);
        break;
      case "plan_approval":
        addPlanApproval(data);
        break;
      case "step":
        break;
      case "update":
        addNotice(
          "update " + data.status + (data.version ? " · " + data.version : ""),
        );
        break;
      case "done":
        if (data && data.used !== undefined) {
          addNotice("context ~" + data.used + " / " + data.budget + " tokens");
        }
        break;
    }
    scrollIfNearBottom();
  }

  async function runTurn(text, images = []) {
    if (running) return;
    running = true;
    send.disabled = true;
    addUser(text, images);
    const target = { bubble: addAssistant(), thinking: null, currentTool: null };
    try {
      await bridge.chat(
        text,
        images.map(({ data, mimeType, name }) => ({ data, mimeType, name })),
        (event, data) => handleEvent(event, data, target),
      );
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    } finally {
      running = false;
      send.disabled = false;
      input.focus();
    }
  }

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
    stagedImages.forEach((image, index) => {
      const chip = el("div", "chip");
      const img = document.createElement("img");
      img.src = image.dataUrl;
      img.alt = image.name || "image";
      const remove = el("button", "", "×");
      remove.type = "button";
      remove.title = "Remove";
      remove.addEventListener("click", () => {
        stagedImages.splice(index, 1);
        renderPreviews();
      });
      chip.append(img, remove);
      previews.appendChild(chip);
    });
  }

  async function addFiles(files) {
    for (const file of files) {
      if (stagedImages.length >= 8) {
        addError("At most 8 images per message.");
        break;
      }
      try {
        stagedImages.push(await readFileAsAttachment(file));
      } catch (error) {
        addError(error instanceof Error ? error.message : String(error));
      }
    }
    renderPreviews();
  }

  attachButton.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const files = Array.from(fileInput.files ?? []);
    fileInput.value = "";
    if (files.length > 0) void addFiles(files);
  });
  input.addEventListener("paste", (event) => {
    const files = Array.from(event.clipboardData?.files ?? []).filter((file) =>
      file.type.startsWith("image/"),
    );
    if (files.length > 0) {
      event.preventDefault();
      void addFiles(files);
    }
  });

  document.getElementById("composer").addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    const images = stagedImages;
    stagedImages = [];
    renderPreviews();
    input.value = "";
    runTurn(text, images);
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      document.getElementById("composer").requestSubmit();
    }
  });

  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 220) + "px";
  });

  loadState().catch((error) => addError(error.message));
})();

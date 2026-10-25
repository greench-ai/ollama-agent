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
  let running = false;

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

  function addUser(text) {
    const wrap = el("div", "msg user");
    wrap.appendChild(el("div", "bubble", text));
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

  async function runTurn(text) {
    if (running) return;
    running = true;
    send.disabled = true;
    addUser(text);
    const target = { bubble: addAssistant(), thinking: null, currentTool: null };
    try {
      await bridge.chat(text, (event, data) => handleEvent(event, data, target));
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    } finally {
      running = false;
      send.disabled = false;
      input.focus();
    }
  }

  document.getElementById("composer").addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    runTurn(text);
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

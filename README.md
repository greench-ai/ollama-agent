# ollama-agent

A small, dependency-free agentic coding CLI for **Ollama local and cloud** models.
It is the shared core intended to later back a desktop app: the provider, agent loop,
tools, permissions, and sessions are UI-agnostic.

```
src/
  core/     provider abstraction, Ollama adapter, agent loop, permissions, sessions
  tools/    read, write, edit, bash, glob, grep, todo
  ui/       terminal rendering
  index.ts  CLI entry
```

## Requirements

- Node.js >= 22.18 (runs TypeScript directly via type stripping)
- Ollama running locally, or an Ollama Cloud API key
- `ripgrep` (`rg`) for the Grep tool and fast Glob (a JS fallback exists)

## Run

```bash
node src/index.ts                       # localhost:11434, model from /api/tags
node src/index.ts --model qwen3:8b
node src/index.ts --host https://ollama.com --api-key "$OLLAMA_API_KEY" \
                  --model deepseek-v4.1-flash:cloud --think
node src/index.ts --mcp-config ./mcp.json
```

Environment variables: `OLLAMA_HOST`, `OLLAMA_API_KEY`, `OLLAMA_MODEL`.

## Slash commands

```
/help                      show help
/models                    list models on the configured host
/model <name>              switch model
/mode <name>               default | acceptEdits | plan | bypassPermissions
/think [on|off]            toggle reasoning stream
/clear                     clear the conversation
/exit                      quit
```

## Permission modes

| mode | behavior |
| --- | --- |
| `default` | read-only tools run; mutating tools and Bash ask |
| `acceptEdits` | Write/Edit/Todo are auto-approved; Bash still asks |
| `plan` | read-only only; mutating tools are denied |
| `bypassPermissions` | everything runs |

## MCP servers

MCP servers use a Claude-compatible `mcpServers` object. The CLI looks for
`./.mcp.json`, then `~/.local/share/ollama-agent/mcp.json`, then
`~/.config/ollama-agent/mcp.json`. Use `--mcp-config <path>` to point elsewhere
and `--no-mcp` to disable MCP entirely.

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/me/project"],
      "env": { "TOKEN": "${FS_TOKEN}" }
    },
    "remote": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "authorization": "Bearer ${MCP_TOKEN}" }
    }
  }
}
```

- Transports: stdio (`command`) and Streamable HTTP (`url`).
- `${VAR}` and `${VAR:-default}` are expanded in command, args, env, url, and headers.
- Tools are exposed as `<server>__<tool>` (Claude Code's convention). MCP
  `readOnlyHint: true` tools run without approval; everything else prompts.
- `/mcp` lists connected servers, their origin, and tool counts.
- `OLLAMA_AGENT_MCP_LOG=1` echoes server stderr for debugging.

## Web UI

The same core also runs as a local HTTP/SSE server — the foundation for the
desktop shell.

```bash
node src/server.ts --port 4317 --model qwen3:8b
# http://127.0.0.1:4317
```

Flags match the CLI (`--host`, `--api-key`, `--cwd`, `--mode`, `--mcp-config`,
`--no-mcp`), plus `--port` and `--bind` (defaults to `127.0.0.1`).

HTTP API:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/state` | model, mode, cwd, session, MCP servers/resources/prompts |
| GET | `/api/models` | models and the current one |
| POST | `/api/state` | change `model` and/or `mode` |
| POST | `/api/chat` | run a turn; streams SSE events |
| POST | `/api/approve` | answer an `approval` event (`id`, `decision`) |
| POST | `/api/reset` | clear the conversation |

SSE events: `start`, `thinking`, `text`, `tool_start`, `tool_end`, `notice`,
`error`, `approval`, `step`, `done` (with `used`/`budget`). The bundled web
client (`web/index.html`) renders streaming text, thinking, tool cards, and
approval prompts. It is deliberately plain — the shell comes later.

## Desktop shell (Electron)

```bash
npm run electron:start     # bundle main/preload, then launch
npm run electron:build     # bundles only
```

- `electron/main.ts` imports the core directly — no HTTP hop or sidecar. It owns
  the provider, agent, session, MCP manager, and the approval map.
- `electron/preload.ts` exposes a narrow `window.agentBridge` over
  `contextBridge`; the renderer has no Node access (`contextIsolation: true`,
  `sandbox: true`, `nodeIntegration: false`).
- `web/app.js` is shared with browser mode. In Electron the preload installs the
  IPC bridge; under `src/server.ts`, `web/browser-bridge.js` installs the
  fetch/SSE bridge.
- Approvals are IPC round-trips: main emits `agent:event` `{event:"approval"}`,
  renderer answers via `agent:approve`.
- Flags are the same as the CLI (`--model`, `--host`, `--cwd`, `--mode`,
  `--mcp-config`, `--no-mcp`, plus `--devtools`).

Smoke tests (used during development):

```bash
AGENT_SMOKE=1 electron . --no-sandbox            # loads renderer, prints IPC state, quits
AGENT_SMOKE_CHAT=1 electron . --no-sandbox       # runs one real turn over IPC
```

On Wayland, Electron may print an ozone/Vulkan warning; it is harmless. Use
`--ozone-platform=x11` if rendering misbehaves.

### Packaging (Linux)

```bash
npm run package:linux      # AppImage + deb → release/
```

Artifacts produced here:

- `release/ollama-agent-0.1.0-x86_64.AppImage` (~120 MB)
- `release/ollama-agent-0.1.0-amd64.deb` (~97 MB)

The asar contains only `dist-electron/`, `web/`, and `package.json`; the core is
bundled, so no `node_modules` ships. The homepage/author/maintainer fields use
`.invalid` placeholders — replace them before distributing. Windows/macOS targets
need their own config and signing identities.

### Auto-update

`electron-updater` is wired for packaged builds. electron-builder writes
`app-update.yml` (GitHub provider, `greench-ai/ollama-agent`) and
`latest-linux.yml`. The app checks on launch and forwards
`update: available/downloaded` events to the renderer.

The v0.1.0 release predates this metadata, so its updater check reports a 404
for `latest-linux.yml`. The next release fixes that.

```bash
npm version patch
npm run electron:build
GH_TOKEN=$(gh auth token) npx electron-builder --linux AppImage deb --x64 --publish always
```

`--publish always` uploads the artifacts, blockmaps, and `latest-linux.yml`.
electron-builder creates a draft release by default; publish it in the GitHub UI.
`npm run release:linux` is the same command without the token.

### Security posture

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`; the
  renderer only sees the `contextBridge` API
- CSP meta tag: scripts, styles, and connections limited to `'self'`
- New windows denied; `will-navigate` and webview attachment blocked
- Permission requests (camera, microphone, notifications) denied
- IPC payloads validated: records, enums, and a 200k-char message cap
- Single-instance lock; second launch focuses the existing window
- Window bounds persisted under Electron's `userData` directory

## Design notes

- The provider interface is deliberately Anthropic-shaped (content blocks,
  `tool_use` / `tool_result`) because it maps cleanly onto Ollama's OpenAI-style
  `tool_calls` and leaves room for other backends.
- No prompt caching exists in Ollama, so the agent compacts context by trimming
  old turns when the estimated token budget is exceeded.
- Tool results are truncated before they re-enter the model context.

## Status

Early. Implemented: streaming, tool loop, permissions, sessions, 7 built-in
tools, an MCP client (stdio + Streamable HTTP; tools, resources, prompts,
pagination, annotations, reconnect), a local HTTP/SSE server with a web client,
an Electron shell with a sandboxed renderer, IPC approvals, CSP, window-state
persistence, menus, Linux packaging (AppImage + deb), and electron-updater
wiring. Not yet: subagents, image input, OAuth for HTTP MCP servers, and a
plan-mode editing workflow.

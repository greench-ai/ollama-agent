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
/image <path>              attach an image to the next message
/images                    list staged images
/mcp [reconnect <server>]  /mcp logout <server>
/resources                 list MCP resources
/resource <server> <uri>   read an MCP resource
/prompts                   list MCP prompts
/prompt <server> <name>    run an MCP prompt
/clear                     clear the conversation and staged images
/session                   show the session file
/exit                      quit
```

## Permission modes

| mode | behavior |
| --- | --- |
| `default` | read-only tools run; mutating tools and Bash ask |
| `acceptEdits` | Write/Edit/Todo are auto-approved; Bash still asks |
| `plan` | read-only only; mutating tools are denied |
| `bypassPermissions` | everything runs |

## Images

Images can enter a conversation three ways:

- **User attachments** — `/image <path>` in the CLI stages images for the next
  message; the web UI has an Attach button and accepts pasted images; HTTP and
  IPC clients send an `images` array.
- **Read tool** — reading a `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, or `.bmp`
  returns the image as an attachment instead of a text description.
- **MCP tools** — image blocks in MCP tool results are forwarded.

Ollama attaches images to user messages, so tool-result images are replayed as a
follow-up user message (`Images returned by tool results: …`) after the tool
messages. Limits: 10 MB per image, 8 images per message. The model must be
vision-capable (`ollama show <model>` lists `vision` in capabilities) — for
example `d1-3b`, `qwen2.5vl:7b`, or a cloud vision model.

```bash
node src/index.ts --model d1-3b:latest
› /image screenshot.png
image attached: screenshot.png (image/png, ~240 KB) · 1 staged
› What is wrong with this UI?
```

## Plan mode

`--mode plan` (or `/mode plan`) exposes read-only tools plus `ExitPlanMode`. The
model investigates, then calls `ExitPlanMode` with a plan. The host shows it:

- **CLI** — inline approve/deny prompt with optional feedback on rejection
- **Web / Electron** — plan card with Approve / Reject and a feedback field
- **HTTP** — SSE `plan_approval`; answer with `POST /api/approve-plan`

On approval the session switches to `acceptEdits` (configurable via
`planApplyMode`) and the next model turn can edit. On rejection the feedback is
returned as the tool result so the model can revise.

## Subagents

The `Task` tool launches a child agent with its own context, session file, and
tool set. Only its final report returns to the parent, so intermediate output
never consumes the main conversation.

- `general-purpose` — all tools except `Task`
- `explore` / `plan` — read-only tools only
- Nesting is capped at one level; a child never receives `Task`
- The child inherits the permission mode (approvals still prompt) and the
  parent's model unless `model` is set
- Progress is surfaced as `subagent_start` / `subagent_end` events, plus a
  notice for each child tool call
- Child transcripts are stored as `<parent-session>-<name>.jsonl`

```
Task(description: "Find auth code", prompt: "…", subagent_type: "explore", name: "scout")
```

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
    },
    "discovered": {
      "type": "http",
      "url": "https://mcp.example.org/mcp",
      "auth": { "type": "oauth", "scopes": ["mcp.read"] }
    },
    "explicit": {
      "type": "http",
      "url": "https://example.net/mcp",
      "auth": {
        "authorizationUrl": "https://auth.example.net/authorize",
        "tokenUrl": "https://auth.example.net/token",
        "clientId": "${MCP_CLIENT_ID}",
        "clientSecret": "${MCP_CLIENT_SECRET}",
        "scopes": ["mcp.read"],
        "redirectPort": 4318
      }
    }
  }
}
```

- Transports: stdio (`command`) and Streamable HTTP (`url`).
- `${VAR}` and `${VAR:-default}` are expanded in command, args, env, url, and headers.
- Tools are exposed as `<server>__<tool>` (Claude Code's convention). MCP
  `readOnlyHint: true` tools run without approval; everything else prompts.
- `/mcp` lists connected servers, their origin, and tool counts. Use
  `/mcp reconnect <server>` to re-establish one, and `/mcp logout <server>` to
  clear its stored OAuth token.
- `OLLAMA_AGENT_MCP_LOG=1` echoes server stderr for debugging.
- **OAuth**: when `auth` is present the client runs authorization-code + PKCE in
  the system browser, with a loopback redirect on `127.0.0.1:<redirectPort>`
  (default 4318). Tokens are stored per server in
  `~/.local/share/ollama-agent/mcp-auth.json` (mode 0600), refreshed on expiry,
  and re-obtained once if the server answers 401. `auth` wins over a static
  `authorization` header.
- **Discovery and dynamic registration**: with `auth` omitted (or
  `"auth": {"type": "oauth"}`), a 401 whose `WWW-Authenticate` header carries
  `resource_metadata` triggers RFC 9728 protected-resource discovery, RFC 8414
  authorization-server metadata, and RFC 7591 dynamic client registration. The
  registered client is cached per server in `mcp-clients.json` (mode 0600) and
  reused. `resourceMetadataUrl` and `registrationUrl` override discovery, and
  explicit `authorizationUrl`/`tokenUrl`/`clientId` skip it entirely.

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
| POST | `/api/chat` | run a turn; body `{message, images?}`; streams SSE events |
| POST | `/api/approve` | answer an `approval` event (`id`, `decision`) |
| POST | `/api/approve-plan` | answer a `plan_approval` event (`id`, `approved`, `feedback?`) |
| POST | `/api/reset` | clear the conversation |

SSE events: `start`, `thinking`, `text`, `tool_start`, `tool_end`, `notice`,
`subagent_start`, `subagent_end`, `error`, `approval`, `plan_approval`, `step`,
`done` (with `used`/`budget`). The bundled web client (`web/index.html`) renders
streaming text, thinking, tool cards, subagent progress, attachment previews,
and approval prompts. It is deliberately plain — the shell comes later.

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

- `release/ollama-agent-0.1.5-x86_64.AppImage` (~121 MB)
- `release/ollama-agent-0.1.5-amd64.deb` (~97 MB)

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
for `latest-linux.yml`. Releases from v0.1.1 onward include the manifest and
support updates.

```bash
npm version patch
npm run electron:build
GH_TOKEN=$(gh auth token) npx electron-builder --linux AppImage deb --x64 --publish always
```

`--publish always` uploads the artifacts, blockmaps, and `latest-linux.yml`.
electron-builder creates a draft release by default; publish it in the GitHub UI.
`npm run release:linux` is the same command without the token.

### Packaging (Windows / macOS)

Windows and macOS builds run on native GitHub Actions runners
(`.github/workflows/release.yml`) — the reliable path when developing on Linux:

- **Windows**: NSIS installer + zip (x64), built on `windows-latest`
- **macOS**: dmg + zip for x64 and arm64, built on `macos-13` / `macos-14`
- **Linux**: AppImage + deb, built on `ubuntu-latest`

Pushing a `v*` tag builds every platform and attaches the artifacts (plus
`latest-linux.yml` / `latest.yml` / `latest-mac.yml`) to that release.
`workflow_dispatch` only uploads run artifacts.

Builds are **unsigned by default**. Provide `CSC_LINK` / `CSC_KEY_PASSWORD` (and
Apple notarization credentials) as repository secrets to sign. Unsigned macOS
apps are quarantined by Gatekeeper; unsigned Windows installers show a SmartScreen
warning.

Local cross-builds from Linux: the Windows **zip** works; the NSIS installer needs
Wine; the macOS zip builds unsigned; dmg and signing require macOS.

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

Early. Implemented: streaming, tool loop, permissions, sessions, 8 built-in
tools (including `Task` subagents with isolated context), image input (user
attachments, Read on images, MCP image results), an MCP client (stdio +
Streamable HTTP; tools, resources, prompts, pagination, annotations, reconnect,
OAuth authorization-code + PKCE with discovery and dynamic client registration),
a local HTTP/SSE server with a web client, an Electron shell with a sandboxed
renderer, IPC approvals, plan-mode propose/approve/apply, CSP, window-state
persistence, menus, Linux packaging (AppImage + deb), cross-platform CI
packaging (Windows NSIS/zip, macOS dmg/zip x64 + arm64), and electron-updater
wiring. Not yet: code signing/notarization.

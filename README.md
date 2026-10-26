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

Standalone CLI bundle (single file, no TypeScript loader needed):

```bash
npm run build:cli        # → dist/cli.mjs
node dist/cli.mjs --model qwen3:8b
```

## Slash commands

```
/help                      show help
/models                    list models on the configured host
/model <name>              switch model
/mode <name>               default | acceptEdits | plan | bypassPermissions
/think [on|off]            toggle reasoning stream
/image <path>              attach an image to the next message
/images                    list staged images
/file <path>               attach a text/code/PDF file
/files                     list staged files       /files clear
/mcp [reconnect <server>]  /mcp logout <server>
/resources                 list MCP resources
/resource <server> <uri>   read an MCP resource
/prompts                   list MCP prompts
/prompt <server> <name>    run an MCP prompt
/agents                    list subagent definitions
/team status|tasks|review <name> [--diff]|merge <name> [--skip-tests] [--cleanup] [--test <cmd>]|stop <name> [--remove-worktree]|message <name> <text>|transcript <name>
/skills                    reload and list skills
/skill <name>              print a loaded skill
/rewind [list|<id|n>]      list or restore a file checkpoint
/hooks                     reload and list lifecycle hooks
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

## Attachments

User attachments come in three kinds:

- **Images** — `/image <path>` in the CLI, the Attach button or paste/drag in the
  UI, or an `images` array over HTTP/IPC. 10 MB per image, 8 per message.
  Requires a vision-capable model (`ollama show <model>` lists `vision`).
- **Text and code** — `/file <path>` in the CLI, or pick/drag any text, code, or
  config file in the UI. 1 MB per file, 8 per message. The content is embedded
  in the model context as a labelled block; the message shows a file chip.
- **PDFs** — attach a `.pdf` the same way. Text is extracted with `pdftotext`
  (install `poppler-utils`); 10 MB per PDF. Image-only PDFs yield no text
  without OCR.

The **Read tool** still returns images for image files. Ollama attaches images
to user messages, so tool-result images are replayed as a follow-up user message
(`Images returned by tool results: …`). Text and PDF attachments are provider
agnostic and work with any model.

```bash
› /file src/app.ts
file attached: app.ts (text, 12 KB) · 1 staged
› What does this module do?
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

- `subagent_type` names an agent definition; built-ins are `general-purpose`,
  `explore`, `plan`, `implementer`, `reviewer`, and `tester`
- The definition controls tools, model, permission mode, and max turns
- Nesting is capped at one level; a child never receives `Task`
- Progress is surfaced as `subagent_start` / `subagent_end` events, plus a
  notice for each child tool call
- Child transcripts are stored as `<parent-session>-<name>.jsonl`

```
Task(description: "Find auth code", prompt: "…", subagent_type: "explore", name: "scout")
```

### Agent definitions

Roles are Markdown files with YAML frontmatter, discovered from:

- built-ins (compiled)
- `~/.config/ollama-agent/agents/`
- `.ollama-agent/agents/` and `.agents/agents/` in the project, walking up to
  the git root (closest definition wins)

Supported fields: `name` and `description` (required), `model` (or `inherit`),
`tools`, `disallowedTools`, `permissionMode`, `maxTurns`, `isolation`,
`background`. The body becomes the agent's system prompt. Unknown fields are
ignored.

```markdown
---
name: security-reviewer
description: Reviews changes for security regressions
tools: Read, Grep, Glob
permissionMode: plan
model: qwen3:8b
---
Review the change read-only. Report findings by severity with file paths.
```

`/agents` in the CLI, and Settings → Agents in the GUI, list the loaded
definitions and their sources.

## Teams

The lead can create named teammates that share a task board and mailboxes.
Teams are opt-in at the model level: the tools are available, and the lead
decides when parallel work is worth the overhead.

Lead tools: `TeamSpawn`, `TeamRun`, `TeamAwait`, `TeamTask`, `TeamMessage`,
`TeamStatus`, `TeamReview`, `TeamMerge`, `TeamShutdown`. Teammates receive only
the task, message, and status tools.

- Defaults: 6 members, 3 concurrent runs, 30 turns per member, 8 auto-message
  turns per member.
- `TeamSpawn` starts a role in the background; `TeamAwait` collects reports.
- `TeamTask` supports create/list/claim/complete/block, task dependencies, and
  file reservations. Claiming a task whose files overlap an in-progress task
  fails, so overlapping work is serialized.
- Messages to an idle teammate start a turn; busy teammates receive them after
  the current run.
- Team state persists per lead session at
  `~/.local/share/ollama-agent/teams/<session>/team.json`. Tasks, mailboxes, and
  runs survive restarts; members come back offline.
- The GUI shows a Team button with members, tasks, transcripts, direct
  messaging, Review, and Stop.
- CLI: `/team status`, `/team tasks`,
  `/team review <name> [--diff]`,
  `/team merge <name> [--skip-tests] [--cleanup] [--test <cmd>]`,
  `/team message <name> <text>`, `/team stop <name> [--remove-worktree]`,
  `/team transcript <name>`.

### Worktree isolation and the merge gate

When git is available, definitions with `isolation: worktree` (the built-in
`implementer`, or `TeamSpawn({isolation: "worktree"})`) run in a linked git
worktree at `teams/<session>/worktrees/<name>-<id>` on branch
`team/<session>-<name>`. The teammate's tools and shell use that directory.
Teammates are told not to commit, merge, or push; changes wait for the lead.

`TeamReview` shows the branch, base, commits ahead, working-tree status, diff
stat, untracked files, and optionally the full diff.

`TeamMerge` is a serialized gate:

1. Refuses if the lead tree is dirty, a merge is in progress, or the teammate
   is still running.
2. Commits the worktree's changes on its branch.
3. Trial-merges the branch into a scratch worktree based on the lead HEAD. A
   conflict aborts; conflicts are never resolved by a model.
4. Runs a test command in the trial checkout (auto-detected from package.json /
   Cargo / Go / Make, or passed as `testCommand`). A failing test blocks the
   merge and leaves the lead tree untouched.
5. Merges the branch into the lead branch with a merge commit, then optionally
   removes the worktree and branch (`cleanup`).

Merges are serialized through the team lock. If the project is not a git
repository with a commit, the teammate falls back to the shared tree and a
notice is emitted; task file reservations still apply. File tools (`Read`,
`Write`, `Edit`, `MultiEdit`, `Glob`, `Grep`) are confined to the worktree root
for isolated teammates. Worktree isolation is not an OS sandbox: a teammate's
`Bash` command can still reach paths outside its worktree.

## Skills

Skills are `SKILL.md` directories with YAML frontmatter (`name`,
`description`). They load from:

- `~/.config/ollama-agent/skills/` and `~/.claude/skills/`
- project `.ollama-agent/skills/`, `.agents/skills/`, and `.claude/skills/`,
  walking up to the git root (closest wins)

Only the name and description enter the system prompt. When a task matches,
the model calls the `Skill` tool; the full body and a list of resource files are
returned on demand, so unused skills cost almost no context. `$ARGUMENTS` in a
skill body is replaced with the tool's arguments. The tool is available to
subagents and teammates as well.

```
Skill(name: "frontend-design", args: "the settings dialog")
```

`/skills` reloads and lists them; Settings → Agents shows the loaded catalog.

## Checkpoints and rewind

Before each `Write`, `Edit`, or `MultiEdit`, the agent snapshots the touched
file under `~/.local/share/ollama-agent/checkpoints/<session>/` (up to 100
entries per session, 5 MB per file). For a new file it records that the path
did not exist.

`/rewind` lists checkpoints; `/rewind <n|id>` restores the files to that point,
including deleting files that did not exist. In the GUI, Settings → Rewind
lists them with a Restore button. Restores rewind files only, not the chat.

Checkpoints cover file tools, not arbitrary `Bash` side effects, and are
confined to a teammate's worktree root.

## Hooks

Lifecycle hooks are shell commands in `~/.config/ollama-agent/hooks.json` or
project `.ollama-agent/hooks.json`. Each command receives the event as JSON on
stdin and runs with the project root as its working directory. Supported events
include `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
`PostToolUseFailure`, `Stop`, `SubagentStop`, and `SessionEnd`.

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Write|Edit", "command": "scripts/check-paths.sh", "timeoutMs": 5000 }
    ],
    "PostToolUse": [
      { "matcher": "Edit", "command": "npm run lint --silent" }
    ]
  }
}
```

Exit code `2` blocks the action (for `PreToolUse` and `UserPromptSubmit`);
other non-zero exits are advisory. Timed-out policy hooks fail closed. Hook
stdout/stderr appears as a notice. Hooks are arbitrary local commands, so only
install configs you trust. `/hooks` reloads and lists them.

## Deferred tool loading

When the tool set is large (default threshold: 20 tools) and at least three MCP
tools are present, MCP schemas are deferred. The system prompt lists their
names and descriptions; the model calls `ToolSearch` with a keyword, gets the
matching schemas, and can call those tools on the next turn. Core, team, and
skill tools always stay loaded. Set `toolSearch: false` or adjust
`toolSearchThreshold` on the Agent. Deferred catalogs are per agent; teammates
and subagents do not inherit them.

## Background jobs and schedules

Settings → Background (and the HTTP API) can dispatch prompts into independent
sessions while the main chat continues. Jobs queue behind a concurrency cap
(default 2), persist under `~/.local/share/ollama-agent/background/state.json`,
can be stopped, and expose their transcripts. Running jobs interrupted by a
restart are marked failed.

Schedules use a standard five-field cron expression and run only while the
server or desktop app is running. They persist across restarts, record
`lastRunAt`/`nextRunAt`, and create ordinary background jobs. Background jobs
cannot ask for approval, so mutating tools require `acceptEdits` or
`bypassPermissions`; `default` denies them.

## ACP server

`npm run build:acp` produces `dist/acp.mjs`, a newline-delimited JSON-RPC Agent
Client Protocol v1 server over stdio. It supports `initialize`, `session/new`,
`session/prompt`, `session/set_mode`, `session/close`, `session/cancel`,
streaming `agent_message_chunk` / `agent_thought_chunk` / `tool_call` updates,
image prompt blocks, and `session/request_permission` mapped to the normal
permission engine.

```
node dist/acp.mjs --model qwen3:8b --cwd /path/to/project --mode acceptEdits
```

The per-user install also provides `ollama-agent-acp` with the same arguments.

Point an ACP client (Zed, Neovim, Emacs) at that command. ACP `mcpServers` from
the client are not consumed; the server uses the local MCP config. Advertised
session modes are `default`, `acceptEdits`, `plan`, and
`bypassPermissions`.

## Telemetry and eval

Every run appends one JSON line per session to
`~/.local/share/ollama-agent/telemetry/<session>.jsonl`: turns, tool counts,
input/output tokens, compactions, tool errors, duration, stop reason, agent
name, model. `/telemetry` shows the current session summary; `/telemetry runs`
shows recent runs. Settings → About shows the summary.

`npm run eval` runs scripted-provider scenarios for the tool loop, edit
checkpoint/restore, and deferred tool loading, then prints one JSON result per
scenario. It runs in CI.

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
| GET | `/api/sessions` | list sessions and the current id |
| POST | `/api/sessions/new` | start a new session (reuses an empty one) |
| POST | `/api/sessions/load` | load `{id}` and return its messages |
| POST | `/api/sessions/rename` | rename `{id, title}` |
| POST | `/api/sessions/delete` | delete `{id}` |
| POST | `/api/cancel` | abort the running turn |
| GET | `/api/settings` | theme, default model/mode, show-thinking |
| POST | `/api/settings` | update settings |
| GET | `/api/mcp` | connector config path, statuses, and raw configs |
| POST | `/api/mcp/save` | add or update `{name, config}` |
| POST | `/api/mcp/remove` | remove `{name}` |
| POST | `/api/mcp/reconnect` | reconnect `{name}` (or all) |
| POST | `/api/mcp/logout` | clear the stored OAuth token for `{name}` |
| GET | `/api/update/status` | current version and updater state |
| POST | `/api/update/check` | check GitHub for a newer release |
| POST | `/api/update/install` | install a downloaded update (desktop only) |
| POST | `/api/project/set` | switch project folder `{path}` |
| GET | `/api/file?path=` | preview a text file inside the project |
| GET | `/api/agents` | agent definitions and loaded skills |
| GET | `/api/skills` | loaded skills |
| GET | `/api/hooks` | loaded lifecycle hooks |
| GET | `/api/telemetry` | current-session telemetry summary and runs |
| GET | `/api/checkpoints` | file checkpoints for the current session |
| POST | `/api/checkpoints/restore` | restore `{id}` |
| GET | `/api/team` | team state snapshot |
| GET | `/api/team/review?name=` | worktree review |
| GET | `/api/background` | background jobs and schedules |
| POST | `/api/background` | dispatch a background prompt |
| POST | `/api/background/cancel` | cancel `{id}` |
| GET | `/api/background/transcript?id=` | job transcript |
| POST | `/api/background/schedules` | add a cron schedule |
| POST | `/api/background/schedules/remove` | remove a schedule |

SSE events: `start`, `thinking`, `text`, `tool_start`, `tool_end`, `notice`,
`subagent_start`, `subagent_end`, `session_title`, `error`, `approval`,
`plan_approval`, `background_event`, `step`, `done` (with `used`/`budget`).

The bundled client (`web/index.html`) is the desktop shell:

- collapsible sidebar with searchable chat history (rename/delete/resume) and a
  centered empty state
- incrementally rendered markdown blocks with locally bundled Prism syntax
  highlighting and copy buttons
- collapsible thinking, tool cards, and approval cards that preview added and
  removed lines (or the full Bash command) before you allow them
- copy actions on messages and a live context/token HUD
- drag-and-drop or paste image attachments, with previews
- shortcuts: `Ctrl/Cmd+K` search chats, `Ctrl/Cmd+N` new chat, `Ctrl/Cmd+,`
  settings
- dialog focus trap, `aria-live` status announcements, and reduced-motion
  support
- system/light/dark theme

Session switching and cancellation work in both Electron (IPC) and browser
(HTTP) modes.

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

- `release/ollama-agent-0.2.0-x86_64.AppImage` (~121 MB)
- `release/ollama-agent-0.2.0-amd64.deb` (~97 MB)

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

## Settings and connectors

The Settings dialog (sidebar → Settings) has three tabs:

- **General** — theme, default model, default permission mode, and whether
  reasoning is shown. Stored in `~/.local/share/ollama-agent/settings.json` and
  applied at startup and to new sessions. The header pickers change only the
  current session.
- **Connectors** — add, edit, remove, reconnect, and sign out of MCP servers.
  Supports stdio (command, args, env, cwd) and HTTP (URL, headers, OAuth:
  none / discover / explicit endpoints). Changes are written to the active
  config file (its path is shown) with `${VAR}` templates preserved, then the
  MCP manager restarts so new tools are available on the next turn.
- **About** — working directory, session file, and connector config path.

Connector changes are blocked while a turn is running.

## Projects and artifacts

The project name in the header is a button: Electron opens a native folder
picker; the browser asks for a path. Switching projects:

- changes the agent working directory and starts a new session
- reloads `.mcp.json` from the new folder (unless `--mcp-config` was given)
- loads project instructions from `.ollama-agent.md`, `AGENTS.md`, or
  `CLAUDE.md` (first match, up to 20k characters) into the system prompt

The **Files** button opens an artifact panel listing files written or edited in
the conversation. Preview is served by the backend and restricted to the project
root (2 MB, text only); attempts to read outside it are rejected.

## Updates

Settings → **About** shows the current version and a **Check for updates**
button. It queries the latest GitHub release and reports whether a newer version
exists. Packaged Electron builds additionally use `electron-updater`: an
available update downloads automatically, and **Restart to update** appears when
it is ready. Development builds report that automatic updates require the
packaged app.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # 47 tests, including a server integration test with a mock Ollama
npm run build:web   # regenerate web/prism.js from web/highlight-src.js
```

CI (`.github/workflows/ci.yml`) runs typecheck, tests, and the Electron/web
bundles on pushes to `main` and on pull requests.

## Research

- [Agent harnesses and agent teams](docs/harness-research.md) — a
  source-code-informed survey of eleven coding harnesses, the orchestration
  patterns they converge on, and a concrete team-mode design for this project.

## Design notes

- The provider interface is deliberately Anthropic-shaped (content blocks,
  `tool_use` / `tool_result`) because it maps cleanly onto Ollama's OpenAI-style
  `tool_calls` and leaves room for other backends.
- No prompt caching exists in Ollama, so the agent compacts context by trimming
  old turns when the estimated token budget is exceeded.
- Tool results are truncated before they re-enter the model context.

## Status

Early. Implemented: streaming, tool loop, permissions, sessions with a
Claude-Desktop-style shell (sidebar, searchable history, rename/delete/resume,
markdown rendering, stop button, themes), settings and connector management,
project switching with project instructions, an artifact panel, an update
checker, agent definitions (Markdown roles), a team core (task board, mailboxes,
background teammate runs, transcripts, persistence), git worktree isolation with
serialized trial-merge and test gates, skills with progressive disclosure,
file checkpoints with `/rewind`, lifecycle hooks, a whitespace-tolerant Edit
fallback for local models, deferred MCP tool loading, background jobs with cron
schedules, an ACP v1 stdio server, run telemetry and a scripted eval harness,
built-in tools (including `Task` subagents),
image/text/PDF input, an MCP client
(stdio + Streamable HTTP; tools, resources, prompts, pagination, annotations,
reconnect, OAuth authorization-code + PKCE with discovery and dynamic client
registration), a local HTTP/SSE server with the same web client, an Electron
shell with a sandboxed renderer, IPC approvals, plan-mode
propose/approve/apply, CSP, window-state persistence, menus, Linux packaging
(AppImage + deb), cross-platform CI packaging (Windows NSIS/zip, macOS dmg/zip
x64 + arm64), and electron-updater wiring. Not yet: code signing and
notarization.

import { createInterface } from "node:readline/promises";
import process from "node:process";
import path from "node:path";
import { Agent } from "./core/agent.ts";
import {
  agentCatalogPrompt,
  loadAgentDefinitions,
} from "./core/agent-definitions.ts";
import { loadSkills } from "./core/skills.ts";
import { HooksEngine, describeHooks } from "./core/hooks.ts";
import { formatTelemetry } from "./core/telemetry.ts";
import { MAX_IMAGE_BYTES, loadImageAttachment } from "./core/images.ts";
import { MAX_ATTACHMENTS, readFileAttachment } from "./core/files.ts";
import type { FileAttachment, ImageAttachment } from "./core/types.ts";
import { OllamaProvider } from "./core/ollama.ts";
import {
  PERMISSION_MODES,
  PermissionEngine,
  type AskOutcome,
  type PermissionMode,
} from "./core/permissions.ts";
import { Session } from "./core/session.ts";
import { loadMcpConfig } from "./mcp/config.ts";
import { mcpPromptToText } from "./mcp/client.ts";
import { clearToken } from "./mcp/oauth.ts";
import { McpManager } from "./mcp/manager.ts";
import { allTools } from "./tools/index.ts";
import { TerminalRenderer, style } from "./ui/render.ts";

export interface CliOptions {
  model?: string;
  host?: string;
  apiKey?: string;
  cwd?: string;
  mode: PermissionMode;
  think: boolean;
  numCtx?: number;
  resume?: string;
  continueLatest: boolean;
  mcpConfig?: string;
  noMcp: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    mode: "default",
    think: false,
    continueLatest: false,
    noMcp: false,
    help: false,
  };

  const take = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (!value || value.startsWith("-")) {
      throw new Error(`Missing value for ${flag}`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--model":
      case "-m":
        options.model = take(i, arg);
        i += 1;
        break;
      case "--host":
        options.host = take(i, arg);
        i += 1;
        break;
      case "--api-key":
        options.apiKey = take(i, arg);
        i += 1;
        break;
      case "--cwd":
        options.cwd = take(i, arg);
        i += 1;
        break;
      case "--mode": {
        const value = take(i, arg) as PermissionMode;
        if (!PERMISSION_MODES.includes(value)) {
          throw new Error(
            `Unknown mode "${value}". Expected one of: ${PERMISSION_MODES.join(", ")}`,
          );
        }
        options.mode = value;
        i += 1;
        break;
      }
      case "--think":
        options.think = true;
        break;
      case "--num-ctx": {
        const value = Number(take(i, arg));
        if (!Number.isFinite(value) || value <= 0) {
          throw new Error("--num-ctx must be a positive number");
        }
        options.numCtx = Math.floor(value);
        i += 1;
        break;
      }
      case "--resume":
        options.resume = take(i, arg);
        i += 1;
        break;
      case "--continue":
      case "-c":
        options.continueLatest = true;
        break;
      case "--mcp-config":
        options.mcpConfig = take(i, arg);
        i += 1;
        break;
      case "--no-mcp":
        options.noMcp = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument "${arg}". Try --help.`);
    }
  }
  return options;
}

const HELP = `ollama-agent — an agentic coding CLI for Ollama local and cloud models

Usage
  ollama-agent [options]

Options
  -m, --model <name>     Model name (default: $OLLAMA_MODEL or first model)
      --host <url>       Ollama base URL (default: $OLLAMA_HOST or http://127.0.0.1:11434)
      --api-key <key>    Bearer token for Ollama Cloud (default: $OLLAMA_API_KEY)
      --cwd <dir>        Working directory (default: current directory)
      --mode <mode>      default | acceptEdits | plan | bypassPermissions
      --think            Request reasoning output from thinking models
      --num-ctx <n>      Context window passed to Ollama options.num_ctx
      --resume <id>      Resume a stored session
  -c, --continue         Resume the most recent session
      --mcp-config <p>   MCP servers JSON (default: ./.mcp.json or
                         ~/.config/ollama-agent/mcp.json)
      --no-mcp           Disable MCP servers
  -h, --help             Show this help

Slash commands
  /help  /models  /model <name>  /mode <mode>  /think [on|off]
  /agents                  list subagent definitions
  /skills                  reload and list skills
  /skill <name>            print a loaded skill
  /rewind [list|<id|n>]    list or restore a file checkpoint
  /hooks                   reload and list lifecycle hooks
  /telemetry [runs]        show this session's run telemetry
  /team [status|tasks|review <name> [--diff]|merge <name> [--skip-tests] [--cleanup] [--test <cmd>]|stop <name> [--remove-worktree]|message <name> <text>|transcript <name>]
  /image <path>  /images   (attach images to the next message)
  /file <path>   /files    (attach text/code/PDF files to the next message)
  /mcp [reconnect <server>]  /mcp logout <server>
  /resources  /resource <server> <uri>
  /prompts  /prompt <server> <name> [key=value ...]
  /clear  /session  /exit
`;

function systemPrompt(cwd: string): string {
  return `You are a coding agent running in the user's terminal, powered by an Ollama model.

Environment
- Working directory: ${cwd}
- Platform: ${process.platform}

Available tools: Read, Write, Edit, MultiEdit, Bash, Glob, Grep, TodoWrite.

Working rules
- Use absolute file paths.
- Read a file before editing it; never guess at its contents.
- Prefer Read, Grep, and Glob over cat, find, and grep in Bash.
- Keep changes minimal and consistent with the surrounding code.
- Use TodoWrite for multi-step work and keep one item in progress.
- The harness asks the user before mutating tools; do not ask for permission in prose.
- When finished, state what changed and what you verified.`;
}

function pickModel(models: string[]): string {
  return models[0] ?? "";
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(style.red(error instanceof Error ? error.message : String(error)));
    console.error(HELP);
    process.exitCode = 1;
    return;
  }

  if (options.help) {
    console.log(HELP);
    return;
  }

  const cwd = path.resolve(options.cwd ?? process.cwd());
  const host = options.host ?? process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
  const apiKey = options.apiKey ?? process.env.OLLAMA_API_KEY;
  const provider = new OllamaProvider({ host, apiKey });

  let models: Awaited<ReturnType<OllamaProvider["listModels"]>> = [];
  try {
    models = await provider.listModels();
  } catch (error) {
    console.error(style.red(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
    return;
  }

  const names = models.map((model) => model.name);
  let model = options.model ?? process.env.OLLAMA_MODEL ?? pickModel(names);
  if (!model) {
    console.error(style.red("No models found. Pull one first, e.g. ollama pull qwen3:8b"));
    process.exitCode = 1;
    return;
  }

  let session: Session;
  if (options.resume) {
    session = await Session.open(options.resume);
  } else if (options.continueLatest) {
    session = (await Session.latest()) ?? (await Session.create({ cwd, model }));
  } else {
    session = await Session.create({ cwd, model });
  }
  if (!options.model && session.model) model = session.model;
  const prior = await session.loadMessages();

  let capabilityNote = "";
  try {
    const info = await provider.showModel(model);
    if (info?.capabilities && info.capabilities.length > 0) {
      if (!info.capabilities.includes("tools")) {
        capabilityNote = "This model does not advertise tool support; tool calls may fail.";
      }
    }
  } catch {
    // Capability probing is best-effort.
  }

  let mcp: McpManager | undefined;
  if (!options.noMcp) {
    try {
      const config = await loadMcpConfig(options.mcpConfig, cwd);
      if (Object.keys(config.servers).length > 0) {
        mcp = await McpManager.start(config.servers, {
          onLog: (line) => {
            if (process.env.OLLAMA_AGENT_MCP_LOG) console.error(style.dim(line));
          },
        });
      }
    } catch (error) {
      console.error(
        `${style.yellow("•")} MCP config: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const tools = [...allTools, ...(mcp?.tools ?? [])];

  const renderer = new TerminalRenderer({ showThinking: options.think });
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let currentController: AbortController | null = null;

  // readline's question() drops lines that arrive while no question is pending
  // (piped input, pasted multi-line blocks). Buffer every line ourselves.
  const pendingLines: string[] = [];
  let lineWaiter: ((line: string) => void) | undefined;
  let lineRejecter: ((error: Error) => void) | undefined;
  let inputClosed = false;
  rl.on("line", (line) => {
    if (lineWaiter) {
      const resolve = lineWaiter;
      lineWaiter = undefined;
      lineRejecter = undefined;
      resolve(line);
    } else {
      pendingLines.push(line);
    }
  });
  rl.on("close", () => {
    inputClosed = true;
    if (lineRejecter) {
      const reject = lineRejecter;
      lineWaiter = undefined;
      lineRejecter = undefined;
      reject(new Error("Input closed."));
    }
  });
  const readLine = (prompt: string): Promise<string> => {
    process.stdout.write(prompt);
    const buffered = pendingLines.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    if (inputClosed) return Promise.reject(new Error("Input closed."));
    return new Promise<string>((resolve, reject) => {
      lineWaiter = resolve;
      lineRejecter = reject;
    });
  };

  const ask = async (request: {
    tool: string;
    input: Record<string, unknown>;
    summary: string;
  }): Promise<AskOutcome> => {
    while (true) {
      process.stdout.write(
        `${style.yellow("?")} Allow ${style.bold(request.tool)}` +
          `${request.summary ? ` ${style.dim(request.summary)}` : ""}\n`,
      );
      const answer = (
        await readLine(
          `  ${style.dim("[y]es / [n]o / [a]lways / [d]etails ›")} `,
        )
      )
        .trim()
        .toLowerCase();
      if (answer === "y" || answer === "yes") return "allow";
      if (answer === "a" || answer === "always") return "always";
      if (answer === "d" || answer === "details") {
        console.log(JSON.stringify(request.input, null, 2));
        continue;
      }
      return "deny";
    }
  };

  const planApprover = async (plan: string) => {
    process.stdout.write(`\n${style.bold("Proposed plan")}\n${plan}\n\n`);
    const answer = (
      await readLine(style.cyan("Approve this plan and start editing? [y]es/[n]o › "))
    )
      .trim()
      .toLowerCase();
    if (answer === "y" || answer === "yes") return { approved: true };
    const feedback = (
      await readLine(style.dim("Feedback (optional) › "))
    ).trim();
    return { approved: false, feedback: feedback || undefined };
  };

  const permissions = new PermissionEngine(options.mode, ask);
  let agentDefinitions = await loadAgentDefinitions(cwd);
  let skills = await loadSkills(cwd);
  let hooks = await HooksEngine.load(cwd);

  const agent = new Agent({
    provider,
    model,
    tools,
    permissions,
    session,
    cwd,
    system: `${systemPrompt(cwd)}\n\n${agentCatalogPrompt(agentDefinitions)}`,
    think: options.think,
    numCtx: options.numCtx,
    messages: prior,
    planApprover,
    agentDefinitions,
    skills,
    hooks,
    onEvent: (event) => renderer.handle(event),
  });

  console.log(
    `${style.bold("ollama-agent")} ${style.dim("·")} ${style.cyan(model)} ${style.dim("·")} ${style.dim(provider.baseUrl)}`,
  );
  console.log(
    `${style.dim("mode")} ${options.mode}  ${style.dim("·")}  ${style.dim(cwd)}`,
  );
  console.log(`${style.dim("session")} ${session.file}`);
  if (prior.length > 0) {
    console.log(style.dim(`resumed ${prior.length} message(s)`));
  }
  if (capabilityNote) console.log(`${style.yellow("•")} ${capabilityNote}`);
  if (mcp) {
    console.log(`${style.dim("mcp")} ${mcp.summary()}`);
    for (const server of mcp.servers.filter((entry) => !entry.ok)) {
      console.log(
        `${style.yellow("•")} ${server.name}: ${server.error ?? "failed to start"}`,
      );
    }
  }
  console.log(style.dim("Type /help for commands. Ctrl+C interrupts a running turn.\n"));

  rl.on("SIGINT", () => {
    if (currentController) {
      currentController.abort();
      currentController = null;
      process.stdout.write("\n");
    } else {
      rl.close();
    }
  });

  let stagedImages: ImageAttachment[] = [];
  let stagedFiles: FileAttachment[] = [];

  const runTurn = async (
    text: string,
    images?: ImageAttachment[],
    files?: FileAttachment[],
  ): Promise<void> => {
    currentController = new AbortController();
    agent.signal = currentController.signal;
    try {
      await agent.run(text, images, files);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/abort/i.test(message)) console.error(style.red(message));
    } finally {
      currentController = null;
      renderer.endTurn(agent.contextUsage());
    }
  };

  try {
    while (true) {
    let line: string;
    try {
      line = await readLine(style.cyan("› "));
    } catch {
      break;
    }
    const input = line.trim();
    if (!input) continue;

    if (input.startsWith("/")) {
      const [command, ...rest] = input.slice(1).split(/\s+/);
      switch (command) {
        case "help":
          console.log(HELP);
          break;
        case "models":
          try {
            const current = await provider.listModels();
            for (const entry of current) {
              const marker = entry.name === agent.model ? style.green("●") : " ";
              const details = [entry.parameterSize, entry.quantization]
                .filter(Boolean)
                .join(" ");
              console.log(`${marker} ${entry.name}${details ? style.dim(`  ${details}`) : ""}`);
            }
          } catch (error) {
            console.log(style.red(error instanceof Error ? error.message : String(error)));
          }
          break;
        case "rewind": {
          if (!agent.checkpoints) {
            console.log(style.dim("checkpoints are disabled"));
            break;
          }
          const checkpoints = await agent.checkpoints.list(50);
          const target = rest[0];
          if (!target || target === "list") {
            if (checkpoints.length === 0) {
              console.log(style.dim("no checkpoints in this session"));
              break;
            }
            console.log(style.dim("Most recent first; /rewind <n|id> restores files only."));
            checkpoints.forEach((checkpoint, index) => {
              console.log(
                `${index + 1}. ${style.bold(checkpoint.id)} ${style.dim(`· ${checkpoint.at} · ${checkpoint.tool}`)}`,
              );
              for (const file of checkpoint.files) console.log(`   ${file}`);
            });
            break;
          }
          let id = target;
          if (/^\d+$/.test(target)) {
            id = checkpoints[Number(target) - 1]?.id ?? "";
            if (!id) {
              console.log(style.dim(`no checkpoint ${target}`));
              break;
            }
          } else {
            const match = checkpoints.find(
              (checkpoint) =>
                checkpoint.id === target || checkpoint.id.startsWith(target),
            );
            if (!match) {
              console.log(style.dim(`unknown checkpoint "${target}"`));
              break;
            }
            id = match.id;
          }
          try {
            console.log(await agent.checkpoints.restore(id));
          } catch (error) {
            console.log(
              style.red(error instanceof Error ? error.message : String(error)),
            );
          }
          break;
        }
        case "telemetry": {
          if (!agent.telemetry) {
            console.log(style.dim("telemetry is disabled"));
            break;
          }
          const summary = await agent.telemetry.summary();
          console.log(
            `${summary.runs} run(s) · ${summary.turns} turn(s) · ${summary.inputTokens} in / ${summary.outputTokens} out · ${summary.toolCalls} tool call(s) · ${summary.toolErrors} error(s) · ${Math.round(summary.durationMs / 1000)}s`,
          );
          if (rest[0] === "runs") {
            for (const run of await agent.telemetry.list(20)) {
              console.log(formatTelemetry(run));
            }
          }
          break;
        }
        case "hooks": {
          hooks = await HooksEngine.load(cwd);
          agent.hooks = hooks;
          const entries = describeHooks(hooks);
          if (entries.length === 0) {
            console.log(
              style.dim(
                "no hooks; add ~/.config/ollama-agent/hooks.json or .ollama-agent/hooks.json",
              ),
            );
            break;
          }
          for (const entry of entries) console.log(entry);
          break;
        }
        case "skills": {
          skills = await loadSkills(cwd);
          agent.skills = skills;
          agent.setSystem(
            `${systemPrompt(cwd)}\n\n${agentCatalogPrompt(agentDefinitions)}`,
            skills,
          );
          if (skills.size === 0) {
            console.log(
              style.dim(
                "no skills found; add SKILL.md under ~/.config/ollama-agent/skills or .ollama-agent/skills",
              ),
            );
            break;
          }
          for (const skill of [...skills.values()].sort((a, b) =>
            a.name.localeCompare(b.name),
          )) {
            console.log(`${style.bold(skill.name)} ${style.dim(`(${skill.source})`)}`);
            console.log(`  ${style.dim(skill.description)}`);
          }
          break;
        }
        case "skill": {
          const name = rest[0];
          if (!name) {
            console.log(style.dim("usage: /skill <name>"));
            break;
          }
          const skill = agent.skills.get(name);
          if (!skill) {
            console.log(
              style.dim(
                `unknown skill "${name}"; available: ${[...agent.skills.keys()].sort().join(", ") || "(none)"}`,
              ),
            );
            break;
          }
          console.log(style.bold(skill.name));
          console.log(skill.body);
          console.log(style.dim(`root: ${skill.root}`));
          if (skill.files.length > 0) {
            console.log(style.dim(skill.files.join("\n")));
          }
          break;
        }
        case "agents": {
          agentDefinitions = await loadAgentDefinitions(cwd);
          agent.agentDefinitions = agentDefinitions;
          agent.setSystem(
            `${systemPrompt(cwd)}\n\n${agentCatalogPrompt(agentDefinitions)}`,
            agent.skills,
          );
          for (const definition of [...agentDefinitions.values()].sort((a, b) =>
            a.name.localeCompare(b.name),
          )) {
            const tags = [definition.builtin ? "builtin" : "custom"];
            if (definition.model) tags.push(definition.model);
            if (definition.permissionMode) tags.push(definition.permissionMode);
            console.log(
              `${style.bold(definition.name)} ${style.dim(`(${tags.join(" · ")})`)}`,
            );
            console.log(`  ${style.dim(definition.description)}`);
          }
          break;
        }
        case "team": {
          if (!agent.team) {
            console.log(style.dim("team mode is not available"));
            break;
          }
          const subcommand = rest[0];
          try {
            if (!subcommand || subcommand === "status") {
              console.log(await agent.team.statusText());
            } else if (subcommand === "tasks") {
              console.log(await agent.team.taskAction("lead", "list", {}));
            } else if (subcommand === "message") {
              const target = rest[1];
              const text = rest.slice(2).join(" ").trim();
              if (!target || !text) {
                console.log(style.dim("usage: /team message <name> <text>"));
                break;
              }
              console.log(await agent.team.sendMessage("user", target, text));
            } else if (subcommand === "review") {
              const target = rest[1];
              if (!target) {
                console.log(style.dim("usage: /team review <name> [--diff]"));
                break;
              }
              console.log(
                await agent.team.review("lead", target, {
                  diff: rest.includes("--diff"),
                }),
              );
            } else if (subcommand === "merge") {
              const target = rest[1];
              if (!target) {
                console.log(
                  style.dim(
                    "usage: /team merge <name> [--skip-tests] [--cleanup] [--test <cmd>]",
                  ),
                );
                break;
              }
              const flags = rest.slice(2);
              const testAt = flags.indexOf("--test");
              const options = testAt >= 0 ? flags.slice(0, testAt) : flags;
              const testCommand =
                testAt >= 0 ? flags.slice(testAt + 1).join(" ").trim() : undefined;
              console.log(style.dim(`merging ${target} through the trial-merge gate…`));
              console.log(
                await agent.team.merge("lead", target, {
                  testCommand: testCommand || undefined,
                  skipTests: options.includes("--skip-tests"),
                  cleanup: options.includes("--cleanup"),
                }),
              );
            } else if (subcommand === "stop") {
              const target = rest[1];
              if (!target) {
                console.log(
                  style.dim("usage: /team stop <name> [--remove-worktree]"),
                );
                break;
              }
              console.log(
                await agent.team.shutdown("lead", target, {
                  removeWorktree: rest.includes("--remove-worktree"),
                }),
              );
            } else if (subcommand === "transcript") {
              const target = rest[1];
              if (!target) {
                console.log(style.dim("usage: /team transcript <name>"));
                break;
              }
              const messages = await agent.team.transcript(target);
              for (const message of messages) {
                if (message.role === "user") {
                  const text = message.content
                    .filter((block) => block.type === "text")
                    .map((block) => (block.type === "text" ? block.text : ""))
                    .join("\n")
                    .trim();
                  if (text) console.log(style.dim(`→ ${text}`));
                } else if (message.role === "assistant") {
                  for (const block of message.content) {
                    if (block.type === "text" && block.text.trim()) {
                      console.log(block.text.trim());
                    } else if (block.type === "tool_use") {
                      console.log(style.dim(`[tool] ${block.name}`));
                    }
                  }
                }
              }
            } else {
              console.log(
                style.dim(
                  "usage: /team [status|tasks|review <name> [--diff]|merge <name> [--skip-tests] [--cleanup] [--test <cmd>]|stop <name> [--remove-worktree]|message <name> <text>|transcript <name>]",
                ),
              );
            }
          } catch (error) {
            console.log(style.red(error instanceof Error ? error.message : String(error)));
          }
          break;
        }
        case "model": {
          const name = rest.join(" ").trim();
          if (name) {
            agent.model = name;
            session.model = name;
            console.log(style.dim(`model → ${name}`));
          } else {
            console.log(style.dim(`model: ${agent.model}`));
          }
          break;
        }
        case "mode": {
          const value = rest[0] as PermissionMode | undefined;
          if (!value) {
            console.log(style.dim(`mode: ${permissions.mode}`));
          } else if (!PERMISSION_MODES.includes(value)) {
            console.log(style.red(`Unknown mode. Expected: ${PERMISSION_MODES.join(", ")}`));
          } else {
            permissions.setMode(value);
            console.log(style.dim(`mode → ${value}`));
          }
          break;
        }
        case "think": {
          const value = rest[0];
          if (value === "on") agent.think = true;
          else if (value === "off") agent.think = false;
          else agent.think = !agent.think;
          renderer.setShowThinking(agent.think);
          console.log(style.dim(`think → ${agent.think ? "on" : "off"}`));
          break;
        }
        case "mcp": {
          if (!mcp) {
            console.log(style.dim("no MCP servers configured"));
            break;
          }
          if (rest[0] === "reconnect") {
            const statuses = await mcp.reconnect(rest[1]);
            for (const server of statuses) {
              const mark = server.ok ? style.green("●") : style.red("✗");
              const detail = server.ok ? `${server.toolCount} tool(s)` : (server.error ?? "failed");
              console.log(`${mark} ${server.name} — ${detail}`);
            }
            break;
          }
          if (rest[0] === "logout") {
            const name = rest[1];
            if (!name) {
              console.log(style.dim("usage: /mcp logout <server>"));
              break;
            }
            await clearToken(name);
            console.log(style.dim(`cleared OAuth token for ${name}`));
            break;
          }
          for (const server of mcp.servers) {
            const mark = server.ok ? style.green("●") : style.red("✗");
            const label = server.serverName ? ` ${style.dim(`(${server.serverName})`)}` : "";
            const detail = server.ok
              ? `${server.toolCount} tool(s)`
              : (server.error ?? "failed");
            console.log(`${mark} ${server.name}${label} — ${detail}`);
          }
          break;
        }
        case "resources": {
          if (!mcp || mcp.resources.length === 0) {
            console.log(style.dim("no MCP resources"));
            break;
          }
          for (const resource of mcp.resources.slice(0, 50)) {
            const label = resource.name ?? resource.title ?? "";
            console.log(
              `${style.dim(resource.server)}  ${resource.uri}` +
                `${label ? `  ${style.dim(label)}` : ""}` +
                `${resource.mimeType ? `  ${style.dim(resource.mimeType)}` : ""}`,
            );
          }
          if (mcp.resources.length > 50) {
            console.log(style.dim(`… ${mcp.resources.length - 50} more`));
          }
          break;
        }
        case "resource": {
          if (!mcp) {
            console.log(style.dim("no MCP servers configured"));
            break;
          }
          const [serverName, uri] = rest;
          if (!serverName || !uri) {
            console.log(style.dim("usage: /resource <server> <uri>"));
            break;
          }
          try {
            const contents = await mcp.readResource(serverName, uri);
            if (contents.length === 0) {
              console.log(style.dim("(empty resource)"));
            }
            for (const content of contents) {
              if (typeof content.text === "string") {
                console.log(content.text.slice(0, 8000));
              } else {
                const size = content.blob?.length ?? 0;
                console.log(
                  style.dim(`[blob ${content.mimeType ?? "unknown"}, ${size} base64 chars]`),
                );
              }
            }
          } catch (error) {
            console.log(style.red(error instanceof Error ? error.message : String(error)));
          }
          break;
        }
        case "prompts": {
          if (!mcp || mcp.prompts.length === 0) {
            console.log(style.dim("no MCP prompts"));
            break;
          }
          for (const prompt of mcp.prompts) {
            const args = (prompt.arguments ?? [])
              .map((arg) => `${arg.name}${arg.required ? "*" : ""}`)
              .join(", ");
            console.log(
              `${style.dim(prompt.server)}  ${prompt.name}` +
                `${args ? `  ${style.dim(`(${args})`)}` : ""}` +
                `${prompt.description ? `  ${style.dim(prompt.description)}` : ""}`,
            );
          }
          break;
        }
        case "prompt": {
          if (!mcp) {
            console.log(style.dim("no MCP servers configured"));
            break;
          }
          const [serverName, promptName, ...pairs] = rest;
          if (!serverName || !promptName) {
            console.log(style.dim("usage: /prompt <server> <name> [key=value ...]"));
            break;
          }
          const args: Record<string, string> = {};
          for (const pair of pairs) {
            const separator = pair.indexOf("=");
            if (separator > 0) {
              args[pair.slice(0, separator)] = pair.slice(separator + 1);
            }
          }
          try {
            const result = await mcp.getPrompt(serverName, promptName, args);
            console.log(style.dim(`[prompt ${serverName}/${promptName}]`));
            await runTurn(mcpPromptToText(result));
          } catch (error) {
            console.log(style.red(error instanceof Error ? error.message : String(error)));
          }
          break;
        }
        case "image": {
          const target = rest.join(" ").trim();
          if (!target) {
            console.log(style.dim("usage: /image <path> | /image clear"));
            break;
          }
          if (target === "clear") {
            stagedImages = [];
            console.log(style.dim("staged images cleared"));
            break;
          }
          try {
            if (stagedImages.length >= 8) {
              console.log(style.red("at most 8 images per message"));
              break;
            }
            const attachment = await loadImageAttachment(
              path.resolve(cwd, target),
              { maxBytes: MAX_IMAGE_BYTES },
            );
            stagedImages.push(attachment);
            const kb = Math.round(((attachment.data.length * 3) / 4) / 1024);
            console.log(
              style.dim(
                `image attached: ${attachment.name} (${attachment.mimeType}, ~${kb} KB) · ` +
                  `${stagedImages.length} staged`,
              ),
            );
          } catch (error) {
            console.log(style.red(error instanceof Error ? error.message : String(error)));
          }
          break;
        }
        case "images": {
          if (stagedImages.length === 0) {
            console.log(style.dim("no staged images"));
            break;
          }
          for (const image of stagedImages) {
            console.log(style.dim(`${image.name ?? "image"}  ${image.mimeType}`));
          }
          break;
        }
        case "file": {
          const target = rest.join(" ").trim();
          if (!target) {
            console.log(style.dim("usage: /file <path>"));
            break;
          }
          try {
            if (stagedFiles.length >= MAX_ATTACHMENTS) {
              console.log(style.red(`at most ${MAX_ATTACHMENTS} files per message`));
              break;
            }
            const attachment = await readFileAttachment(path.resolve(cwd, target));
            stagedFiles.push(attachment);
            const bytes = attachment.size ?? 0;
            const sizeLabel =
              bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
            console.log(
              style.dim(
                `file attached: ${attachment.name} (${attachment.kind}, ${sizeLabel}) · ` +
                  `${stagedFiles.length} staged`,
              ),
            );
          } catch (error) {
            console.log(style.red(error instanceof Error ? error.message : String(error)));
          }
          break;
        }
        case "files": {
          if (rest[0] === "clear") {
            stagedFiles = [];
            console.log(style.dim("staged files cleared"));
            break;
          }
          if (stagedFiles.length === 0) {
            console.log(style.dim("no staged files"));
            break;
          }
          for (const file of stagedFiles) {
            console.log(style.dim(`${file.name}  ${file.kind}  ${file.mimeType}`));
          }
          break;
        }
        case "clear":
          agent.reset();
          stagedImages = [];
          stagedFiles = [];
          console.log(style.dim("conversation cleared"));
          break;
        case "session":
          console.log(session.file);
          break;
        case "exit":
        case "quit":
          rl.close();
          return;
        default:
          console.log(style.dim(`Unknown command /${command}. Try /help.`));
      }
      continue;
    }

    const turnImages = stagedImages;
    const turnFiles = stagedFiles;
    stagedImages = [];
    stagedFiles = [];
    await runTurn(
      input,
      turnImages.length > 0 ? turnImages : undefined,
      turnFiles.length > 0 ? turnFiles : undefined,
    );
  }
  } finally {
    rl.close();
    await mcp?.close();
  }
}

await main();

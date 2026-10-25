import { createInterface } from "node:readline/promises";
import process from "node:process";
import path from "node:path";
import { Agent } from "./core/agent.ts";
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
  node src/index.ts [options]

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
  /mcp [reconnect <server>]  /resources  /resource <server> <uri>
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

  const permissions = new PermissionEngine(options.mode, ask);
  const agent = new Agent({
    provider,
    model,
    tools,
    permissions,
    session,
    cwd,
    system: systemPrompt(cwd),
    think: options.think,
    numCtx: options.numCtx,
    messages: prior,
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

  const runTurn = async (text: string): Promise<void> => {
    currentController = new AbortController();
    agent.signal = currentController.signal;
    try {
      await agent.run(text);
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
        case "clear":
          agent.reset();
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

    await runTurn(input);
  }
  } finally {
    rl.close();
    await mcp?.close();
  }
}

await main();

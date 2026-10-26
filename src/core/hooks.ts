import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "SubagentStop",
  "TaskCreated",
  "TaskCompleted",
  "TeammateIdle",
  "SessionEnd",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export interface HookCommand {
  event: HookEvent;
  matcher?: string;
  command: string;
  timeoutMs: number;
}

export interface HookResult {
  blocked: boolean;
  reason?: string;
  output?: string;
}

type RawHook = {
  matcher?: unknown;
  command?: unknown;
  timeoutMs?: unknown;
  hooks?: unknown;
};

function normaliseEvent(value: string): HookEvent | undefined {
  return HOOK_EVENTS.find((event) => event === value);
}

function asCommands(
  event: HookEvent,
  value: unknown,
): HookCommand[] {
  if (!Array.isArray(value)) return [];
  const commands: HookCommand[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as RawHook;
    const matcher =
      typeof entry.matcher === "string" ? entry.matcher.trim() : undefined;
    const timeout =
      typeof entry.timeoutMs === "number" && entry.timeoutMs > 0
        ? Math.min(Math.floor(entry.timeoutMs), 60_000)
        : 10_000;
    if (typeof entry.command === "string" && entry.command.trim()) {
      commands.push({ event, matcher, command: entry.command, timeoutMs: timeout });
    }
    if (Array.isArray(entry.hooks)) {
      for (const nested of entry.hooks) {
        if (!nested || typeof nested !== "object") continue;
        const hook = nested as RawHook;
        if (typeof hook.command !== "string" || !hook.command.trim()) continue;
        const nestedTimeout =
          typeof hook.timeoutMs === "number" && hook.timeoutMs > 0
            ? Math.min(Math.floor(hook.timeoutMs), 60_000)
            : timeout;
        commands.push({
          event,
          matcher,
          command: hook.command,
          timeoutMs: nestedTimeout,
        });
      }
    }
  }
  return commands;
}

function parseConfig(raw: unknown): HookCommand[] {
  if (!raw || typeof raw !== "object") return [];
  const root = raw as Record<string, unknown>;
  const source =
    root.hooks && typeof root.hooks === "object"
      ? (root.hooks as Record<string, unknown>)
      : root;
  const commands: HookCommand[] = [];
  for (const [key, value] of Object.entries(source)) {
    const event = normaliseEvent(key);
    if (!event) continue;
    commands.push(...asCommands(event, value));
  }
  return commands;
}

export function parseHooksConfig(raw: unknown): HookCommand[] {
  return parseConfig(raw);
}

async function readConfig(file: string): Promise<HookCommand[]> {
  try {
    return parseConfig(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return [];
  }
}

async function findGitRoot(start: string): Promise<string | undefined> {
  let current = path.resolve(start);
  const root = path.parse(current).root;
  while (true) {
    try {
      const entries = await readdir(current);
      if (entries.includes(".git")) return current;
    } catch {
      // keep walking
    }
    if (current === root) return undefined;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function projectHookFiles(cwd: string): Promise<string[]> {
  const start = path.resolve(cwd);
  const gitRoot = await findGitRoot(start);
  if (!gitRoot) {
    return [path.join(start, ".ollama-agent", "hooks.json")];
  }
  const chain: string[] = [];
  let current = start;
  while (true) {
    chain.push(current);
    if (current === gitRoot) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return chain
    .reverse()
    .map((directory) => path.join(directory, ".ollama-agent", "hooks.json"));
}

function matches(matcher: string | undefined, tool: string): boolean {
  if (!matcher || matcher === "*") return true;
  try {
    return new RegExp(matcher).test(tool);
  } catch {
    return tool.includes(matcher);
  }
}

function tail(value: string, limit = 4_000): string {
  return value.length > limit ? value.slice(-limit) : value;
}

function runCommand(
  hook: HookCommand,
  payload: Record<string, unknown>,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(hook.command, {
      shell: true,
      cwd: typeof payload.cwd === "string" ? payload.cwd : process.cwd(),
      env: { ...process.env, OLLAMA_AGENT_HOOK_EVENT: hook.event },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, output: tail(output.trim()) });
    };
    timer = setTimeout(() => {
      output += "\n[hook timed out]";
      child.kill("SIGKILL");
      finish(124);
    }, hook.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 200_000) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      output += `\n${error.message}`;
      finish(1);
    });
    child.on("close", (code) => finish(code ?? 1));
    child.stdin.on("error", () => {});
    try {
      child.stdin.end(`${JSON.stringify(payload)}\n`);
    } catch {
      // The command may not read stdin.
    }
  });
}

export class HooksEngine {
  readonly commands: HookCommand[];

  constructor(commands: HookCommand[] = []) {
    this.commands = commands;
  }

  static async load(cwd: string): Promise<HooksEngine> {
    const commands: HookCommand[] = [];
    const files = [
      path.join(homedir(), ".config", "ollama-agent", "hooks.json"),
      ...(await projectHookFiles(cwd)),
    ];
    for (const file of files) {
      commands.push(...(await readConfig(file)));
    }
    return new HooksEngine(commands);
  }

  has(event: HookEvent): boolean {
    return this.commands.some((hook) => hook.event === event);
  }

  async run(
    event: HookEvent,
    payload: Record<string, unknown>,
  ): Promise<HookResult> {
    const tool = typeof payload.tool === "string" ? payload.tool : "";
    const applicable = this.commands.filter(
      (hook) => hook.event === event && matches(hook.matcher, tool),
    );
    if (applicable.length === 0) return { blocked: false };

    const body = { event, ...payload };
    const outputs: string[] = [];
    for (const hook of applicable) {
      const result = await runCommand(hook, body);
      if (result.output) outputs.push(result.output);
      const timeoutBlocks =
        result.code === 124 &&
        (event === "PreToolUse" || event === "UserPromptSubmit");
      if (result.code === 2 || timeoutBlocks) {
        return {
          blocked: true,
          reason:
            result.output ||
            `${event} hook blocked ${tool || "the event"} (exit ${result.code}).`,
          output: outputs.join("\n"),
        };
      }
    }
    return {
      blocked: false,
      output: outputs.length > 0 ? outputs.join("\n") : undefined,
    };
  }
}

export function describeHooks(engine: HooksEngine): string[] {
  return engine.commands.map(
    (hook) =>
      `${hook.event}${hook.matcher ? ` [${hook.matcher}]` : ""}: ${hook.command}`,
  );
}

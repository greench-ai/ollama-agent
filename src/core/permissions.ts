import type { Tool, ToolContext } from "./types.ts";

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions";

export const PERMISSION_MODES: PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
];

export type AskOutcome = "allow" | "deny" | "always";

export type AskFn = (request: {
  tool: string;
  input: Record<string, unknown>;
  summary: string;
  mutating: boolean;
}) => Promise<AskOutcome>;

export interface PermissionRequest {
  tool: string;
  input: Record<string, unknown>;
  mutating: boolean;
}

export interface PermissionResult {
  allowed: boolean;
  reason?: string;
}

const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Stable key used for "always allow" within a session. */
export function ruleKey(tool: string, input: Record<string, unknown>): string {
  if (tool === "Bash") {
    const command = typeof input.command === "string" ? input.command.trim() : "";
    const head = command.split(/\s+/)[0] ?? "";
    return head ? `Bash(${head})` : "Bash";
  }
  return tool;
}

export function summarizeToolInput(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case "Bash":
      return typeof input.command === "string" ? input.command : "(no command)";
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
      return typeof input.file_path === "string" ? input.file_path : "(no path)";
    case "Glob":
      return typeof input.pattern === "string" ? input.pattern : "(no pattern)";
    case "Grep":
      return typeof input.pattern === "string" ? input.pattern : "(no pattern)";
    case "TodoWrite":
      return `${Array.isArray(input.todos) ? input.todos.length : 0} item(s)`;
    case "Task":
      return typeof input.description === "string" ? input.description : "";
    case "ExitPlanMode":
      return "proposed plan";
    case "TeamSpawn": {
      const name = typeof input.name === "string" ? input.name : "teammate";
      const role = typeof input.role === "string" ? input.role : "";
      return role ? `${name} (${role})` : name;
    }
    case "TeamRun":
      return typeof input.name === "string" ? input.name : "";
    case "TeamAwait":
      return Array.isArray(input.names) ? input.names.join(", ") : "all active";
    case "TeamTask": {
      const action = typeof input.action === "string" ? input.action : "task";
      const id = typeof input.taskId === "string" ? input.taskId : "";
      const title = typeof input.title === "string" ? input.title : "";
      return [action, id || title].filter(Boolean).join(" ");
    }
    case "TeamMessage": {
      const to = typeof input.to === "string" ? input.to : "?";
      const text = typeof input.text === "string" ? input.text : "";
      return `to ${to}${text ? `: ${text.slice(0, 60)}` : ""}`;
    }
    case "TeamStatus":
      return "";
    case "TeamReview":
      return typeof input.name === "string" ? input.name : "";
    case "TeamMerge": {
      const name = typeof input.name === "string" ? input.name : "";
      const test = typeof input.testCommand === "string" ? input.testCommand : "";
      const skip = input.skipTests === true ? "skip tests" : "";
      return [name, test, skip].filter(Boolean).join(" · ");
    }
    case "TeamShutdown":
      return [
        typeof input.name === "string" ? input.name : "",
        input.removeWorktree === true ? "remove worktree" : "",
      ]
        .filter(Boolean)
        .join(" · ");
    default: {
      const first = Object.entries(input)[0];
      if (!first) return "";
      if (first[1] === null || first[1] === undefined) return first[0];
      const value = typeof first[1] === "string" ? first[1] : JSON.stringify(first[1]);
      return `${first[0]}=${value}`.slice(0, 120);
    }
  }
}

export class PermissionEngine {
  mode: PermissionMode;
  private ask?: AskFn;
  private alwaysAllow = new Set<string>();

  constructor(mode: PermissionMode = "default", ask?: AskFn) {
    this.mode = mode;
    this.ask = ask;
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  /** Share approval state and the ask handler with a child in another mode. */
  fork(mode: PermissionMode = this.mode): PermissionEngine {
    const engine = new PermissionEngine(mode, this.ask);
    for (const key of this.alwaysAllow) engine.alwaysAllow.add(key);
    return engine;
  }

  async check(request: PermissionRequest): Promise<PermissionResult> {
    if (this.mode === "bypassPermissions") return { allowed: true };

    if (!request.mutating) return { allowed: true };

    if (this.mode === "plan") {
      return {
        allowed: false,
        reason: `Plan mode is read-only; ${request.tool} is disabled.`,
      };
    }

    if (this.mode === "acceptEdits" && EDIT_TOOLS.has(request.tool)) {
      return { allowed: true };
    }

    if (this.alwaysAllow.has(ruleKey(request.tool, request.input))) {
      return { allowed: true };
    }

    if (!this.ask) {
      return {
        allowed: false,
        reason: "No approval handler is configured; mutating tools are blocked.",
      };
    }

    const summary = summarizeToolInput(request.tool, request.input);
    const outcome = await this.ask({
      tool: request.tool,
      input: request.input,
      summary,
      mutating: true,
    });
    if (outcome === "always") {
      this.alwaysAllow.add(ruleKey(request.tool, request.input));
      return { allowed: true };
    }
    if (outcome === "allow") return { allowed: true };
    return { allowed: false, reason: "Denied by user." };
  }
}

/**
 * Filter the registry down to tools allowed in the current mode. This only
 * removes obviously disallowed tools; per-call permission still runs.
 */
export function toolsForMode(tools: Tool[], mode: PermissionMode): Tool[] {
  if (mode === "plan") {
    // ExitPlanMode is the one tool that can end plan mode.
    return tools.filter((tool) => !tool.mutating);
  }
  // Outside plan mode there is nothing to exit from.
  return tools.filter((tool) => tool.name !== "ExitPlanMode");
}

export function formatPermissionBanner(
  tool: string,
  summary: string,
  ctx: ToolContext,
): string {
  const where = tool === "Bash" ? ctx.cwd : "";
  return `${tool}${summary ? `: ${summary}` : ""}${where ? `  (${where})` : ""}`;
}

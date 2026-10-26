import type { TeamController } from "../core/team.ts";
import type { Tool, ToolContext, ToolResult } from "../core/types.ts";
import { optionalNumber, optionalString, requireString } from "./shared.ts";

function controller(ctx: ToolContext): TeamController {
  if (!ctx.team) {
    throw new Error("Team mode is not available in this context.");
  }
  return ctx.team;
}

function requireLead(ctx: ToolContext): void {
  if (ctx.teamRole !== "lead") {
    throw new Error("Only the team lead can perform this action.");
  }
}

function stringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  if (typeof value === "string" && value.trim()) {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return undefined;
}

const spawnTool: Tool = {
  name: "TeamSpawn",
  description:
    "Create a named teammate from an agent definition and optionally start it " +
    "on a task. Teammates have their own context and session; they run in the " +
    "background unless wait is true. Only the lead can spawn. Use " +
    "TeamAwait to collect results, TeamTask to coordinate, TeamMessage to talk.",
  mutating: true,
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Unique teammate name (slug)." },
      role: {
        type: "string",
        description:
          "Agent definition name, e.g. implementer, reviewer, tester, explore, plan, general-purpose.",
      },
      prompt: {
        type: "string",
        description: "Initial task for the teammate. Omit to create it idle.",
      },
      model: { type: "string", description: "Optional model override." },
      wait: {
        type: "boolean",
        description: "Wait for the initial task to finish (default false).",
      },
      isolation: {
        type: "string",
        enum: ["worktree", "none"],
        description:
          "Override the definition's isolation. worktree creates a git worktree " +
          "on its own branch; none shares the lead's tree.",
      },
    },
    required: ["name", "role"],
  },
  async run(input, ctx): Promise<ToolResult> {
    requireLead(ctx);
    const name = requireString(input, "name");
    const role = requireString(input, "role");
    const prompt = optionalString(input, "prompt");
    const model = optionalString(input, "model");
    const wait = input.wait === true;
    const isolation =
      input.isolation === "worktree" || input.isolation === "none"
        ? input.isolation
        : undefined;
    const message = await controller(ctx).spawn("lead", {
      name,
      role,
      prompt,
      model,
      wait,
      isolation,
    });
    return { content: message };
  },
};

const runTool: Tool = {
  name: "TeamRun",
  description:
    "Start a turn for an existing teammate. Returns immediately unless wait is " +
    "true. Use TeamAwait to collect background work.",
  mutating: true,
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      prompt: { type: "string", description: "Task or message for the teammate." },
      wait: { type: "boolean", description: "Wait for completion (default false)." },
    },
    required: ["name", "prompt"],
  },
  async run(input, ctx): Promise<ToolResult> {
    const name = requireString(input, "name");
    const prompt = requireString(input, "prompt");
    const message = await controller(ctx).run(
      ctx.agentName ?? "lead",
      name,
      prompt,
      input.wait === true,
    );
    return { content: message };
  },
};

const awaitTool: Tool = {
  name: "TeamAwait",
  description:
    "Wait for background teammate runs to finish and return the team board with " +
    "their latest reports. Omit names to wait for all active runs.",
  mutating: false,
  inputSchema: {
    type: "object",
    properties: {
      names: {
        type: "array",
        items: { type: "string" },
        description: "Teammates to wait for; omit for all.",
      },
      timeoutMs: {
        type: "integer",
        description: "Maximum wait in milliseconds (default 180000).",
      },
    },
  },
  async run(input, ctx): Promise<ToolResult> {
    const names = stringArray(input.names);
    const timeoutMs = optionalNumber(input, "timeoutMs");
    const message = await controller(ctx).awaitMembers(names, timeoutMs);
    return { content: message };
  },
};

const taskTool: Tool = {
  name: "TeamTask",
  description:
    "Shared team task board. create a task, list tasks, claim a pending task for " +
    "yourself, complete it with a result, or block it with a reason. Tasks may " +
    "depend on other tasks and reserve file paths to avoid conflicts.",
  mutating: false,
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["create", "list", "claim", "complete", "block"],
      },
      taskId: { type: "string" },
      title: { type: "string" },
      description: { type: "string" },
      dependsOn: {
        type: "array",
        items: { type: "string" },
        description: "Task ids that must complete first.",
      },
      files: {
        type: "array",
        items: { type: "string" },
        description: "File paths this task will modify; overlapping tasks serialize.",
      },
      assignee: { type: "string", description: "Optional assignee for create." },
      result: { type: "string" },
      reason: { type: "string" },
    },
    required: ["action"],
  },
  async run(input, ctx): Promise<ToolResult> {
    const action = requireString(input, "action") as
      | "create"
      | "list"
      | "claim"
      | "complete"
      | "block";
    if (!["create", "list", "claim", "complete", "block"].includes(action)) {
      throw new Error(`Unknown task action "${action}".`);
    }
    const message = await controller(ctx).taskAction(
      ctx.agentName ?? "lead",
      action,
      input,
    );
    return { content: message };
  },
};

const messageTool: Tool = {
  name: "TeamMessage",
  description:
    "Send a message to one teammate or to all teammates. Idle recipients start a " +
    "turn with the message; busy recipients receive it after their run finishes.",
  mutating: false,
  inputSchema: {
    type: "object",
    properties: {
      to: { type: "string", description: "Teammate name or \"all\"." },
      text: { type: "string" },
    },
    required: ["to", "text"],
  },
  async run(input, ctx): Promise<ToolResult> {
    const to = requireString(input, "to");
    const text = requireString(input, "text");
    const message = await controller(ctx).sendMessage(
      ctx.agentName ?? "lead",
      to,
      text,
    );
    return { content: message };
  },
};

const statusTool: Tool = {
  name: "TeamStatus",
  description:
    "Return the team board: members and their status, tasks, and message counts.",
  mutating: false,
  inputSchema: { type: "object", properties: {} },
  async run(_input, ctx): Promise<ToolResult> {
    return { content: await controller(ctx).statusText() };
  },
};

const shutdownTool: Tool = {
  name: "TeamShutdown",
  description:
    "Stop a teammate and mark it offline. Only the lead can shut down teammates. " +
    "Set removeWorktree to discard its worktree and branch; otherwise they remain " +
    "for review.",
  mutating: false,
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      removeWorktree: {
        type: "boolean",
        description: "Remove the worktree and branch after stopping (default false).",
      },
    },
    required: ["name"],
  },
  async run(input, ctx): Promise<ToolResult> {
    requireLead(ctx);
    const name = requireString(input, "name");
    return {
      content: await controller(ctx).shutdown("lead", name, {
        removeWorktree: input.removeWorktree === true,
      }),
    };
  },
};

const reviewTool: Tool = {
  name: "TeamReview",
  description:
    "Review a teammate's worktree: branch, base, commits ahead, working-tree " +
    "status, diff stat, and optionally the full diff. Read-only. Only the lead " +
    "can review.",
  mutating: false,
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      diff: {
        type: "boolean",
        description: "Include the full diff (truncated). Default false.",
      },
      maxChars: {
        type: "integer",
        description: "Diff character cap (default 12000).",
      },
    },
    required: ["name"],
  },
  async run(input, ctx): Promise<ToolResult> {
    requireLead(ctx);
    const name = requireString(input, "name");
    const maxChars = optionalNumber(input, "maxChars");
    return {
      content: await controller(ctx).review("lead", name, {
        diff: input.diff === true,
        maxChars,
      }),
    };
  },
};

const mergeTool: Tool = {
  name: "TeamMerge",
  description:
    "Merge a teammate's worktree branch into the lead branch through a serialized " +
    "gate: commits its changes, performs a trial merge in a scratch worktree, runs " +
    "the project's test command, and merges only if the trial merge is clean and " +
    "tests pass. Conflicts are never resolved automatically. The lead tree must " +
    "be clean. Only the lead can merge.",
  mutating: true,
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      testCommand: {
        type: "string",
        description:
          "Test command to run in the trial merge. Defaults to the detected " +
          "package.json/Cargo/go/Make test command.",
      },
      skipTests: {
        type: "boolean",
        description:
          "Skip tests (trial merge still runs). Use only when the project has no " +
          "meaningful test command.",
      },
      cleanup: {
        type: "boolean",
        description:
          "Remove the worktree and delete its branch after a successful merge.",
      },
      timeoutMs: {
        type: "integer",
        description: "Test timeout in milliseconds (default 300000).",
      },
    },
    required: ["name"],
  },
  async run(input, ctx): Promise<ToolResult> {
    requireLead(ctx);
    const name = requireString(input, "name");
    return {
      content: await controller(ctx).merge("lead", name, {
        testCommand: optionalString(input, "testCommand"),
        skipTests: input.skipTests === true,
        cleanup: input.cleanup === true,
        timeoutMs: optionalNumber(input, "timeoutMs"),
      }),
    };
  },
};

export const teamTools: Tool[] = [
  spawnTool,
  runTool,
  awaitTool,
  taskTool,
  messageTool,
  statusTool,
  reviewTool,
  mergeTool,
  shutdownTool,
];

export const memberTeamTools: Tool[] = [taskTool, messageTool, statusTool];

export const TEAM_TOOL_NAMES = new Set(teamTools.map((tool) => tool.name));

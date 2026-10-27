import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { PERMISSION_MODES, type PermissionMode } from "./permissions.ts";

export interface ProjectInstructions {
  path: string;
  content: string;
}

const INSTRUCTION_FILES = [".ollama-agent.md", "AGENTS.md", "CLAUDE.md"];
const MAX_INSTRUCTIONS = 20_000;

export async function assertDirectory(directory: string): Promise<string> {
  const resolved = path.resolve(directory);
  const info = await stat(resolved);
  if (!info.isDirectory()) throw new Error(`Not a directory: ${resolved}`);
  return resolved;
}

export async function loadProjectInstructions(
  cwd: string,
): Promise<ProjectInstructions | undefined> {
  for (const name of INSTRUCTION_FILES) {
    const file = path.join(cwd, name);
    try {
      const text = await readFile(file, "utf8");
      if (text.trim()) {
        return { path: file, content: text.slice(0, MAX_INSTRUCTIONS) };
      }
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

/**
 * Tools whose behavior is worth a line of guidance in the prompt. Listing the
 * registry verbatim is not enough: a model needs to know *when* to reach for
 * these. Anything not named here still appears in the tool list.
 */
const TOOL_NOTES: Record<string, string> = {
  Read: "read a file before editing it; never guess at its contents",
  Edit: "prefer Edit over Write for existing files so unrelated lines survive",
  MultiEdit: "use one MultiEdit rather than a chain of Edit calls on one file",
  Bash: "use for builds, tests, and git; prefer Read/Grep/Glob over cat/find/grep",
  Grep: "search contents by regex; this is faster than grep through Bash",
  Glob: "find files by name pattern",
  Task: "delegate a self-contained search or implementation to a subagent",
  Skill: "load a skill before following its instructions; never guess their contents",
  TodoWrite: "track multi-step work and keep exactly one item in progress",
  ToolSearch: "load a deferred tool's schema before calling it",
};

export interface SystemPromptOptions {
  cwd: string;
  /** Live tool names from the registry actually given to this agent. */
  toolNames?: string[];
  mode?: PermissionMode;
  instructions?: ProjectInstructions;
  /** Subagent definitions, so Task can be described accurately. */
  subagents?: string[];
  /** Skills advertised in the catalog. */
  skillNames?: string[];
  /** Extra sections appended verbatim (catalogs, environment notes). */
  extra?: string[];
  /** True for subagents, which get a narrower mandate than the lead. */
  subagent?: boolean;
}

function toolSection(toolNames: string[]): string {
  if (toolNames.length === 0) return "";
  const sorted = [...toolNames].sort((a, b) => a.localeCompare(b));
  const withNotes = sorted.filter((name) => TOOL_NOTES[name]);
  const plain = sorted.filter((name) => !TOOL_NOTES[name]);
  const lines: string[] = [`Available tools: ${sorted.join(", ")}.`];
  if (withNotes.length > 0) {
    lines.push("");
    lines.push("When to use them:");
    for (const name of withNotes) lines.push(`- ${name}: ${TOOL_NOTES[name]}`);
  }
  if (plain.length > 0) {
    lines.push("");
    lines.push(
      `Other tools are available but not annotated here; read each tool's ` +
        `description before first use: ${plain.join(", ")}.`,
    );
  }
  return lines.join("\n");
}

/**
 * Working rules, filtered to the tools this agent actually has. Telling a
 * model to use TodoWrite or Edit when neither is in the registry is worse
 * than saying nothing: it wastes a turn discovering the tool is missing.
 */
function rulesSection(has: (name: string) => boolean): string {
  const rules: string[] = ["Use absolute file paths."];
  if (has("Read") && (has("Edit") || has("Write") || has("MultiEdit"))) {
    rules.push("Read a file before editing it; never guess at its contents.");
  }
  if (has("Bash")) {
    rules.push("Prefer Read, Grep, and Glob over cat, find, and grep in Bash.");
  }
  rules.push("Keep changes minimal and consistent with the surrounding code.");
  if (has("TodoWrite")) {
    rules.push("Use TodoWrite for multi-step work and keep one item in progress.");
  }
  if (has("Edit") || has("Write") || has("MultiEdit") || has("Bash")) {
    rules.push(
      "After changing code, run the project's check (typecheck or tests) and " +
        "report the actual result. Do not claim a change works without it.",
    );
  }
  rules.push(
    "If a tool result is confusing or contradicts what you expected, say so " +
      "rather than guessing; re-reading a file is cheaper than a wrong edit.",
  );
  rules.push("When finished, state what changed and what you verified.");
  return ["Working rules", ...rules.map((rule) => `- ${rule}`)].join("\n");
}

function modeSection(mode: PermissionMode, toolNames: string[]): string {
  switch (mode) {
    case "plan":
      return (
        `You are in plan mode: read-only. Investigate, then present a plan. ` +
        `Mutating tools are disabled and will be rejected.`
      );
    case "acceptEdits":
      return (
        `You are in accept-editing mode. File edits apply without confirmation; ` +
        `shell commands still need approval.`
      );
    case "bypassPermissions":
      return (
        `Permissions are bypassed: tool calls run without confirmation. Be ` +
        `careful with destructive commands.`
      );
    default:
      return (
        `Mutating tools require the user's approval. The harness asks; do not ` +
        `ask for permission in prose or stop to request confirmation.`
      );
  }
}

/**
 * Build the system prompt for an agent.
 *
 * One builder for the CLI, HTTP server, ACP server, and desktop shell, so the
 * advertised tool set can never drift from the registry actually passed to the
 * agent. Previously each entry point carried its own copy and they disagreed.
 */
export function buildSystemPrompt(options: SystemPromptOptions): string {
  const { cwd, toolNames = [], mode = "default", instructions, subagents } = options;
  const who = options.subagent
    ? `You are a coding subagent working in ${cwd}.`
    : `You are a coding agent working in ${cwd}.`;

  const sections: string[] = [who];

  const environment = [
    `Environment`,
    `- Working directory: ${cwd}`,
    `- Platform: ${process.platform}`,
    `- Permission mode: ${mode}`,
  ];
  sections.push(environment.join("\n"));

  const tools = toolSection(toolNames);
  if (tools) sections.push(tools);
  if (subagents && subagents.length > 0) {
    sections.push(
      `Subagent types for the Task tool: ${[...subagents].sort().join(", ")}.`,
    );
  }

  sections.push(modeSection(mode, toolNames));

  const available = new Set(toolNames);
  sections.push(rulesSection((name) => available.has(name)));

  if (instructions) {
    sections.push(`Project instructions (${instructions.path}):\n${instructions.content}`);
  }
  for (const extra of options.extra ?? []) {
    if (extra.trim()) sections.push(extra.trim());
  }
  return sections.join("\n\n");
}

export { PERMISSION_MODES };

import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { PERMISSION_MODES, type PermissionMode } from "./permissions.ts";

export interface AgentDefinition {
  name: string;
  description: string;
  systemPrompt: string;
  /** "inherit" or a model name. */
  model?: string;
  tools?: string[];
  disallowedTools?: string[];
  permissionMode?: PermissionMode;
  maxTurns?: number;
  isolation?: "worktree" | "none";
  background?: boolean;
  source: string;
  builtin: boolean;
}

const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    name: "general-purpose",
    description:
      "General-purpose worker with the full tool set. Use for self-contained multi-step tasks.",
    systemPrompt:
      "You are a general-purpose coding subagent. Work autonomously on one delegated task and report concisely.",
    source: "builtin",
    builtin: true,
  },
  {
    name: "explore",
    description:
      "Read-only codebase explorer. Use for broad searches and mapping unfamiliar code.",
    systemPrompt:
      "You are a read-only exploration subagent. Find and report facts, file paths, and structure. Do not modify files or run mutating commands.",
    tools: ["Read", "Glob", "Grep", "TodoWrite"],
    permissionMode: "plan",
    source: "builtin",
    builtin: true,
  },
  {
    name: "plan",
    description:
      "Read-only planner. Investigates the codebase and returns an implementation plan.",
    systemPrompt:
      "You are a planning subagent. Investigate read-only, then return a concrete implementation plan with files, steps, risks, and verification.",
    tools: ["Read", "Glob", "Grep", "TodoWrite"],
    permissionMode: "plan",
    source: "builtin",
    builtin: true,
  },
  {
    name: "implementer",
    description:
      "Implementation worker. Reads, edits, and runs commands for one scoped task.",
    systemPrompt:
      "You are an implementation subagent. Make focused changes for one task, run relevant checks, and report exactly what changed and what you verified.",
    tools: [
      "Read",
      "Write",
      "Edit",
      "MultiEdit",
      "Bash",
      "Glob",
      "Grep",
      "TodoWrite",
    ],
    isolation: "worktree",
    source: "builtin",
    builtin: true,
  },
  {
    name: "reviewer",
    description:
      "Read-only reviewer. Inspects diffs and code for correctness, regressions, and missing tests.",
    systemPrompt:
      "You are a code review subagent. Work read-only. Report findings ordered by severity with file paths, concrete failure scenarios, and suggested fixes. Do not edit files.",
    tools: ["Read", "Glob", "Grep", "TodoWrite"],
    permissionMode: "plan",
    source: "builtin",
    builtin: true,
  },
  {
    name: "tester",
    description:
      "Test runner. Runs focused test commands and reports failures with diagnosis.",
    systemPrompt:
      "You are a testing subagent. Run the relevant test commands, diagnose failures, and report the exact commands, outputs, and suspected causes. Prefer existing test entry points.",
    tools: ["Read", "Bash", "Glob", "Grep", "TodoWrite"],
    source: "builtin",
    builtin: true,
  },
];

export function builtinAgentDefinitions(): Map<string, AgentDefinition> {
  return new Map(BUILTIN_AGENTS.map((definition) => [definition.name, definition]));
}

function parseScalar(value: string): string | number | boolean {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

export function parseFrontmatter(
  text: string,
): { data: Record<string, unknown>; body: string } | undefined {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return undefined;
  const end = normalized.indexOf("\n---", 4);
  if (end < 0) return undefined;

  const header = normalized.slice(4, end);
  const body = normalized.slice(end + 4).replace(/^\n/, "").trim();
  const data: Record<string, unknown> = {};
  const lines = header.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    const rest = match[2].trim();
    const block = /^([>|])([+-]?)$/.exec(rest);
    if (block) {
      const collected: string[] = [];
      let probe = index + 1;
      while (probe < lines.length) {
        const next = lines[probe];
        if (!next.trim()) {
          collected.push("");
          probe += 1;
          continue;
        }
        if (/^\s+/.test(next)) {
          collected.push(next);
          probe += 1;
          continue;
        }
        break;
      }
      const nonEmpty = collected.filter((line) => line.trim().length > 0);
      const indent =
        nonEmpty.length > 0
          ? Math.min(
              ...nonEmpty.map((line) => /^\s*/.exec(line)?.[0].length ?? 0),
            )
          : 0;
      const stripped = collected.map((line) =>
        line.trim() ? line.slice(indent) : "",
      );
      if (block[1] === "|") {
        data[key] = stripped.join("\n").trimEnd();
      } else {
        const paragraphs: string[][] = [];
        let current: string[] = [];
        for (const line of stripped) {
          if (line.trim()) {
            current.push(line.trim());
          } else if (current.length > 0) {
            paragraphs.push(current);
            current = [];
          }
        }
        if (current.length > 0) paragraphs.push(current);
        data[key] = paragraphs.map((entry) => entry.join(" ")).join("\n\n");
      }
      index = probe - 1;
      continue;
    }
    if (!rest) {
      const list: string[] = [];
      let probe = index + 1;
      while (probe < lines.length && /^\s*-\s+/.test(lines[probe])) {
        list.push(String(parseScalar(lines[probe].replace(/^\s*-\s+/, ""))));
        probe += 1;
      }
      data[key] = list.length > 0 ? list : "";
      index = probe - 1;
      continue;
    }
    data[key] = parseScalar(rest);
  }

  return { data, body };
}

function asList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value
      .map((entry) => String(entry).trim())
      .filter((entry) => entry.length > 0);
    return items.length > 0 ? items : undefined;
  }
  if (typeof value === "string" && value.trim()) {
    const items = value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    return items.length > 0 ? items : undefined;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function listMarkdownFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listMarkdownFiles(full)));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(full);
    }
  }
  return files;
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

async function projectAgentDirectories(cwd: string): Promise<string[]> {
  const start = path.resolve(cwd);
  const gitRoot = await findGitRoot(start);
  if (!gitRoot) {
    return [
      path.join(start, ".ollama-agent", "agents"),
      path.join(start, ".agents", "agents"),
    ];
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
  // Farthest first so the directory closest to cwd wins.
  return chain
    .reverse()
    .flatMap((directory) => [
      path.join(directory, ".ollama-agent", "agents"),
      path.join(directory, ".agents", "agents"),
    ]);
}

export async function resolveAgentDefinition(
  file: string,
): Promise<AgentDefinition | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return undefined;
  }
  const parsed = parseFrontmatter(text);
  if (!parsed) return undefined;

  const { data, body } = parsed;
  const name =
    asString(data.name) ?? path.basename(file).replace(/\.md$/i, "");
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return undefined;
  const description = asString(data.description);
  if (!description) return undefined;

  let permissionMode: PermissionMode | undefined;
  if (typeof data.permissionMode === "string") {
    if (PERMISSION_MODES.includes(data.permissionMode as PermissionMode)) {
      permissionMode = data.permissionMode as PermissionMode;
    }
  }

  const maxTurnsRaw = data.maxTurns;
  const maxTurns =
    typeof maxTurnsRaw === "number" && maxTurnsRaw > 0
      ? Math.floor(maxTurnsRaw)
      : typeof maxTurnsRaw === "string" && /^\d+$/.test(maxTurnsRaw)
        ? Number(maxTurnsRaw)
        : undefined;

  const isolation =
    data.isolation === "worktree"
      ? "worktree"
      : data.isolation === "none"
        ? "none"
        : undefined;

  return {
    name,
    description,
    systemPrompt: body,
    model: asString(data.model) ?? (data.model === "inherit" ? "inherit" : undefined),
    tools: asList(data.tools),
    disallowedTools: asList(data.disallowedTools),
    permissionMode,
    maxTurns,
    isolation,
    background: data.background === true || data.background === "true",
    source: file,
    builtin: false,
  };
}

/**
 * Load built-ins, then user definitions, then project definitions. Later
 * scopes override earlier ones by `name`.
 */
export async function loadAgentDefinitions(
  cwd: string,
  options: { userDir?: string } = {},
): Promise<Map<string, AgentDefinition>> {
  const definitions = builtinAgentDefinitions();
  const directories = [
    options.userDir ?? path.join(homedir(), ".config", "ollama-agent", "agents"),
    ...(await projectAgentDirectories(cwd)),
  ];

  for (const directory of directories) {
    for (const file of await listMarkdownFiles(directory)) {
      const definition = await resolveAgentDefinition(file);
      if (definition) definitions.set(definition.name, definition);
    }
  }
  return definitions;
}

export function agentCatalogPrompt(
  definitions: Map<string, AgentDefinition>,
): string {
  const lines = [...definitions.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((definition) => `- ${definition.name}: ${definition.description}`);
  return `Available subagent types for the Task tool:\n${lines.join("\n")}`;
}

export type AgentDefinitionSummary = Omit<AgentDefinition, "systemPrompt">;

export function summarizeAgentDefinitions(
  definitions: Map<string, AgentDefinition>,
): AgentDefinitionSummary[] {
  return [...definitions.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((definition) => {
      const { systemPrompt: _prompt, ...summary } = definition;
      return summary;
    });
}

import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parseFrontmatter } from "./agent-definitions.ts";

export interface SkillDefinition {
  name: string;
  description: string;
  body: string;
  /** Directory containing SKILL.md; resource paths are relative to it. */
  root: string;
  source: string;
  files: string[];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function listFiles(root: string, limit = 200): Promise<string[]> {
  const results: string[] = [];
  const stack = [""];
  while (stack.length > 0 && results.length < limit) {
    const relative = stack.pop() as string;
    let entries;
    try {
      entries = await readdir(path.join(root, relative), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (results.length >= limit) break;
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const next = relative ? path.join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) stack.push(next);
      else if (entry.isFile()) results.push(next);
    }
  }
  return results.sort();
}

export async function resolveSkill(
  file: string,
): Promise<SkillDefinition | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return undefined;
  }
  const parsed = parseFrontmatter(text);
  if (!parsed) return undefined;
  const root = path.dirname(file);
  const name =
    asString(parsed.data.name) ?? path.basename(root);
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return undefined;
  const description = asString(parsed.data.description);
  if (!description) return undefined;
  const body = parsed.body.trim();
  if (!body) return undefined;
  return {
    name,
    description,
    body,
    root,
    source: file,
    files: await listFiles(root),
  };
}

async function listSkillFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(directory, entry.name, "SKILL.md");
    try {
      await readFile(candidate);
      files.push(candidate);
    } catch {
      // Not a skill directory.
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

async function projectSkillDirectories(cwd: string): Promise<string[]> {
  const start = path.resolve(cwd);
  const gitRoot = await findGitRoot(start);
  const names = [".ollama-agent", ".agents", ".claude"];
  if (!gitRoot) {
    return names.map((name) => path.join(start, name, "skills"));
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
    .flatMap((directory) =>
      names.map((name) => path.join(directory, name, "skills")),
    );
}

/**
 * Load skills from user scopes, then project scopes. Project skills override
 * user skills by name. Claude-style `~/.claude/skills` and `.claude/skills`
 * directories are read for compatibility.
 */
export async function loadSkills(
  cwd: string,
  options: { userDirs?: string[] } = {},
): Promise<Map<string, SkillDefinition>> {
  const skills = new Map<string, SkillDefinition>();
  const directories = [
    options.userDirs?.[0] ??
      path.join(homedir(), ".config", "ollama-agent", "skills"),
    ...(options.userDirs?.slice(1) ?? [path.join(homedir(), ".claude", "skills")]),
    ...(await projectSkillDirectories(cwd)),
  ];

  for (const directory of directories) {
    for (const file of await listSkillFiles(directory)) {
      const skill = await resolveSkill(file);
      if (skill) skills.set(skill.name, skill);
    }
  }
  return skills;
}

export function skillCatalogPrompt(
  skills: Map<string, SkillDefinition>,
): string {
  if (skills.size === 0) return "";
  const lines = [...skills.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 80)
    .map((skill) => {
      const description =
        skill.description.length > 180
          ? `${skill.description.slice(0, 177)}…`
          : skill.description;
      return `- ${skill.name}: ${description}`;
    });
  return [
    "Available skills. When a task matches one, call the Skill tool with its",
    "name first and follow the loaded instructions. Do not guess their contents.",
    ...lines,
  ].join("\n");
}

export function withSkillCatalog(
  system: string,
  skills: Map<string, SkillDefinition>,
): string {
  const catalog = skillCatalogPrompt(skills);
  return catalog ? `${system}\n\n${catalog}` : system;
}

export type SkillSummary = Omit<SkillDefinition, "body">;

export function summarizeSkills(
  skills: Map<string, SkillDefinition>,
): SkillSummary[] {
  return [...skills.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ body: _body, ...summary }) => summary);
}

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

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

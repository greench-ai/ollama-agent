import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";

export class ToolInputError extends Error {}

export function requireString(
  input: Record<string, unknown>,
  key: string,
): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ToolInputError(`Missing required string parameter "${key}".`);
  }
  return value;
}

export function optionalString(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function optionalNumber(
  input: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = input[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function requireAbsolutePath(input: Record<string, unknown>, key = "file_path"): string {
  const value = requireString(input, key);
  if (!path.isAbsolute(value)) {
    throw new ToolInputError(`"${key}" must be an absolute path (got "${value}").`);
  }
  return value;
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[truncated ${text.length - limit} chars]`;
}

export function displayPath(target: string, cwd: string): string {
  const relative = path.relative(cwd, target);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative;
  }
  return target;
}

function escapeLiteral(text: string): string {
  return text.replace(/[\\^$+.()|\[\]{}*?]/g, "\\$&");
}

/** Translate a glob into a RegExp. Handles **, *, ?, and {a,b}. */
export function globToRegExp(pattern: string): RegExp {
  const braces = pattern.replace(/\{([^}]+)\}/g, (_, group: string) => {
    return `(${group.split(",").map(escapeLiteral).join("|")})`;
  });
  let out = "";
  for (let i = 0; i < braces.length; i += 1) {
    const char = braces[i];
    if (char === "*") {
      if (braces[i + 1] === "*") {
        out += ".*";
        i += 1;
        if (braces[i + 1] === "/") i += 1;
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else if ("\\^$+.()|[]".includes(char)) {
      out += `\\${char}`;
    } else {
      out += char;
    }
  }
  return new RegExp(`^${out}$`);
}

const SKIP_DIRECTORIES = new Set(["node_modules", ".git", ".hg", ".svn"]);

export async function walkFiles(root: string, limit = 5000): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const results: string[] = [];
  const stack = [root];
  while (stack.length > 0 && results.length < limit) {
    const directory = stack.pop() as string;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (results.length >= limit) break;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) stack.push(full);
      } else if (entry.isFile()) {
        results.push(full);
      }
    }
  }
  return results;
}

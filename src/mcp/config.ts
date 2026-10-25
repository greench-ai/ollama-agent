import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { agentHome } from "../core/session.ts";

export type McpServerConfig =
  | {
      type?: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
    }
  | {
      type?: "http" | "sse";
      url: string;
      headers?: Record<string, string>;
    };

export interface McpConfigResult {
  path?: string;
  servers: Record<string, McpServerConfig>;
}

/** Expand ${VAR} and ${VAR:-fallback} in config strings. */
export function expandEnv(value: string): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (_, name: string, fallback?: string) => process.env[name] ?? fallback ?? "",
  );
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") out[key] = expandEnv(entry);
  }
  return out;
}

export function parseMcpConfig(
  raw: unknown,
  source: string,
): Record<string, McpServerConfig> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${source}: expected a JSON object.`);
  }
  const root = raw as Record<string, unknown>;
  const serversRaw = root.mcpServers ?? root.servers;
  if (!serversRaw || typeof serversRaw !== "object" || Array.isArray(serversRaw)) {
    throw new Error(`${source}: missing an "mcpServers" object.`);
  }

  const servers: Record<string, McpServerConfig> = {};
  for (const [name, value] of Object.entries(serversRaw as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      throw new Error(`${source}: server name "${name}" must be alphanumeric.`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${source}: server "${name}" must be an object.`);
    }
    const entry = value as Record<string, unknown>;

    if (typeof entry.url === "string" && entry.url.length > 0) {
      const type = entry.type === "sse" ? "sse" : "http";
      servers[name] = {
        type,
        url: expandEnv(entry.url),
        headers: stringRecord(entry.headers),
      };
      continue;
    }

    if (typeof entry.command === "string" && entry.command.length > 0) {
      const args = Array.isArray(entry.args)
        ? entry.args.filter((arg): arg is string => typeof arg === "string").map(expandEnv)
        : undefined;
      servers[name] = {
        type: "stdio",
        command: expandEnv(entry.command),
        args,
        env: stringRecord(entry.env),
        cwd: typeof entry.cwd === "string" ? expandEnv(entry.cwd) : undefined,
      };
      continue;
    }

    throw new Error(
      `${source}: server "${name}" needs either a "command" (stdio) or "url" (http).`,
    );
  }
  return servers;
}

export function candidatePaths(cwd: string): string[] {
  return [
    path.join(cwd, ".mcp.json"),
    path.join(agentHome(), "mcp.json"),
    path.join(homedir(), ".config", "ollama-agent", "mcp.json"),
  ];
}

/**
 * Load MCP servers. An explicit path must exist; otherwise the first existing
 * candidate wins. Returns an empty set when nothing is configured.
 */
export async function loadMcpConfig(
  explicit?: string,
  cwd = process.cwd(),
): Promise<McpConfigResult> {
  const candidates = explicit ? [path.resolve(cwd, explicit)] : candidatePaths(cwd);

  for (const candidate of candidates) {
    let text: string;
    try {
      text = await readFile(candidate, "utf8");
    } catch (error) {
      if (explicit) {
        throw new Error(
          `Could not read MCP config at ${candidate}: ${error instanceof Error ? error.message : error}`,
        );
      }
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw new Error(
        `Invalid JSON in MCP config ${candidate}: ${error instanceof Error ? error.message : error}`,
      );
    }
    return { path: candidate, servers: parseMcpConfig(raw, candidate) };
  }

  return { servers: {} };
}

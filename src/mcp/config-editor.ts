import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { agentHome } from "../core/session.ts";
import { parseMcpConfig, type McpServerConfig } from "./config.ts";

export interface RawMcpConfig {
  mcpServers: Record<string, unknown>;
  [key: string]: unknown;
}

export interface McpConfigFile {
  raw: RawMcpConfig;
  servers: Record<string, McpServerConfig>;
}

export function defaultMcpConfigPath(): string {
  return path.join(agentHome(), "mcp.json");
}

export async function readMcpConfigFile(
  configPath: string,
): Promise<McpConfigFile> {
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { raw: { mcpServers: {} }, servers: {} };
    }
    throw error;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Invalid JSON in ${configPath}: ${error instanceof Error ? error.message : error}`,
    );
  }
  const servers = parseMcpConfig(raw, configPath);
  const object = raw as Record<string, unknown>;
  return {
    raw: {
      ...object,
      mcpServers:
        object.mcpServers &&
        typeof object.mcpServers === "object" &&
        !Array.isArray(object.mcpServers)
          ? (object.mcpServers as Record<string, unknown>)
          : {},
    },
    servers,
  };
}

function assertName(name: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(
      "Connector names may contain letters, digits, dots, underscores, and dashes.",
    );
  }
}

async function writeConfig(
  configPath: string,
  raw: RawMcpConfig,
): Promise<Record<string, McpServerConfig>> {
  const servers = parseMcpConfig(raw, configPath);
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(raw, null, 2), "utf8");
  return servers;
}

export async function saveMcpServer(
  configPath: string,
  name: string,
  entry: unknown,
): Promise<McpConfigFile> {
  assertName(name);
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error("Connector configuration must be an object.");
  }
  const existing = await readMcpConfigFile(configPath);
  const raw: RawMcpConfig = {
    ...existing.raw,
    mcpServers: { ...existing.raw.mcpServers, [name]: entry },
  };
  const servers = await writeConfig(configPath, raw);
  return { raw, servers };
}

export async function removeMcpServer(
  configPath: string,
  name: string,
): Promise<McpConfigFile> {
  assertName(name);
  const existing = await readMcpConfigFile(configPath);
  const mcpServers = { ...existing.raw.mcpServers };
  delete mcpServers[name];
  const raw: RawMcpConfig = { ...existing.raw, mcpServers };
  const servers = await writeConfig(configPath, raw);
  return { raw, servers };
}

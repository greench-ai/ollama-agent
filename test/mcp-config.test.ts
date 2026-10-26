import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  readMcpConfigFile,
  removeMcpServer,
  saveMcpServer,
} from "../src/mcp/config-editor.ts";

test("connector edits preserve raw env templates and unrelated keys", async () => {
  process.env.MCP_TEMPLATE_TOKEN = "resolved-secret";
  const dir = await mkdtemp(path.join(tmpdir(), "agent-mcp-config-"));
  const configPath = path.join(dir, "mcp.json");

  await saveMcpServer(configPath, "fs", {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    env: { TOKEN: "${MCP_TEMPLATE_TOKEN}" },
  });

  const raw = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(raw.mcpServers.fs.env.TOKEN, "${MCP_TEMPLATE_TOKEN}");

  const parsed = await readMcpConfigFile(configPath);
  const server = parsed.servers.fs;
  assert.ok("command" in server);
  assert.equal(server.env?.TOKEN, "resolved-secret");

  await saveMcpServer(configPath, "remote", {
    type: "http",
    url: "https://example.test/mcp",
    auth: { type: "oauth", scopes: ["mcp.read"] },
  });
  const withRemote = await readMcpConfigFile(configPath);
  assert.deepEqual(Object.keys(withRemote.servers).sort(), ["fs", "remote"]);

  await removeMcpServer(configPath, "fs");
  const afterRemove = await readMcpConfigFile(configPath);
  assert.deepEqual(Object.keys(afterRemove.servers), ["remote"]);
  const rawAfter = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(rawAfter.mcpServers.fs, undefined);
});

test("connector edits validate names and entries", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-mcp-config-"));
  const configPath = path.join(dir, "mcp.json");
  await assert.rejects(
    () => saveMcpServer(configPath, "bad name", { command: "node" }),
    /may contain letters/,
  );
  await assert.rejects(
    () => saveMcpServer(configPath, "broken", {}),
    /needs either a "command"/,
  );
});

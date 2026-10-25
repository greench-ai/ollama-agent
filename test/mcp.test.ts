import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { McpClient, mcpPromptToText, mcpResultToText } from "../src/mcp/client.ts";
import { expandEnv, parseMcpConfig } from "../src/mcp/config.ts";
import { McpManager } from "../src/mcp/manager.ts";
import type { ToolContext } from "../src/core/types.ts";

const fixture = fileURLToPath(new URL("./fixtures/mcp-echo-server.mjs", import.meta.url));

function context(): ToolContext {
  return {
    cwd: process.cwd(),
    sessionId: "mcp-test",
    signal: new AbortController().signal,
    todos: [],
    log: () => {},
  };
}

test("config parsing validates entries and expands environment variables", () => {
  process.env.MCP_TEST_TOKEN = "s3cret";
  const servers = parseMcpConfig(
    {
      mcpServers: {
        local: {
          command: "node",
          args: ["${MCP_TEST_TOKEN}.js"],
          env: { TOKEN: "${MCP_TEST_TOKEN}" },
        },
        remote: {
          url: "https://example.test/mcp",
          headers: { authorization: "Bearer ${MCP_TEST_TOKEN}" },
        },
      },
    },
    "test",
  );

  const local = servers.local;
  assert.ok("command" in local);
  assert.deepEqual(local.args, ["s3cret.js"]);
  assert.equal(local.env?.TOKEN, "s3cret");

  const remote = servers.remote;
  assert.ok("url" in remote);
  assert.equal(remote.headers?.authorization, "Bearer s3cret");

  assert.throws(
    () => parseMcpConfig({ mcpServers: { broken: {} } }, "test"),
    /needs either a "command"/,
  );
  assert.equal(expandEnv("${MISSING:-fallback}"), "fallback");
});

test("stdio client initializes, lists tools, and calls one", async () => {
  const client = await McpClient.connect("echo", {
    command: process.execPath,
    args: [fixture],
  });
  try {
    assert.equal(client.serverInfo.name, "echo-fixture");
    const tools = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ["echo", "write_note"],
    );

    const result = await client.callTool("echo", { text: "hi" });
    assert.equal(mcpResultToText(result), "echo:hi");
  } finally {
    await client.close();
  }
});

test("manager namespaces tools and derives mutability from annotations", async () => {
  const manager = await McpManager.start({
    echo: { command: process.execPath, args: [fixture] },
  });
  try {
    assert.equal(manager.servers.length, 1);
    assert.equal(manager.servers[0].ok, true);

    const byName = new Map(manager.tools.map((tool) => [tool.name, tool]));
    assert.deepEqual([...byName.keys()].sort(), ["echo__echo", "echo__write_note"]);
    assert.equal(byName.get("echo__echo")?.mutating, false);
    assert.equal(byName.get("echo__write_note")?.mutating, true);

    const output = await byName.get("echo__echo")!.run({ text: "wrapped" }, context());
    assert.match(output.content, /echo:wrapped/);
  } finally {
    await manager.close();
  }
});

test("resources and prompts are listed, read, and rendered", async () => {
  const client = await McpClient.connect("echo", {
    command: process.execPath,
    args: [fixture],
  });
  try {
    const resources = await client.listResources();
    assert.equal(resources.length, 1);
    assert.equal(resources[0].uri, "note://hello");

    const contents = await client.readResource("note://hello");
    assert.equal(contents[0].text, "resource-body");

    const prompts = await client.listPrompts();
    assert.equal(prompts[0].name, "greet");

    const prompt = await client.getPrompt("greet", { name: "Ada" });
    assert.match(mcpPromptToText(prompt), /Hello, Ada/);
  } finally {
    await client.close();
  }
});

test("manager exposes resources/prompts and reconnects after a drop", async () => {
  const manager = await McpManager.start({
    echo: { command: process.execPath, args: [fixture] },
  });
  try {
    assert.equal(manager.resources.length, 1);
    assert.equal(manager.prompts.length, 1);
    assert.equal(manager.resources[0].server, "echo");

    const contents = await manager.readResource("echo", "note://hello");
    assert.equal(contents[0].text, "resource-body");

    const prompt = await manager.getPrompt("echo", "greet", { name: "Ada" });
    assert.match(mcpPromptToText(prompt), /Hello, Ada/);

    // Simulate a dropped server and let a tool call reconnect it.
    await manager.clientFor("echo")?.close();
    assert.equal(manager.clientFor("echo")?.isConnected, false);
    const tool = manager.tools.find((entry) => entry.name === "echo__echo");
    assert.ok(tool);
    const result = await tool.run({ text: "after-drop" }, context());
    assert.match(result.content, /echo:after-drop/);
    assert.equal(manager.clientFor("echo")?.isConnected, true);

    const statuses = await manager.reconnect();
    assert.equal(statuses[0].ok, true);
    assert.equal(statuses[0].toolCount, 2);
  } finally {
    await manager.close();
  }
});

test("streamable HTTP transport works against a JSON-RPC endpoint", async () => {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      let message: { id?: number; method?: string };
      try {
        message = JSON.parse(body || "{}");
      } catch {
        response.writeHead(400).end();
        return;
      }
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      let result: unknown = {};
      if (message.method === "initialize") {
        result = {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "http-fixture", version: "1.0.0" },
        };
      } else if (message.method === "tools/list") {
        result = {
          tools: [
            {
              name: "clock",
              description: "Return a fixed time.",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        };
      } else if (message.method === "tools/call") {
        result = { content: [{ type: "text", text: "12:00" }] };
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    const client = await McpClient.connect("http", {
      url: `http://127.0.0.1:${port}/mcp`,
    });
    try {
      assert.equal(client.serverInfo.name, "http-fixture");
      const tools = await client.listTools();
      assert.equal(tools[0].name, "clock");
      const result = await client.callTool("clock", {});
      assert.equal(mcpResultToText(result), "12:00");
    } finally {
      await client.close();
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Agent } from "../src/core/agent.ts";
import { PermissionEngine } from "../src/core/permissions.ts";
import { Session } from "../src/core/session.ts";
import type {
  ChatRequest,
  Provider,
  ProviderEvent,
  Tool,
} from "../src/core/types.ts";
import { allTools } from "../src/tools/index.ts";

function mcpTool(name: string): Tool {
  return {
    name: `srv__${name}`,
    description: `Remote ${name} operation for the demo server.`,
    inputSchema: { type: "object", properties: {} },
    mutating: false,
    async run() {
      return { content: `mcp-ok:${name}` };
    },
  };
}

class SearchProvider implements Provider {
  readonly name = "scripted";
  calls: string[][] = [];

  async *chat(request: ChatRequest): AsyncGenerator<ProviderEvent> {
    this.calls.push(request.tools.map((tool) => tool.name));
    const index = this.calls.length;
    if (index === 1) {
      yield {
        type: "tool_call",
        call: { id: "call_search", name: "ToolSearch", input: { query: "alpha" } },
      };
      yield { type: "done", stopReason: "tool_use" };
      return;
    }
    if (index === 2) {
      yield {
        type: "tool_call",
        call: { id: "call_alpha", name: "srv__alpha", input: {} },
      };
      yield { type: "done", stopReason: "tool_use" };
      return;
    }
    yield { type: "text", text: "done" };
    yield { type: "done", stopReason: "end_turn" };
  }

  async listModels() {
    return [];
  }
}

async function makeAgent(
  tools: Tool[],
  options: { toolSearchThreshold?: number } = {},
) {
  process.env.OLLAMA_AGENT_HOME = await mkdtemp(
    path.join(tmpdir(), "agent-tool-search-home-"),
  );
  const cwd = await mkdtemp(path.join(tmpdir(), "agent-tool-search-cwd-"));
  const session = await Session.create({ cwd, model: "test-model" });
  return new Agent({
    provider: new SearchProvider(),
    model: "test-model",
    tools,
    permissions: new PermissionEngine("bypassPermissions"),
    session,
    cwd,
    system: "test",
    teamsEnabled: false,
    toolSearchThreshold: options.toolSearchThreshold,
  });
}

test("defers MCP tools and loads them through ToolSearch", async () => {
  const provider = new SearchProvider();
  process.env.OLLAMA_AGENT_HOME = await mkdtemp(
    path.join(tmpdir(), "agent-tool-search-home-"),
  );
  const cwd = await mkdtemp(path.join(tmpdir(), "agent-tool-search-cwd-"));
  const session = await Session.create({ cwd, model: "test-model" });
  const agent = new Agent({
    provider,
    model: "test-model",
    tools: [...allTools, mcpTool("alpha"), mcpTool("beta"), mcpTool("gamma")],
    permissions: new PermissionEngine("bypassPermissions"),
    session,
    cwd,
    system: "test",
    teamsEnabled: false,
    toolSearchThreshold: 5,
  });

  await agent.run("use alpha");
  assert.equal(provider.calls.length, 3);
  assert.ok(provider.calls[0]?.includes("ToolSearch"));
  assert.ok(!provider.calls[0]?.includes("srv__alpha"));
  assert.ok(provider.calls[1]?.includes("srv__alpha"));
  assert.ok(!provider.calls[1]?.includes("srv__beta"));
  const result = agent.messages
    .flatMap((message) => message.content)
    .find((block) => block.type === "tool_result" && block.name === "srv__alpha");
  assert.ok(result && result.type === "tool_result");
  assert.match(result.content, /mcp-ok:alpha/);
});

test("does not defer when the tool set is small", async () => {
  const agent = await makeAgent(allTools);
  const names = agent.tools.map((tool) => tool.name);
  assert.ok(!names.includes("ToolSearch"));
  assert.ok(names.includes("Read"));
});

test("setTools re-applies deferral after an MCP reload", async () => {
  const agent = await makeAgent(allTools, { toolSearchThreshold: 5 });
  assert.ok(!agent.tools.some((tool) => tool.name === "ToolSearch"));
  agent.setTools([
    ...allTools,
    mcpTool("alpha"),
    mcpTool("beta"),
    mcpTool("gamma"),
  ]);
  assert.ok(agent.tools.some((tool) => tool.name === "ToolSearch"));
  assert.ok(!agent.tools.some((tool) => tool.name === "srv__alpha"));
  assert.match(agent.system, /Deferred tools/);
  agent.setTools(allTools);
  assert.ok(!agent.tools.some((tool) => tool.name === "ToolSearch"));
  assert.doesNotMatch(agent.system, /Deferred tools/);
});

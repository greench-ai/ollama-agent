import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Agent } from "../src/core/agent.ts";
import { PermissionEngine } from "../src/core/permissions.ts";
import { Session } from "../src/core/session.ts";
import { allTools } from "../src/tools/index.ts";
import type {
  ChatRequest,
  Provider,
  ProviderEvent,
  SubagentType,
} from "../src/core/types.ts";

class DelegatingProvider implements Provider {
  readonly name = "scripted";
  calls: ChatRequest[] = [];
  private subagentType: SubagentType;

  constructor(subagentType: SubagentType) {
    this.subagentType = subagentType;
  }

  async *chat(request: ChatRequest): AsyncGenerator<ProviderEvent> {
    // The agent owns the live message array; snapshot it per call.
    this.calls.push({ ...request, messages: structuredClone(request.messages) });
    if (request.system?.includes("subagent")) {
      yield { type: "text", text: "child report: found three files" };
      yield { type: "done", stopReason: "end_turn" };
      return;
    }

    const hasToolResult = request.messages.some((message) =>
      message.content.some((block) => block.type === "tool_result"),
    );
    if (!hasToolResult) {
      yield {
        type: "tool_call",
        call: {
          id: "call_task_1",
          name: "Task",
          input: {
            description: "Find the files",
            prompt: "Search the repository and report which files matter.",
            subagent_type: this.subagentType,
            name: "scout",
          },
        },
      };
      yield { type: "done", stopReason: "tool_use" };
      return;
    }

    yield { type: "text", text: "parent done" };
    yield { type: "done", stopReason: "end_turn" };
  }

  async listModels() {
    return [];
  }
}

async function makeAgent(
  provider: Provider,
  options: { maxDepth?: number; mode?: "default" | "plan" | "bypassPermissions" } = {},
) {
  const home = await mkdtemp(path.join(tmpdir(), "agent-sub-home-"));
  process.env.OLLAMA_AGENT_HOME = home;
  const cwd = await mkdtemp(path.join(tmpdir(), "agent-sub-cwd-"));
  const session = await Session.create({ cwd, model: "test-model" });
  const events: string[] = [];
  const agent = new Agent({
    provider,
    model: "test-model",
    tools: allTools,
    permissions: new PermissionEngine(options.mode ?? "bypassPermissions"),
    session,
    cwd,
    system: "parent prompt",
    maxDepth: options.maxDepth,
    onEvent: (event) => events.push(event.type),
  });
  return { agent, events };
}

test("Task runs an isolated read-only subagent and returns its report", async () => {
  const provider = new DelegatingProvider("explore");
  const { agent, events } = await makeAgent(provider);

  await agent.run("delegate this");

  assert.equal(provider.calls.length, 3, "parent, child, parent");
  const child = provider.calls[1];
  assert.match(child.system ?? "", /subagent/);
  assert.ok(
    !child.tools.some((tool) => tool.name === "Task"),
    "child cannot spawn subagents",
  );
  const mutatingNames = new Set(["Write", "Edit", "MultiEdit", "Bash"]);
  assert.ok(
    child.tools.every((tool) => !mutatingNames.has(tool.name)),
    "explore subagent only gets read-only tools",
  );
  assert.ok(child.tools.some((tool) => tool.name === "Read"));

  const last = provider.calls[2].messages.at(-1);
  const result = last?.content.find((block) => block.type === "tool_result");
  assert.ok(result && result.type === "tool_result");
  assert.match(result.content, /child report: found three files/);
  assert.match(result.content, /Subagent report \(scout\)/);

  assert.ok(events.includes("subagent_start"));
  assert.ok(events.includes("subagent_end"));
});

test("general-purpose subagents get mutating tools but never Task", async () => {
  const provider = new DelegatingProvider("general-purpose");
  const { agent } = await makeAgent(provider);

  await agent.run("delegate again");

  const child = provider.calls[1];
  assert.ok(child.tools.some((tool) => tool.name === "Bash"));
  assert.ok(child.tools.some((tool) => tool.name === "Write"));
  assert.ok(!child.tools.some((tool) => tool.name === "Task"));
});

test("depth guard blocks nested subagents", async () => {
  const provider = new DelegatingProvider("general-purpose");
  const { agent } = await makeAgent(provider, { maxDepth: 0 });

  await agent.run("delegate");

  assert.equal(provider.calls.length, 2, "no child call was made");
  const last = provider.calls[1].messages.at(-1);
  const result = last?.content.find((block) => block.type === "tool_result");
  assert.ok(result && result.type === "tool_result");
  assert.match(result.content, /cannot spawn further subagents/);
});

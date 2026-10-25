import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Agent } from "../src/core/agent.ts";
import { PermissionEngine, toolsForMode } from "../src/core/permissions.ts";
import { Session } from "../src/core/session.ts";
import { allTools } from "../src/tools/index.ts";
import type { ChatRequest, Provider, ProviderEvent } from "../src/core/types.ts";

class PlanProvider implements Provider {
  readonly name = "scripted";
  calls: ChatRequest[] = [];

  async *chat(request: ChatRequest): AsyncGenerator<ProviderEvent> {
    this.calls.push({ ...request, messages: structuredClone(request.messages) });
    const hasResult = request.messages.some((message) =>
      message.content.some((block) => block.type === "tool_result"),
    );
    if (!hasResult) {
      yield {
        type: "tool_call",
        call: {
          id: "call_plan_1",
          name: "ExitPlanMode",
          input: { plan: "1. Edit app.ts\n2. Run tests" },
        },
      };
      yield { type: "done", stopReason: "tool_use" };
      return;
    }
    yield { type: "text", text: "continuing" };
    yield { type: "done", stopReason: "end_turn" };
  }

  async listModels() {
    return [];
  }
}

async function makeAgent(
  provider: Provider,
  approve: (plan: string) => Promise<{ approved: boolean; feedback?: string }>,
) {
  process.env.OLLAMA_AGENT_HOME = await mkdtemp(path.join(tmpdir(), "agent-plan-home-"));
  const cwd = await mkdtemp(path.join(tmpdir(), "agent-plan-cwd-"));
  const session = await Session.create({ cwd, model: "test-model" });
  const events: string[] = [];
  const agent = new Agent({
    provider,
    model: "test-model",
    tools: allTools,
    permissions: new PermissionEngine("plan"),
    session,
    cwd,
    system: "parent prompt",
    planApprover: approve,
    onEvent: (event) => events.push(event.type),
  });
  return { agent, events };
}

test("plan mode exposes ExitPlanMode and hides mutating tools", () => {
  const planTools = toolsForMode(allTools, "plan").map((tool) => tool.name);
  assert.ok(planTools.includes("ExitPlanMode"));
  assert.ok(planTools.includes("Read"));
  assert.ok(!planTools.includes("Write"));
  assert.ok(!planTools.includes("Bash"));

  const defaultTools = toolsForMode(allTools, "default").map((tool) => tool.name);
  assert.ok(!defaultTools.includes("ExitPlanMode"));
});

test("approved plans switch out of plan mode", async () => {
  const provider = new PlanProvider();
  const { agent, events } = await makeAgent(provider, async () => ({ approved: true }));

  await agent.run("plan this");

  assert.equal(agent.permissions.mode, "acceptEdits");
  const last = provider.calls.at(-1)?.messages.at(-1);
  const result = last?.content.find((block) => block.type === "tool_result");
  assert.ok(result && result.type === "tool_result");
  assert.match(result.content, /Plan approved/);
  assert.ok(events.includes("notice"));
});

test("rejected plans stay in plan mode and carry feedback", async () => {
  const provider = new PlanProvider();
  const { agent } = await makeAgent(provider, async () => ({
    approved: false,
    feedback: "add a test step",
  }));

  await agent.run("plan this");

  assert.equal(agent.permissions.mode, "plan");
  const last = provider.calls.at(-1)?.messages.at(-1);
  const result = last?.content.find((block) => block.type === "tool_result");
  assert.ok(result && result.type === "tool_result");
  assert.match(result.content, /Plan rejected/);
  assert.match(result.content, /add a test step/);
});

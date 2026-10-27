import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Agent } from "../src/core/agent.ts";
import { PermissionEngine } from "../src/core/permissions.ts";
import { Session } from "../src/core/session.ts";
import type { ChatRequest, Provider, ProviderEvent, Tool } from "../src/core/types.ts";

class ScriptedProvider implements Provider {
  readonly name = "scripted";
  private steps: Array<() => ProviderEvent[]>;

  constructor(steps: Array<() => ProviderEvent[]>) {
    this.steps = steps;
  }

  async *chat(_request: ChatRequest): AsyncGenerator<ProviderEvent> {
    const step = this.steps[this.stepIndex++] ?? (() => [
      { type: "text" as const, text: "done" },
      { type: "done" as const, stopReason: "end_turn" },
    ]);
    for (const event of step()) yield event;
  }

  private stepIndex = 0;

  async listModels() {
    return [];
  }
}

function faultyRead(runs: { count: number }): Tool {
  return {
    name: "Read",
    description: "read double",
    mutating: false,
    inputSchema: { type: "object", properties: {} },
    async run() {
      runs.count += 1;
      return { content: "read ok" };
    },
  };
}

async function makeAgent(tools: Tool[], steps: Array<() => ProviderEvent[]>) {
  if (!process.env.OLLAMA_AGENT_HOME) {
    process.env.OLLAMA_AGENT_HOME = await mkdtemp(path.join(tmpdir(), "agent-arg-home-"));
  }
  const cwd = await mkdtemp(path.join(tmpdir(), "agent-arg-cwd-"));
  const agent = new Agent({
    provider: new ScriptedProvider(steps),
    model: "scripted",
    tools,
    permissions: new PermissionEngine("bypassPermissions"),
    session: await Session.create({ cwd, model: "scripted" }),
    cwd,
    system: "test",
    teamsEnabled: false,
    checkpoints: false,
    telemetry: false,
    onEvent: () => {},
  });
  await agent.run("go");
  return agent;
}

function results(agent: Agent) {
  return agent.messages
    .flatMap((message) => message.content)
    .filter((block) => block.type === "tool_result");
}

test("a call with unparseable arguments never runs and reports the raw input", async () => {
  const runs = { count: 0 };
  const agent = await makeAgent([faultyRead(runs)], [
    () => [
      {
        type: "tool_call",
        call: {
          id: "bad-1",
          name: "Read",
          input: {},
          inputError: 'Arguments were not valid JSON (Unexpected token). Received: {"file_path": "/tmp/a"',
        },
      },
      { type: "done", stopReason: "tool_use" },
    ],
  ]);

  assert.equal(runs.count, 0, "the tool must not run with malformed arguments");
  const [result] = results(agent);
  assert.equal(result.is_error, true);
  assert.match(result.content as string, /could not be run/);
  assert.match(result.content as string, /not valid JSON/);
  assert.match(result.content as string, /Received: \{"file_path"/);
  assert.match(result.content as string, /Re-issue the call/);
});

test("a parse failure is reported in request order alongside good calls", async () => {
  const runs = { count: 0 };
  const agent = await makeAgent([faultyRead(runs)], [
    () => [
      { type: "tool_call", call: { id: "a", name: "Read", input: { key: 1 } } },
      {
        type: "tool_call",
        call: { id: "b", name: "Read", input: {}, inputError: "Arguments must be a JSON object; got string." },
      },
      { type: "tool_call", call: { id: "c", name: "Read", input: { key: 2 } } },
      { type: "done", stopReason: "tool_use" },
    ],
  ]);

  assert.equal(runs.count, 2);
  const toolResults = results(agent);
  assert.deepEqual(toolResults.map((block) => block.tool_use_id), ["a", "b", "c"]);
  assert.equal(toolResults[1].is_error, true);
  assert.match(toolResults[1].content as string, /got string/);
});

test("a parse failure never runs the tool twice via the repeat guard", async () => {
  const runs = { count: 0 };
  const agent = await makeAgent([faultyRead(runs)], [
    () => [
      { type: "tool_call", call: { id: "1", name: "Read", input: {}, inputError: "bad" } },
      { type: "tool_call", call: { id: "2", name: "Read", input: {}, inputError: "bad" } },
      { type: "tool_call", call: { id: "3", name: "Read", input: {}, inputError: "bad" } },
      { type: "done", stopReason: "tool_use" },
    ],
  ]);

  assert.equal(runs.count, 0);
  const toolResults = results(agent);
  // Each one keeps its own explanation rather than collapsing into a loop message.
  for (const block of toolResults) {
    assert.equal(block.is_error, true);
    assert.match(block.content as string, /could not be run/);
  }
});

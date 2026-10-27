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
  calls: ChatRequest[] = [];
  private steps: Array<() => ProviderEvent[]>;

  constructor(steps: Array<() => ProviderEvent[]>) {
    this.steps = steps;
  }

  async *chat(request: ChatRequest): AsyncGenerator<ProviderEvent> {
    this.calls.push({ ...request, messages: structuredClone(request.messages) });
    const step = this.steps[this.calls.length - 1];
    const events = step
      ? step()
      : [{ type: "text" as const, text: "done" }, { type: "done" as const, stopReason: "end_turn" }];
    for (const event of events) yield event;
  }

  async listModels() {
    return [];
  }
}

function call(id: string, name: string, input: Record<string, unknown> = {}): ProviderEvent {
  return { type: "tool_call", call: { id, name, input } };
}

function countingTool(name: string, runs: { count: number }): Tool {
  return {
    name,
    description: `${name} test double`,
    mutating: false,
    inputSchema: { type: "object", properties: {} },
    async run() {
      runs.count += 1;
      return { content: `ok:${runs.count}` };
    },
  };
}

async function makeAgent(
  tools: Tool[],
  steps: Array<() => ProviderEvent[]>,
  options: { teams?: boolean } = {},
) {
  if (!process.env.OLLAMA_AGENT_HOME) {
    process.env.OLLAMA_AGENT_HOME = await mkdtemp(path.join(tmpdir(), "agent-rep-home-"));
  }
  const cwd = await mkdtemp(path.join(tmpdir(), "agent-rep-cwd-"));
  const agent = new Agent({
    provider: new ScriptedProvider(steps),
    model: "scripted",
    tools,
    permissions: new PermissionEngine("bypassPermissions"),
    session: await Session.create({ cwd, model: "scripted" }),
    cwd,
    system: "test",
    teamsEnabled: options.teams ?? false,
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

test("the third identical call is blocked before it runs", async () => {
  const runs = { count: 0 };
  const agent = await makeAgent([countingTool("Read", runs)], [
    () => [
      call("1", "Read", { file_path: "/tmp/a" }),
      call("2", "Read", { file_path: "/tmp/a" }),
      call("3", "Read", { file_path: "/tmp/a" }),
      { type: "done", stopReason: "tool_use" },
    ],
  ]);

  assert.equal(runs.count, 2, "the tool must not execute a third time");
  const toolResults = results(agent);
  assert.equal(toolResults.length, 3);
  assert.equal(toolResults[2].is_error, true);
  assert.match(toolResults[2].content as string, /already called Read/);
  assert.match(toolResults[2].content as string, /different approach/);
});

test("blocked repeats are reported in request order", async () => {
  const runs = { count: 0 };
  const agent = await makeAgent([countingTool("Grep", runs)], [
    () => [
      call("a", "Grep", { pattern: "x" }),
      call("b", "Grep", { pattern: "x" }),
      call("c", "Grep", { pattern: "x" }),
      call("d", "Grep", { pattern: "y" }),
      { type: "done", stopReason: "tool_use" },
    ],
  ]);

  const toolResults = results(agent);
  assert.deepEqual(toolResults.map((block) => block.tool_use_id), ["a", "b", "c", "d"]);
  assert.equal(toolResults[2].is_error, true);
  // A different argument is a different call and must still run.
  assert.equal(toolResults[3].is_error, false);
  assert.equal(runs.count, 3);
});

test("key order does not defeat the guard", async () => {
  const runs = { count: 0 };
  const agent = await makeAgent([countingTool("Edit", runs)], [
    () => [
      call("1", "Edit", { file_path: "/tmp/a", old_string: "x" }),
      call("2", "Edit", { old_string: "x", file_path: "/tmp/a" }),
      call("3", "Edit", { file_path: "/tmp/a", old_string: "x" }),
      { type: "done", stopReason: "tool_use" },
    ],
  ]);

  assert.equal(runs.count, 2);
  assert.equal(results(agent)[2].is_error, true);
});

test("a successful repeat with different args resets nothing but is allowed", async () => {
  const runs = { count: 0 };
  const agent = await makeAgent([countingTool("Read", runs)], [
    () => [
      call("1", "Read", { file_path: "/tmp/a" }),
      call("2", "Read", { file_path: "/tmp/b" }),
      call("3", "Read", { file_path: "/tmp/a" }),
      { type: "done", stopReason: "tool_use" },
    ],
  ]);

  // a, b, a is only the second call of /tmp/a, so all three run.
  assert.equal(runs.count, 3);
  assert.ok(results(agent).every((block) => !block.is_error));
});

test("TodoWrite and TeamStatus are exempt from the guard", async () => {
  const todos = { count: 0 };
  const status = { count: 0 };
  const agent = await makeAgent(
    [countingTool("TodoWrite", todos), countingTool("TeamStatus", status)],
    [
      () => [
        call("1", "TodoWrite", { todos: [] }),
        call("2", "TodoWrite", { todos: [] }),
        call("3", "TodoWrite", { todos: [] }),
        call("4", "TeamStatus", {}),
        call("5", "TeamStatus", {}),
        call("6", "TeamStatus", {}),
        { type: "done", stopReason: "tool_use" },
      ],
    ],
    { teams: true },
  );

  assert.equal(todos.count, 3, "TodoWrite must never be blocked");
  assert.equal(status.count, 3, "TeamStatus must never be blocked");
  assert.ok(results(agent).every((block) => !block.is_error));
});

test("the guard does not fire across separate runs that differ", async () => {
  const runs = { count: 0 };
  const agent = await makeAgent([countingTool("Read", runs)], [
    () => [call("1", "Read", { file_path: "/tmp/a" }), { type: "done", stopReason: "tool_use" }],
  ]);

  await agent.run("again");

  assert.equal(runs.count, 1);
  assert.equal(results(agent).length, 1);
});

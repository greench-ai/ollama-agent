import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Agent } from "../src/core/agent.ts";
import { PermissionEngine } from "../src/core/permissions.ts";
import { Session } from "../src/core/session.ts";
import type { ChatRequest, Provider, ProviderEvent, Tool } from "../src/core/types.ts";

interface Trace {
  /** (tool name, "start" | "end", completion order) */
  events: string[];
  /** Read-only tools in flight at once, across all tool instances. */
  maxConcurrent: number;
  /** Live in-flight count, shared by every tool instance. */
  active: number;
}

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

function slowTool(name: string, trace: Trace, delayMs = 40, mutating = false): Tool {
  return {
    name,
    description: `${name} test double`,
    mutating,
    inputSchema: { type: "object", properties: {} },
    async run(input) {
      trace.active += 1;
      trace.events.push(`${name}:start`);
      trace.maxConcurrent = Math.max(trace.maxConcurrent, trace.active);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      trace.active -= 1;
      const key = (input.key as string | undefined) ?? name;
      trace.events.push(`${name}:end`);
      return { content: `ran:${name}:${key}` };
    },
  };
}

function newTrace(): Trace {
  return { events: [], maxConcurrent: 0, active: 0 };
}

async function runAgent(tools: Tool[], steps: Array<() => ProviderEvent[]>) {
  const home = process.env.OLLAMA_AGENT_HOME;
  process.env.OLLAMA_AGENT_HOME = home ?? (await mkdtemp(path.join(tmpdir(), "agent-par-home-")));
  const cwd = await mkdtemp(path.join(tmpdir(), "agent-par-cwd-"));
  const session = await Session.create({ cwd, model: "scripted" });
  const provider = new ScriptedProvider(steps);
  const agent = new Agent({
    provider,
    model: "scripted",
    tools,
    permissions: new PermissionEngine("bypassPermissions"),
    session,
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

function toolResults(agent: Agent) {
  return agent.messages
    .flatMap((message) => message.content)
    .filter((block) => block.type === "tool_result");
}

test("consecutive read-only tool calls run concurrently", async () => {
  const trace = newTrace();
  const tools = [slowTool("Read", trace), slowTool("Grep", trace)];
  const agent = await runAgent(tools, [
    () => [
      call("a", "Read", { key: "a" }),
      call("b", "Grep", { key: "b" }),
      call("c", "Read", { key: "c" }),
      { type: "done", stopReason: "tool_use" },
    ],
  ]);

  assert.equal(trace.maxConcurrent, 3, "three read-only calls should overlap");
  assert.deepEqual(toolResults(agent).map((block) => block.content), [
    "ran:Read:a",
    "ran:Grep:b",
    "ran:Read:c",
  ]);
});

test("results stay in request order even when completion order differs", async () => {
  // The first call is slowest and finishes last; its result must still be first.
  const slow: Tool = {
    name: "Read",
    description: "slow read",
    mutating: false,
    inputSchema: { type: "object", properties: {} },
    async run(input) {
      const delay = input.key === "first" ? 60 : 5;
      await new Promise((resolve) => setTimeout(resolve, delay));
      return { content: `ran:${input.key as string}` };
    },
  };
  const agent = await runAgent([slow], [
    () => [
      call("1", "Read", { key: "first" }),
      call("2", "Read", { key: "second" }),
      call("3", "Read", { key: "third" }),
      { type: "done", stopReason: "tool_use" },
    ],
  ]);

  assert.deepEqual(toolResults(agent).map((block) => block.content), [
    "ran:first",
    "ran:second",
    "ran:third",
  ]);
  assert.deepEqual(toolResults(agent).map((block) => block.tool_use_id), ["1", "2", "3"]);
});

test("mutating tools are a barrier between read-only batches", async () => {
  const trace = newTrace();
  const tools = [
    slowTool("Read", trace),
    slowTool("Edit", trace, 20, true),
    slowTool("Write", trace, 20, true),
  ];
  const agent = await runAgent(tools, [
    () => [
      call("r1", "Read", { key: "r1" }),
      call("r2", "Read", { key: "r2" }),
      call("e1", "Edit", { key: "e1" }),
      call("w1", "Write", { key: "w1" }),
      { type: "done", stopReason: "tool_use" },
    ],
  ]);

  assert.equal(trace.maxConcurrent, 2, "only the two reads should overlap");
  // Reads complete before Edit starts; Edit completes before Write starts.
  assert.deepEqual(trace.events, [
    "Read:start",
    "Read:start",
    "Read:end",
    "Read:end",
    "Edit:start",
    "Edit:end",
    "Write:start",
    "Write:end",
  ]);
  assert.deepEqual(toolResults(agent).map((block) => block.tool_use_id), [
    "r1",
    "r2",
    "e1",
    "w1",
  ]);
});

test("stateful non-mutating tools never run concurrently", async () => {
  const trace = newTrace();
  // TodoWrite reports mutating: false but rewrites session state, so it must
  // stay sequential even though it looks read-only.
  const tools = [slowTool("TodoWrite", trace), slowTool("Write", trace, 20, true)];
  await runAgent(tools, [
    () => [
      call("t1", "TodoWrite", { key: "t1" }),
      call("t2", "TodoWrite", { key: "t2" }),
      call("w1", "Write", { key: "w1" }),
      { type: "done", stopReason: "tool_use" },
    ],
  ]);

  assert.equal(trace.maxConcurrent, 1, "stateful tools must stay sequential");
  assert.deepEqual(trace.events, [
    "TodoWrite:start",
    "TodoWrite:end",
    "TodoWrite:start",
    "TodoWrite:end",
    "Write:start",
    "Write:end",
  ]);
});

test("a mutating call between reads splits them into separate batches", async () => {
  const trace = newTrace();
  const tools = [
    slowTool("Read", trace),
    slowTool("Edit", trace, 20, true),
  ];
  await runAgent(tools, [
    () => [
      call("r1", "Read", { key: "r1" }),
      call("e1", "Edit", { key: "e1" }),
      call("r2", "Read", { key: "r2" }),
      { type: "done", stopReason: "tool_use" },
    ],
  ]);

  assert.deepEqual(trace.events, [
    "Read:start",
    "Read:end",
    "Edit:start",
    "Edit:end",
    "Read:start",
    "Read:end",
  ]);
});

test("tool events carry an id so hosts can pair interleaved calls", async () => {
  const trace = newTrace();
  const tools = [slowTool("Read", trace, 10)];
  const started: string[] = [];
  const ended: string[] = [];
  const home = process.env.OLLAMA_AGENT_HOME;
  process.env.OLLAMA_AGENT_HOME =
    home ?? (await mkdtemp(path.join(tmpdir(), "agent-par-home-")));
  const cwd = await mkdtemp(path.join(tmpdir(), "agent-par-cwd-"));
  const agent = new Agent({
    provider: new ScriptedProvider([
      () => [
        call("x1", "Read", { key: "x1" }),
        call("x2", "Read", { key: "x2" }),
        { type: "done", stopReason: "tool_use" },
      ],
    ]),
    model: "scripted",
    tools,
    permissions: new PermissionEngine("bypassPermissions"),
    session: await Session.create({ cwd, model: "scripted" }),
    cwd,
    system: "test",
    teamsEnabled: false,
    checkpoints: false,
    telemetry: false,
    onEvent: (event) => {
      if (event.type === "tool_start") started.push(event.id ?? "");
      if (event.type === "tool_end") ended.push(event.id ?? "");
    },
  });

  await agent.run("go");
  assert.deepEqual(started, ["x1", "x2"]);
  assert.deepEqual(ended.sort(), ["x1", "x2"]);
});

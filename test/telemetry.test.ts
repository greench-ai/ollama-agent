import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Agent } from "../src/core/agent.ts";
import { PermissionEngine } from "../src/core/permissions.ts";
import { Session } from "../src/core/session.ts";
import {
  TelemetryStore,
  newTelemetryRun,
} from "../src/core/telemetry.ts";
import type {
  ChatRequest,
  Provider,
  ProviderEvent,
} from "../src/core/types.ts";
import { allTools } from "../src/tools/index.ts";

test("telemetry store records runs and summarizes tools and tokens", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "agent-telemetry-home-"));
  const store = new TelemetryStore("session-1", home);
  const base = {
    sessionId: "session-1",
    agentName: "lead",
    model: "test-model",
    cwd: "/tmp",
    startedAt: Date.now() - 100,
    endedAt: Date.now(),
    stopReason: "end_turn",
    compactions: 0,
    toolErrors: 0,
  };
  await store.record(
    newTelemetryRun({
      ...base,
      turns: 2,
      tools: { Read: 2, Write: 1 },
      inputTokens: 100,
      outputTokens: 20,
    }),
  );
  await store.record(
    newTelemetryRun({
      ...base,
      turns: 1,
      tools: { Read: 1 },
      inputTokens: 50,
      outputTokens: 10,
      toolErrors: 1,
    }),
  );
  const runs = await store.list();
  assert.equal(runs.length, 2);
  const summary = await store.summary();
  assert.equal(summary.runs, 2);
  assert.equal(summary.turns, 3);
  assert.equal(summary.inputTokens, 150);
  assert.equal(summary.outputTokens, 30);
  assert.equal(summary.toolCalls, 4);
  assert.equal(summary.toolErrors, 1);
  assert.equal(summary.tools.Read, 3);
});

class ReadProvider implements Provider {
  readonly name = "scripted";
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async *chat(request: ChatRequest): AsyncGenerator<ProviderEvent> {
    const hasResult = request.messages.some((message) =>
      message.content.some((block) => block.type === "tool_result"),
    );
    if (!hasResult) {
      yield {
        type: "tool_call",
        call: {
          id: "call_read_1",
          name: "Read",
          input: { file_path: this.filePath },
        },
      };
      yield {
        type: "done",
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
      return;
    }
    yield { type: "text", text: "done" };
    yield {
      type: "done",
      stopReason: "end_turn",
      usage: { inputTokens: 3, outputTokens: 2 },
    };
  }

  async listModels() {
    return [];
  }
}

test("Agent writes one telemetry run per turn loop", async () => {
  process.env.OLLAMA_AGENT_HOME = await mkdtemp(
    path.join(tmpdir(), "agent-telemetry-agent-b-"),
  );
  const cwd = await mkdtemp(path.join(tmpdir(), "agent-telemetry-agent-"));
  const file = path.join(cwd, "note.txt");
  await writeFile(file, "hello\n", "utf8");
  const session = await Session.create({ cwd, model: "test-model" });
  const agent = new Agent({
    provider: new ReadProvider(file),
    model: "test-model",
    tools: allTools,
    permissions: new PermissionEngine("bypassPermissions"),
    session,
    cwd,
    system: "test",
    teamsEnabled: false,
  });

  await agent.run("read the file");
  const runs = await agent.telemetry!.list();
  assert.equal(runs.length, 1);
  const run = runs[0]!;
  assert.equal(run.turns, 2);
  assert.equal(run.tools.Read, 1);
  assert.equal(run.inputTokens, 13);
  assert.equal(run.outputTokens, 7);
  assert.equal(run.toolErrors, 0);
  assert.equal(run.stopReason, "end_turn");
  assert.ok(run.durationMs >= 0);
});

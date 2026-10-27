import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Agent } from "../src/core/agent.ts";
import { contextWindowFromShow } from "../src/core/ollama.ts";
import { PermissionEngine } from "../src/core/permissions.ts";
import { Session } from "../src/core/session.ts";
import type {
  ChatRequest,
  Provider,
  ProviderEvent,
} from "../src/core/types.ts";

test("extracts context length from Ollama model_info", () => {
  assert.equal(
    contextWindowFromShow({
      model_info: {
        "deepseek_v41.context_length": 1_048_576,
        "deepseek_v41.embedding_length": 0,
      },
    }),
    1_048_576,
  );
  assert.equal(
    contextWindowFromShow({ model_info: { "qwen3.context_length": 40_960 } }),
    40_960,
  );
  assert.equal(contextWindowFromShow({ context_length: 131_072 }), 131_072);
  assert.equal(contextWindowFromShow({ model_info: { "x.context_length": 0 } }), undefined);
});

class ContextProvider implements Provider {
  readonly name = "fake";
  calls: ChatRequest[] = [];

  async *chat(request: ChatRequest): AsyncGenerator<ProviderEvent> {
    this.calls.push({ ...request, messages: structuredClone(request.messages) });
    yield { type: "text", text: "ok" };
    yield { type: "done", stopReason: "end_turn" };
  }

  async listModels() {
    return [];
  }

  async contextWindow(model: string): Promise<number | undefined> {
    return model === "deepseek-v4.1-flash:cloud" ? 1_048_576 : 131_072;
  }
}

test("Agent sends the detected context as num_ctx and compacts against it", async () => {
  process.env.OLLAMA_AGENT_HOME = await mkdtemp(
    path.join(tmpdir(), "agent-context-home-"),
  );
  const cwd = await mkdtemp(path.join(tmpdir(), "agent-context-cwd-"));
  const session = await Session.create({
    cwd,
    model: "deepseek-v4.1-flash:cloud",
  });
  const provider = new ContextProvider();
  const agent = new Agent({
    provider,
    model: "deepseek-v4.1-flash:cloud",
    tools: [],
    permissions: new PermissionEngine("bypassPermissions"),
    session,
    cwd,
    system: "test",
    teamsEnabled: false,
    checkpoints: false,
    telemetry: false,
  });

  await agent.run("hello");
  assert.equal(provider.calls[0]?.numCtx, 1_048_576);
  const usage = agent.contextUsage();
  assert.equal(usage.budget, 1_048_576);

  agent.model = "qwen3:8b";
  await agent.run("again");
  assert.equal(provider.calls[1]?.numCtx, 131_072);
  assert.equal(agent.contextUsage().budget, 131_072);
});

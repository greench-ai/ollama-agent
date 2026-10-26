import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Agent } from "../src/core/agent.ts";
import { CheckpointStore } from "../src/core/checkpoints.ts";
import { PermissionEngine } from "../src/core/permissions.ts";
import { Session } from "../src/core/session.ts";
import type {
  ChatRequest,
  Provider,
  ProviderEvent,
} from "../src/core/types.ts";
import { allTools } from "../src/tools/index.ts";

async function harness() {
  const home = await mkdtemp(path.join(tmpdir(), "agent-checkpoints-"));
  const cwd = await mkdtemp(path.join(tmpdir(), "agent-checkpoint-cwd-"));
  return { home, cwd, store: new CheckpointStore("session-1", home) };
}

test("checkpoints back up files before edits and restore them", async () => {
  const h = await harness();
  const file = path.join(h.cwd, "note.txt");
  await writeFile(file, "first\n", "utf8");

  const first = await h.store.capture("Write", { file_path: file }, h.cwd);
  assert.ok(first);
  await writeFile(file, "second\n", "utf8");

  const second = await h.store.capture("Edit", { file_path: file }, h.cwd);
  assert.ok(second);
  await writeFile(file, "third\n", "utf8");

  await h.store.restore(first!.id);
  assert.equal(await readFile(file, "utf8"), "first\n");
  await h.store.restore(second!.id);
  assert.equal(await readFile(file, "utf8"), "second\n");

  const list = await h.store.list();
  assert.equal(list.length, 2);
  assert.equal(list[0]?.id, second!.id);
  assert.deepEqual(list[0]?.files, [file]);
});

test("restoring a checkpoint removes files that did not exist yet", async () => {
  const h = await harness();
  const file = path.join(h.cwd, "created.txt");
  const checkpoint = await h.store.capture("Write", { file_path: file }, h.cwd);
  assert.ok(checkpoint);
  assert.equal(checkpoint?.files[0]?.existed, false);
  await writeFile(file, "new\n", "utf8");

  const report = await h.store.restore(checkpoint!.id);
  assert.match(report, /removed/);
  await assert.rejects(() => readFile(file, "utf8"), /ENOENT/);
});

test("checkpoints ignore non-file tools and unknown ids", async () => {
  const h = await harness();
  assert.equal(
    await h.store.capture("Bash", { command: "echo hi" }, h.cwd),
    undefined,
  );
  const checkpoint = await h.store.capture(
    "Write",
    { file_path: path.join(h.cwd, "x.txt") },
    h.cwd,
  );
  assert.ok(checkpoint);
  await assert.rejects(() => h.store.restore("missing"), /Unknown checkpoint/);
});

class WriteProvider implements Provider {
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
          id: "call_write_1",
          name: "Write",
          input: { file_path: this.filePath, content: "after\n" },
        },
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

test("Agent captures a checkpoint before a Write tool runs", async () => {
  process.env.OLLAMA_AGENT_HOME = await mkdtemp(
    path.join(tmpdir(), "agent-checkpoint-home-"),
  );
  const cwd = await mkdtemp(path.join(tmpdir(), "agent-checkpoint-agent-"));
  const file = path.join(cwd, "note.txt");
  await writeFile(file, "before\n", "utf8");
  const session = await Session.create({ cwd, model: "test-model" });
  const agent = new Agent({
    provider: new WriteProvider(file),
    model: "test-model",
    tools: allTools,
    permissions: new PermissionEngine("bypassPermissions"),
    session,
    cwd,
    system: "test",
    teamsEnabled: false,
  });

  await agent.run("change the file");
  assert.equal(await readFile(file, "utf8"), "after\n");
  const checkpoints = await agent.checkpoints!.list();
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0]?.tool, "Write");
  await agent.checkpoints!.restore(checkpoints[0]!.id);
  assert.equal(await readFile(file, "utf8"), "before\n");
});

import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Agent } from "../src/core/agent.ts";
import {
  HooksEngine,
  parseHooksConfig,
  type HookCommand,
} from "../src/core/hooks.ts";
import { PermissionEngine } from "../src/core/permissions.ts";
import { Session } from "../src/core/session.ts";
import type {
  ChatRequest,
  Provider,
  ProviderEvent,
} from "../src/core/types.ts";
import { allTools } from "../src/tools/index.ts";

const exitTwo: HookCommand = {
  event: "PreToolUse",
  matcher: "Write",
  command: 'node -e "process.exit(2)"',
  timeoutMs: 10_000,
};

test("parses flat and nested hook configs", () => {
  const parsed = parseHooksConfig({
    hooks: {
      PreToolUse: [
        { matcher: "Bash", command: "echo flat" },
        { matcher: "Write", hooks: [{ type: "command", command: "echo nested" }] },
      ],
      Stop: [{ command: "echo stop" }],
    },
  });
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0]?.event, "PreToolUse");
  assert.equal(parsed[1]?.command, "echo nested");
  assert.equal(parsed[2]?.event, "Stop");
});

test("PreToolUse hooks block on exit 2 and respect matchers", async () => {
  const engine = new HooksEngine([exitTwo]);
  const blocked = await engine.run("PreToolUse", {
    tool: "Write",
    cwd: process.cwd(),
  });
  assert.equal(blocked.blocked, true);
  assert.match(blocked.reason ?? "", /blocked/);

  const allowed = await engine.run("PreToolUse", {
    tool: "Read",
    cwd: process.cwd(),
  });
  assert.equal(allowed.blocked, false);
});

test("hooks receive JSON on stdin and can return output", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "agent-hook-cwd-"));
  const script = path.join(cwd, "hook.js");
  await writeFile(
    script,
    `let data = ""; process.stdin.on("data", (c) => data += c); process.stdin.on("end", () => {
      const event = JSON.parse(data);
      console.log("hook:" + event.event + ":" + event.tool);
    });`,
    "utf8",
  );
  const engine = new HooksEngine([
    {
      event: "PreToolUse",
      matcher: "Read",
      command: `node ${JSON.stringify(script)}`,
      timeoutMs: 10_000,
    },
  ]);
  const result = await engine.run("PreToolUse", { tool: "Read", cwd });
  assert.equal(result.blocked, false);
  assert.match(result.output ?? "", /hook:PreToolUse:Read/);
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

test("a blocking PreToolUse hook prevents the file mutation", async () => {
  process.env.OLLAMA_AGENT_HOME = await mkdtemp(
    path.join(tmpdir(), "agent-hook-home-"),
  );
  const cwd = await mkdtemp(path.join(tmpdir(), "agent-hook-agent-"));
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
    hooks: new HooksEngine([exitTwo]),
  });

  await agent.run("change the file");
  assert.equal(await readFile(file, "utf8"), "before\n");
  const result = agent.messages
    .flatMap((message) => message.content)
    .find((block) => block.type === "tool_result" && block.name === "Write");
  assert.ok(result && result.type === "tool_result");
  assert.match(result.content, /Blocked by PreToolUse hook/);
  assert.equal(result.is_error, true);
});

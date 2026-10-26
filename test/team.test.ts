import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { builtinAgentDefinitions } from "../src/core/agent-definitions.ts";
import { PermissionEngine } from "../src/core/permissions.ts";
import {
  TeamManager,
  type TeamAgent,
  type TeamAgentConfig,
  type TeamEvent,
} from "../src/core/team.ts";
import type { Message, ToolContext } from "../src/core/types.ts";
import { bashTool } from "../src/tools/bash.ts";
import { readTool } from "../src/tools/read.ts";
import { writeTool } from "../src/tools/write.ts";
import { memberTeamTools, teamTools } from "../src/tools/team.ts";

const PARENT_SESSION = "20261026-000000-abcdef";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FakeAgent implements TeamAgent {
  messages: Message[];
  signal?: AbortSignal;
  private config: TeamAgentConfig;

  constructor(config: TeamAgentConfig) {
    this.config = config;
    this.messages = config.messages ? [...config.messages] : [];
  }

  async run(prompt: string): Promise<void> {
    this.config.onEvent({ type: "text", text: `working:${prompt.slice(0, 30)}` });
    await delay(this.config.name.startsWith("slow") ? 150 : 10);
    if (this.signal?.aborted) throw new Error("Aborted");
    this.messages.push({ role: "user", content: [{ type: "text", text: prompt }] });
    this.messages.push({
      role: "assistant",
      content: [{ type: "text", text: `report:${this.config.name}:${prompt}` }],
    });
    this.config.onEvent({ type: "done" });
  }

  contextUsage(): { used: number; budget: number } {
    return { used: 10, budget: 1000 };
  }
}

async function harness() {
  const home = await mkdtemp(path.join(tmpdir(), "agent-team-home-"));
  process.env.OLLAMA_AGENT_HOME = home;
  const cwd = await mkdtemp(path.join(tmpdir(), "agent-team-cwd-"));
  const configs: TeamAgentConfig[] = [];
  const events: TeamEvent[] = [];

  const make = () =>
    new TeamManager({
      leadModel: "lead-model",
      baseTools: [readTool, writeTool, bashTool],
      memberTools: memberTeamTools,
      permissions: new PermissionEngine("bypassPermissions"),
      cwd,
      parentSessionId: PARENT_SESSION,
      agentDefinitions: builtinAgentDefinitions(),
      createAgent: (config) => {
        configs.push(config);
        return new FakeAgent(config);
      },
      onEvent: (event) => events.push(event),
    });

  return { home, cwd, configs, events, make };
}

test("spawns a teammate, applies its definition, and returns its report", async () => {
  const h = await harness();
  const manager = h.make();

  const spawned = await manager.spawn("lead", {
    name: "impl",
    role: "implementer",
    prompt: "build the feature",
  });
  assert.match(spawned, /Spawned impl/);

  await manager.spawn("lead", { name: "idle", role: "implementer" });
  const status = await manager.awaitMembers(["impl"], 5000);
  assert.match(status, /report:impl:build the feature/);

  const snapshot = await manager.snapshot();
  const member = snapshot?.members.find((entry) => entry.name === "impl");
  assert.equal(member?.status, "idle");
  assert.equal(member?.turns, 1);
  const run = snapshot?.runs.find((entry) => entry.agent === "impl");
  assert.equal(run?.status, "done");
  assert.match(run?.report ?? "", /report:impl/);

  const config = h.configs.find((entry) => entry.name === "impl");
  assert.ok(config);
  assert.equal(config?.model, "lead-model");
  assert.equal(config?.permissions.mode, "bypassPermissions");
  assert.ok(config?.tools.some((tool) => tool.name === "Write"));
  assert.ok(config?.tools.some((tool) => tool.name === "TeamTask"));
  assert.ok(!config?.tools.some((tool) => tool.name === "TeamSpawn"));
  assert.match(config?.system ?? "", /Team rules/);

  assert.ok(h.events.some((event) => event.type === "team_state"));
  await manager.close();
});

test("read-only roles get plan permissions and no mutating tools", async () => {
  const h = await harness();
  const manager = h.make();
  await manager.spawn("lead", {
    name: "scan",
    role: "explore",
    prompt: "find the entry points",
    wait: true,
  });

  const config = h.configs.find((entry) => entry.name === "scan");
  assert.ok(config);
  assert.equal(config?.permissions.mode, "plan");
  assert.ok(
    !config?.tools.some((tool) =>
      ["Write", "Edit", "MultiEdit", "Bash"].includes(tool.name),
    ),
  );
  assert.ok(config?.tools.some((tool) => tool.name === "Read"));

  const spawnTool = teamTools.find((tool) => tool.name === "TeamSpawn");
  assert.ok(spawnTool);
  const context: ToolContext = {
    cwd: h.cwd,
    sessionId: "session",
    signal: nuevoSignal(),
    todos: [],
    log: () => {},
    team: manager,
    teamRole: "member",
    agentName: "scan",
  };
  await assert.rejects(
    () => spawnTool!.run({ name: "other", role: "explore" }, context),
    /Only the team lead/,
  );
  await manager.close();
});

function nuevoSignal(): AbortSignal {
  return new AbortController().signal;
}

test("task board enforces dependencies, claims, and file reservations", async () => {
  const h = await harness();
  const manager = h.make();
  await manager.spawn("lead", { name: "impl", role: "implementer" });
  await manager.spawn("lead", { name: "other", role: "implementer" });

  const createdA = await manager.taskAction("lead", "create", {
    title: "Task A",
    files: ["src/a.ts"],
  });
  const taskA = /task-[0-9a-f]+/.exec(createdA)?.[0];
  assert.ok(taskA);

  const createdB = await manager.taskAction("lead", "create", {
    title: "Task B",
    dependsOn: [taskA!],
  });
  const taskB = /task-[0-9a-f]+/.exec(createdB)?.[0];
  assert.ok(taskB);

  await assert.rejects(
    () => manager.taskAction("impl", "claim", { taskId: taskB! }),
    /blocked by/,
  );
  assert.match(
    await manager.taskAction("impl", "claim", { taskId: taskA! }),
    /Claimed/,
  );

  const createdC = await manager.taskAction("lead", "create", {
    title: "Task C",
    files: ["src/a.ts"],
  });
  const taskC = /task-[0-9a-f]+/.exec(createdC)?.[0];
  assert.ok(taskC);
  await assert.rejects(
    () => manager.taskAction("other", "claim", { taskId: taskC! }),
    /shares files/,
  );

  await manager.taskAction("impl", "complete", { taskId: taskA!, result: "done" });
  assert.match(
    await manager.taskAction("other", "claim", { taskId: taskB! }),
    /Claimed/,
  );

  const snapshot = await manager.snapshot();
  assert.equal(
    snapshot?.tasks.find((task) => task.id === taskA)?.status,
    "completed",
  );
  assert.equal(
    snapshot?.tasks.find((task) => task.id === taskB)?.assignee,
    "other",
  );
  await manager.close();
});

test("mailbox delivers messages and team state persists across managers", async () => {
  const h = await harness();
  const manager = h.make();
  await manager.spawn("lead", { name: "helper", role: "general-purpose" });

  const sent = await manager.sendMessage("lead", "helper", "please check the logs");
  assert.match(sent, /started a turn/);
  await manager.awaitMembers(["helper"], 5000);

  let snapshot = await manager.snapshot();
  assert.equal(
    snapshot?.messages.find((message) => message.to === "helper")?.read,
    true,
  );
  assert.ok(
    h.events.some(
      (event) => event.type === "stream" && event.agent === "helper" && event.kind === "text",
    ),
  );

  await manager.taskAction("lead", "create", { title: "Persisted task" });
  await manager.close();

  const reloaded = h.make();
  snapshot = await reloaded.snapshot();
  assert.ok(
    snapshot?.members.some(
      (member) => member.name === "helper" && member.status === "offline",
    ),
  );
  assert.ok(snapshot?.tasks.some((task) => task.title === "Persisted task"));
  assert.ok((snapshot?.messages.length ?? 0) >= 1);
  await reloaded.close();
});

test("enforces the concurrent run limit", async () => {
  const h = await harness();
  const manager = h.make();

  await Promise.all([
    manager.spawn("lead", { name: "slow1", role: "implementer", prompt: "work 1" }),
    manager.spawn("lead", { name: "slow2", role: "implementer", prompt: "work 2" }),
    manager.spawn("lead", { name: "slow3", role: "implementer", prompt: "work 3" }),
  ]);
  await assert.rejects(
    () => manager.spawn("lead", { name: "slow4", role: "implementer", prompt: "work 4" }),
    /Concurrency limit/,
  );

  const status = await manager.awaitMembers(undefined, 5000);
  assert.match(status, /Members:/);
  const snapshot = await manager.snapshot();
  assert.equal(
    snapshot?.members.filter((member) => member.status === "running").length,
    0,
  );
  assert.ok(!snapshot?.members.some((member) => member.name === "slow4"));
  await manager.close();
});

test("shutdown marks a teammate offline and blocks further runs", async () => {
  const h = await harness();
  const manager = h.make();
  await manager.spawn("lead", { name: "helper", role: "general-purpose" });

  assert.match(await manager.shutdown("lead", "helper"), /Shut down helper/);
  await assert.rejects(
    () => manager.run("lead", "helper", "again"),
    /offline/,
  );
  const snapshot = await manager.snapshot();
  assert.equal(
    snapshot?.members.find((member) => member.name === "helper")?.status,
    "offline",
  );
  await manager.close();
});

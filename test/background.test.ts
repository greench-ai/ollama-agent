import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BackgroundManager,
  cronMatches,
  nextCron,
} from "../src/core/background.ts";
import { Session } from "../src/core/session.ts";
import type { Message } from "../src/core/types.ts";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FakeAgent {
  messages: Message[] = [];
  signal?: AbortSignal;
  closed = false;
  private session?: Session;

  constructor(session?: Session) {
    this.session = session;
  }

  async run(prompt: string): Promise<void> {
    const user: Message = {
      role: "user",
      content: [{ type: "text", text: prompt }],
    };
    this.messages.push(user);
    await this.session?.appendMessage(user);
    await delay(prompt.includes("slow") ? 120 : 10);
    if (this.signal?.aborted) throw new Error("Aborted");
    const assistant: Message = {
      role: "assistant",
      content: [{ type: "text", text: `report:${prompt}` }],
    };
    this.messages.push(assistant);
    await this.session?.appendMessage(assistant);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

async function harness(maxConcurrent = 2) {
  const home = await mkdtemp(path.join(tmpdir(), "agent-bg-home-"));
  process.env.OLLAMA_AGENT_HOME = home;
  const cwd = await mkdtemp(path.join(tmpdir(), "agent-bg-cwd-"));
  const agents: FakeAgent[] = [];
  const make = async () => {
    const manager = await BackgroundManager.load({
      home,
      autoStart: false,
      maxConcurrent,
      createAgent: async () => {
        const session = await Session.create({ cwd, model: "test-model" });
        const agent = new FakeAgent(session);
        agents.push(agent);
        return { agent, session };
      },
    });
    return manager;
  };
  return { home, cwd, agents, make };
}

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(20);
  }
  throw new Error("Timed out waiting for background state.");
}

test("dispatches jobs and returns reports and transcripts", async () => {
  const h = await harness(1);
  const manager = await h.make();
  const first = await manager.dispatch({
    prompt: "slow job",
    cwd: h.cwd,
    model: "test-model",
    mode: "bypassPermissions",
  });
  const second = await manager.dispatch({
    prompt: "quick job",
    cwd: h.cwd,
    model: "test-model",
    mode: "bypassPermissions",
  });

  let state = await manager.stateSnapshot();
  assert.equal(state.jobs.find((job) => job.id === first.id)?.status, "running");
  assert.equal(state.jobs.find((job) => job.id === second.id)?.status, "queued");

  await waitFor(async () => {
    state = await manager.stateSnapshot();
    return state.jobs.every((job) => job.status === "done");
  });
  const done = state.jobs.find((job) => job.id === first.id);
  assert.match(done?.report ?? "", /report:slow job/);
  const transcript = await manager.transcript(first.id);
  assert.ok(transcript.some((message) => message.role === "assistant"));
  assert.equal(h.agents.filter((agent) => agent.closed).length, 2);
  await manager.close();
});

test("cancels a running background job", async () => {
  const h = await harness(1);
  const manager = await h.make();
  const job = await manager.dispatch({
    prompt: "slow cancel",
    cwd: h.cwd,
    model: "test-model",
    mode: "bypassPermissions",
  });
  await waitFor(async () => {
    const state = await manager.stateSnapshot();
    return state.jobs.find((entry) => entry.id === job.id)?.status === "running";
  });
  await manager.cancel(job.id);
  const state = await manager.stateSnapshot();
  assert.equal(state.jobs.find((entry) => entry.id === job.id)?.status, "cancelled");
  await manager.close();
});

test("cron parsing matches fields and finds the next run", () => {
  const mondayNine = new Date(2026, 9, 26, 9, 0, 30); // Monday
  assert.equal(cronMatches("0 9 * * 1", mondayNine), true);
  assert.equal(cronMatches("30 9 * * 1", mondayNine), false);
  const next = nextCron("0 9 * * 1-5", mondayNine);
  assert.ok(next);
  assert.equal(next?.getHours(), 9);
  assert.equal(next?.getMinutes(), 0);

  const everyFive = nextCron("*/5 * * * *", new Date(2026, 9, 26, 9, 1, 0));
  assert.equal(everyFive?.getMinutes(), 5);
  assert.throws(() => nextCron("bad", new Date()), /five fields/);
});

test("schedules persist and fire through tick", async () => {
  const h = await harness(1);
  const manager = await h.make();
  const schedule = await manager.addSchedule({
    name: "nightly",
    prompt: "scheduled work",
    cron: "* * * * *",
    cwd: h.cwd,
    model: "test-model",
    mode: "bypassPermissions",
  });
  assert.ok(schedule.nextRunAt);
  await manager.tick(Date.parse(schedule.nextRunAt!) + 1);
  await waitFor(async () => {
    const state = await manager.stateSnapshot();
    return state.jobs.some(
      (job) => job.scheduleId === schedule.id && job.status === "done",
    );
  });
  const state = await manager.stateSnapshot();
  const updated = state.schedules.find((entry) => entry.id === schedule.id);
  assert.ok(updated?.lastRunAt);
  assert.notEqual(updated?.nextRunAt, schedule.nextRunAt);
  await manager.close();

  const reloaded = await h.make();
  const persisted = await reloaded.stateSnapshot();
  assert.ok(persisted.schedules.some((entry) => entry.id === schedule.id));
  assert.ok(persisted.jobs.some((job) => job.scheduleId === schedule.id));
  await reloaded.close();
});

test("running jobs become errors and schedules recompute on reload", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "agent-bg-reload-home-"));
  process.env.OLLAMA_AGENT_HOME = home;
  await mkdir(path.join(home, "background"), { recursive: true });
  await writeFile(
    path.join(home, "background", "state.json"),
    JSON.stringify({
      maxConcurrent: 1,
      jobs: [
        {
          id: "job-old",
          title: "old",
          prompt: "old",
          cwd: home,
          model: "test-model",
          mode: "bypassPermissions",
          status: "running",
          createdAt: new Date().toISOString(),
        },
      ],
      schedules: [
        {
          id: "sch-old",
          name: "daily",
          prompt: "daily",
          cwd: home,
          model: "test-model",
          mode: "bypassPermissions",
          cron: "0 9 * * *",
          enabled: true,
          createdAt: new Date().toISOString(),
          nextRunAt: new Date(Date.now() - 60_000).toISOString(),
        },
      ],
    }),
    "utf8",
  );
  const manager = await BackgroundManager.load({
    home,
    autoStart: false,
    createAgent: async () => {
      throw new Error("not used");
    },
  });
  const state = await manager.stateSnapshot();
  const job = state.jobs.find((entry) => entry.id === "job-old");
  assert.equal(job?.status, "error");
  assert.match(job?.error ?? "", /Interrupted/);
  const schedule = state.schedules.find((entry) => entry.id === "sch-old");
  assert.ok(schedule?.nextRunAt);
  assert.ok(Date.parse(schedule!.nextRunAt!) > Date.now());
  await manager.close();
});

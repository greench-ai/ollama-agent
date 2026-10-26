import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CheckpointStore } from "../src/core/checkpoints.ts";
import { purgeAllSessions, purgeSession } from "../src/core/purge.ts";
import { Session, agentHome, sessionsDir } from "../src/core/session.ts";
import { TelemetryStore, newTelemetryRun } from "../src/core/telemetry.ts";

async function exists(file: string): Promise<boolean> {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}

test("purge removes a session and all of its related data but keeps files by default", async () => {
  process.env.OLLAMA_AGENT_HOME = await mkdtemp(
    path.join(tmpdir(), "agent-purge-home-"),
  );
  const cwd = await mkdtemp(path.join(tmpdir(), "agent-purge-cwd-"));
  const file = path.join(cwd, "note.txt");
  await writeFile(file, "before\n", "utf8");

  const session = await Session.create({ cwd, model: "test" });
  await session.setTitle("To purge");
  await session.appendMessage({
    role: "user",
    content: [{ type: "text", text: "secret transcript" }],
  });
  const subagent = await Session.create({
    cwd,
    model: "test",
    id: `${session.id}-scout`,
  });
  await subagent.setTitle("Subagent");
  const store = new CheckpointStore(session.id);
  await store.capture("Write", { file_path: file }, cwd);
  await writeFile(file, "after\n", "utf8");

  const telemetry = new TelemetryStore(session.id);
  await telemetry.record(
    newTelemetryRun({
      sessionId: session.id,
      agentName: "lead",
      model: "test",
      cwd,
      startedAt: Date.now() - 10,
      endedAt: Date.now(),
      turns: 1,
      tools: { Read: 1 },
      inputTokens: 1,
      outputTokens: 1,
      compactions: 0,
      toolErrors: 0,
      stopReason: "end_turn",
    }),
  );
  await mkdir(path.join(agentHome(), "teams", session.id), { recursive: true });
  await writeFile(
    path.join(agentHome(), "teams", session.id, "team.json"),
    JSON.stringify({ members: [] }),
    "utf8",
  );
  await mkdir(path.join(agentHome(), "background"), { recursive: true });
  await writeFile(
    path.join(agentHome(), "background", "state.json"),
    JSON.stringify({
      jobs: [
        { id: "job-1", sessionId: session.id, status: "done" },
        { id: "job-2", sessionId: "other", status: "done" },
      ],
      schedules: [{ id: "keep" }],
    }),
    "utf8",
  );

  const result = await purgeSession(session.id, { deleteFiles: false });
  assert.equal(result.sessions, 1);
  assert.equal(await exists(path.join(sessionsDir(), `${session.id}.jsonl`)), false);
  assert.equal(await exists(path.join(sessionsDir(), `${session.id}-scout.jsonl`)), false);
  assert.equal(await exists(path.join(agentHome(), "checkpoints", session.id)), false);
  assert.equal(await exists(telemetry.file), false);
  assert.equal(await exists(path.join(agentHome(), "teams", session.id)), false);
  assert.equal(await readFile(file, "utf8"), "after\n");

  const background = JSON.parse(
    await readFile(path.join(agentHome(), "background", "state.json"), "utf8"),
  );
  assert.equal(background.jobs.length, 1);
  assert.equal(background.jobs[0].sessionId, "other");
  assert.equal(background.schedules[0].id, "keep");
  const titles = JSON.parse(
    await readFile(path.join(sessionsDir(), "index.json"), "utf8"),
  );
  assert.equal(titles[session.id], undefined);
  assert.equal(titles[`${session.id}-scout`], undefined);
});

test("purge with deleteFiles restores files to their pre-session state", async () => {
  process.env.OLLAMA_AGENT_HOME = await mkdtemp(
    path.join(tmpdir(), "agent-purge-restore-"),
  );
  const cwd = await mkdtemp(path.join(tmpdir(), "agent-purge-restore-cwd-"));
  const file = path.join(cwd, "note.txt");
  const created = path.join(cwd, "created.txt");
  await writeFile(file, "before\n", "utf8");

  const session = await Session.create({ cwd, model: "test" });
  const store = new CheckpointStore(session.id);
  await store.capture("Edit", { file_path: file }, cwd);
  await store.capture("Write", { file_path: created }, cwd);
  await writeFile(file, "after\n", "utf8");
  await writeFile(created, "new\n", "utf8");

  await purgeSession(session.id, { deleteFiles: true });
  assert.equal(await readFile(file, "utf8"), "before\n");
  await assert.rejects(() => readFile(created, "utf8"), /ENOENT/);
});

test("purgeAllSessions clears all session data and background jobs", async () => {
  process.env.OLLAMA_AGENT_HOME = await mkdtemp(
    path.join(tmpdir(), "agent-purge-all-"),
  );
  const cwd = await mkdtemp(path.join(tmpdir(), "agent-purge-all-cwd-"));
  await Session.create({ cwd, model: "one" });
  await Session.create({ cwd, model: "two" });
  await mkdir(path.join(agentHome(), "background"), { recursive: true });
  await writeFile(
    path.join(agentHome(), "background", "state.json"),
    JSON.stringify({ jobs: [{ id: "j", status: "done" }], schedules: [] }),
    "utf8",
  );

  const result = await purgeAllSessions({ deleteFiles: false });
  assert.equal(result.sessions, 2);
  assert.deepEqual(await readdir(sessionsDir()).catch(() => []), []);
  const background = JSON.parse(
    await readFile(path.join(agentHome(), "background", "state.json"), "utf8"),
  );
  assert.equal(background.jobs.length, 0);
});

test("rejects invalid purge ids", async () => {
  process.env.OLLAMA_AGENT_HOME = await mkdtemp(
    path.join(tmpdir(), "agent-purge-invalid-"),
  );
  await assert.rejects(() => purgeSession("../../etc"), /Invalid session id/);
});

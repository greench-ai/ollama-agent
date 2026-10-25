import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Session } from "../src/core/session.ts";
import {
  deleteSession,
  listSessions,
  loadSession,
  renameSession,
} from "../src/core/sessions.ts";

test("lists main sessions, ignores subagent transcripts, and supports rename/load/delete", async () => {
  process.env.OLLAMA_AGENT_HOME = await mkdtemp(path.join(tmpdir(), "agent-sessions-"));
  const cwd = await mkdtemp(path.join(tmpdir(), "agent-sessions-cwd-"));

  const first = await Session.create({ cwd, model: "model-a" });
  await first.appendMessage({
    role: "user",
    content: [{ type: "text", text: "hello" }],
  });
  await first.setTitle("First chat");

  const second = await Session.create({ cwd, model: "model-b" });
  await second.appendMessage({
    role: "user",
    content: [{ type: "text", text: "second" }],
  });

  await Session.create({ cwd, model: "model-a", id: `${first.id}-scout` });

  const list = await listSessions();
  assert.equal(list.length, 2, "subagent transcript is hidden");
  assert.ok(!list.some((session) => session.id.endsWith("-scout")));

  const summary = list.find((session) => session.id === first.id);
  assert.equal(summary?.title, "First chat");
  assert.equal(summary?.model, "model-a");
  assert.equal(summary?.cwd, cwd);

  const loaded = await loadSession(first.id);
  assert.equal(loaded.title, "First chat");
  assert.equal(loaded.messages.length, 1);
  assert.equal(
    loaded.messages[0].content[0].type === "text"
      ? loaded.messages[0].content[0].text
      : "",
    "hello",
  );

  const renamed = await renameSession(first.id, "  Renamed   chat  ");
  assert.equal(renamed, "Renamed chat");
  assert.equal(
    (await listSessions()).find((session) => session.id === first.id)?.title,
    "Renamed chat",
  );

  await deleteSession(first.id);
  const remaining = await listSessions();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, second.id);
});

test("rejects invalid session ids", async () => {
  process.env.OLLAMA_AGENT_HOME = await mkdtemp(path.join(tmpdir(), "agent-sessions-"));
  await assert.rejects(() => loadSession("../escape"), /Invalid session id/);
  await assert.rejects(() => deleteSession("nope"), /Invalid session id/);
});

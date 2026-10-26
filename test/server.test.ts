import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const serverEntry = fileURLToPath(new URL("../src/server.ts", import.meta.url));

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function freePort(): Promise<number> {
  const probe = createServer();
  const port = await listen(probe);
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function waitForServer(base: string, deadlineMs = 15_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/state`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("server did not start in time");
}

test("server exposes state, chat streaming, sessions, projects, and file previews", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "agent-server-home-"));
  const workdir = await mkdtemp(path.join(tmpdir(), "agent-server-cwd-"));
  const project = await mkdtemp(path.join(tmpdir(), "agent-server-project-"));
  await writeFile(path.join(project, "AGENTS.md"), "Prefer tabs.\n");
  await writeFile(path.join(project, "note.txt"), "project note\n");

  const ollama = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/api/tags") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ models: [{ name: "mock:latest" }] }));
      return;
    }
    if (request.method === "POST" && request.url === "/api/show") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ capabilities: ["completion", "tools"] }));
      return;
    }
    if (request.method === "POST" && request.url === "/api/chat") {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.write(
        `${JSON.stringify({
          message: { role: "assistant", content: "hello from mock" },
          done: false,
        })}\n`,
      );
      response.write(
        `${JSON.stringify({
          message: { role: "assistant", content: "" },
          done: true,
          done_reason: "stop",
          prompt_eval_count: 5,
          eval_count: 3,
        })}\n`,
      );
      response.end();
      return;
    }
    response.writeHead(404).end();
  });
  const ollamaPort = await listen(ollama);

  const port = await freePort();
  let child: ChildProcess | undefined;
  let stderr = "";
  try {
    child = spawn(
      process.execPath,
      [serverEntry, "--port", String(port), "--cwd", workdir, "--no-mcp"],
      {
        env: {
          ...process.env,
          OLLAMA_HOST: `http://127.0.0.1:${ollamaPort}`,
          OLLAMA_AGENT_HOME: home,
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const base = `http://127.0.0.1:${port}`;
    await waitForServer(base);

    const state = (await (await fetch(`${base}/api/state`)).json()) as {
      model: string;
      version: string;
      cwd: string;
    };
    assert.equal(state.model, "mock:latest");
    assert.equal(typeof state.version, "string");
    assert.equal(state.cwd, workdir);

    const settings = (await (await fetch(`${base}/api/settings`)).json()) as {
      theme: string;
    };
    assert.equal(settings.theme, "system");

    const chat = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    const stream = await chat.text();
    assert.match(stream, /event: text/);
    assert.match(stream, /hello from mock/);
    assert.match(stream, /event: done/);

    const sessions = (await (await fetch(`${base}/api/sessions`)).json()) as {
      sessions: Array<{ title: string }>;
    };
    assert.ok(sessions.sessions.length >= 1);
    assert.equal(sessions.sessions[0].title, "hi");

    const switched = (await (
      await fetch(`${base}/api/project/set`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: project }),
      })
    ).json()) as { cwd: string; projectInstructions: string };
    assert.equal(switched.cwd, project);
    assert.match(switched.projectInstructions, /AGENTS\.md$/);

    const file = (await (
      await fetch(`${base}/api/file?path=note.txt`)
    ).json()) as { content: string };
    assert.equal(file.content, "project note\n");

    const outside = await fetch(`${base}/api/file?path=../../etc/passwd`);
    assert.equal(outside.status, 500);
    const outsideBody = (await outside.json()) as { error: string };
    assert.match(outsideBody.error, /outside the project/);

    const update = (await (
      await fetch(`${base}/api/update/status`)
    ).json()) as { currentVersion: string };
    assert.equal(update.currentVersion, state.version);
  } finally {
    child?.kill("SIGTERM");
    await new Promise<void>((resolve) => ollama.close(() => resolve()));
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    assert.ok(!stderr.includes("uncaught"), stderr);
  }
});

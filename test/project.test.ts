import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertDirectory,
  loadProjectInstructions,
} from "../src/core/project.ts";
import { buildSystemPrompt } from "../src/core/prompt.ts";
import { readProjectFile } from "../src/core/files.ts";

test("project instructions are discovered and injected", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-project-"));
  await writeFile(path.join(root, "AGENTS.md"), "Use tabs, not spaces.\n");

  const instructions = await loadProjectInstructions(root);
  assert.ok(instructions);
  assert.equal(instructions?.content, "Use tabs, not spaces.\n");

  const prompt = buildSystemPrompt({ cwd: root, instructions });
  assert.match(prompt, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(prompt, /Project instructions/);
  assert.match(prompt, /Use tabs/);
});

test("assertDirectory rejects files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-project-"));
  const file = path.join(root, "file.txt");
  await writeFile(file, "x");
  await assert.rejects(() => assertDirectory(file), /Not a directory/);
  assert.equal(await assertDirectory(root), root);
});

test("readProjectFile stays inside the project and rejects binaries", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-files-"));
  const outsideRoot = await mkdtemp(path.join(tmpdir(), "agent-files-out-"));
  await writeFile(path.join(root, "a.txt"), "hello world\n");
  await writeFile(path.join(root, "blob.bin"), Buffer.from([0, 1, 2, 3]));
  await writeFile(path.join(outsideRoot, "secret.txt"), "nope\n");

  const preview = await readProjectFile(root, "a.txt");
  assert.equal(preview.content, "hello world\n");
  assert.equal(preview.name, "a.txt");

  const absolute = path.join(root, "a.txt");
  assert.equal((await readProjectFile(root, absolute)).content, "hello world\n");

  await assert.rejects(
    () => readProjectFile(root, path.join(outsideRoot, "secret.txt")),
    /outside the project/,
  );
  await assert.rejects(
    () => readProjectFile(root, "../escape.txt"),
    /outside the project/,
  );
  await assert.rejects(() => readProjectFile(root, "blob.bin"), /Binary/);
});

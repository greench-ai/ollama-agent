import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ToolContext, TodoItem } from "../src/core/types.ts";
import { editTool } from "../src/tools/edit.ts";
import { readTool } from "../src/tools/read.ts";
import { writeTool } from "../src/tools/write.ts";
import { todoTool } from "../src/tools/todo.ts";
import { globTool } from "../src/tools/glob.ts";
import { grepTool } from "../src/tools/grep.ts";

function context(cwd: string): ToolContext {
  const todos: TodoItem[] = [];
  return {
    cwd,
    sessionId: "test",
    signal: new AbortController().signal,
    todos,
    log: () => {},
  };
}

test("Write creates parent directories and Read numbers lines", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "agent-test-"));
  const ctx = context(cwd);
  const file = path.join(cwd, "nested", "demo.txt");
  await writeTool.run({ file_path: file, content: "alpha\nbeta\ngamma" }, ctx);

  const read = await readTool.run({ file_path: file }, ctx);
  assert.match(read.content, /1\talpha/);
  assert.match(read.content, /3\tgamma/);

  const slice = await readTool.run({ file_path: file, offset: 1, limit: 1 }, ctx);
  assert.match(slice.content, /2\tbeta/);
  assert.doesNotMatch(slice.content, /alpha/);
});

test("Edit requires a unique match unless replace_all is set", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "agent-test-"));
  const ctx = context(cwd);
  const file = path.join(cwd, "code.ts");
  await writeFile(file, "alpha\nalpha\nbeta\n", "utf8");

  await assert.rejects(
    () => editTool.run({ file_path: file, old_string: "alpha", new_string: "omega" }, ctx),
    /occurs 2 times/,
  );

  const one = await editTool.run(
    { file_path: file, old_string: "beta", new_string: "gamma" },
    ctx,
  );
  assert.match(one.content, /1 replacement/);

  const all = await editTool.run(
    { file_path: file, old_string: "alpha", new_string: "omega", replace_all: true },
    ctx,
  );
  assert.match(all.content, /2 replacement/);
});

test("Edit reports a missing string instead of writing", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "agent-test-"));
  const ctx = context(cwd);
  const file = path.join(cwd, "code.ts");
  await writeFile(file, "hello\n", "utf8");
  await assert.rejects(
    () => editTool.run({ file_path: file, old_string: "absent", new_string: "x" }, ctx),
    /not found/,
  );
});

test("TodoWrite replaces and renders the list", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "agent-test-"));
  const ctx = context(cwd);
  const result = await todoTool.run(
    {
      todos: [
        { content: "Write tests", status: "in_progress", activeForm: "Writing tests" },
        { content: "Run suite", status: "pending", activeForm: "Running suite" },
      ],
    },
    ctx,
  );
  assert.match(result.content, /\[~\] Write tests/);
  assert.match(result.content, /\[ \] Run suite/);
  assert.equal(ctx.todos.length, 2);
});

test("Glob and Grep find a file and its content", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "agent-test-"));
  const ctx = context(cwd);
  await writeFile(path.join(cwd, "needle.ts"), "export const needle = 42;\n", "utf8");

  const globbed = await globTool.run({ pattern: "**/*.ts" }, ctx);
  assert.match(globbed.content, /needle\.ts/);

  const grepped = await grepTool.run({ pattern: "needle", output_mode: "content" }, ctx);
  assert.match(grepped.content, /needle/);
});

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  builtinAgentDefinitions,
  loadAgentDefinitions,
  parseFrontmatter,
  resolveAgentDefinition,
} from "../src/core/agent-definitions.ts";

test("frontmatter parses scalars and block lists", () => {
  const parsed = parseFrontmatter(`---
name: reviewer
description: Reviews changes
tools:
  - Read
  - Grep
model: qwen3:8b
maxTurns: 12
isolation: worktree
background: true
---
Body text.
`);
  assert.ok(parsed);
  assert.equal(parsed?.data.name, "reviewer");
  assert.deepEqual(parsed?.data.tools, ["Read", "Grep"]);
  assert.equal(parsed?.data.maxTurns, 12);
  assert.equal(parsed?.data.background, true);
  assert.equal(parsed?.body, "Body text.");
});

test("frontmatter folds YAML block descriptions and unquotes scalars", () => {
  const parsed = parseFrontmatter(`---
name: "demo"
description: >
  First line
  second line.

  Second paragraph.
---
Body.
`);
  assert.ok(parsed);
  assert.equal(parsed?.data.name, "demo");
  assert.equal(
    parsed?.data.description,
    "First line second line.\n\nSecond paragraph.",
  );
});

test("agent definitions validate and resolve fields", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-defs-"));
  const file = path.join(dir, "audit.md");
  await writeFile(
    file,
    `---
description: Audits security-sensitive code
tools: Read, Grep, Glob
disallowedTools: Bash
permissionMode: plan
model: qwen3:8b
maxTurns: 9
isolation: worktree
---
Audit the change and report findings.
`,
  );

  const definition = await resolveAgentDefinition(file);
  assert.ok(definition);
  assert.equal(definition?.name, "audit");
  assert.equal(definition?.description, "Audits security-sensitive code");
  assert.deepEqual(definition?.tools, ["Read", "Grep", "Glob"]);
  assert.deepEqual(definition?.disallowedTools, ["Bash"]);
  assert.equal(definition?.permissionMode, "plan");
  assert.equal(definition?.model, "qwen3:8b");
  assert.equal(definition?.maxTurns, 9);
  assert.equal(definition?.isolation, "worktree");
  assert.equal(definition?.systemPrompt, "Audit the change and report findings.");

  const missing = path.join(dir, "broken.md");
  await writeFile(missing, "---\nname: broken\n---\nbody\n");
  assert.equal(await resolveAgentDefinition(missing), undefined);
});

test("scopes override built-ins and each other; project wins over user", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "agent-project-"));
  const userDir = await mkdtemp(path.join(tmpdir(), "agent-user-"));
  await mkdir(path.join(cwd, ".ollama-agent", "agents"), { recursive: true });
  await writeFile(
    path.join(userDir, "reviewer.md"),
    "---\nname: reviewer\ndescription: User reviewer\n---\nuser body\n",
  );
  await writeFile(
    path.join(cwd, ".ollama-agent", "agents", "reviewer.md"),
    "---\nname: reviewer\ndescription: Project reviewer\n---\nproject body\n",
  );
  await writeFile(
    path.join(userDir, "explore.md"),
    "---\nname: explore\ndescription: User explore\n---\nuser explore\n",
  );

  const definitions = await loadAgentDefinitions(cwd, { userDir });
  assert.equal(definitions.get("reviewer")?.description, "Project reviewer");
  assert.equal(definitions.get("explore")?.description, "User explore");
  assert.equal(definitions.get("explore")?.builtin, false);
  assert.ok(definitions.get("implementer")?.builtin);
});

test("built-ins cover the core roles", () => {
  const builtins = builtinAgentDefinitions();
  for (const name of [
    "general-purpose",
    "explore",
    "plan",
    "implementer",
    "reviewer",
    "tester",
  ]) {
    assert.ok(builtins.has(name), name);
  }
});

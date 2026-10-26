import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  loadSkills,
  resolveSkill,
  skillCatalogPrompt,
  summarizeSkills,
  type SkillDefinition,
} from "../src/core/skills.ts";
import type { ToolContext, TodoItem } from "../src/core/types.ts";
import { skillTool } from "../src/tools/skill.ts";

async function writeSkill(
  directory: string,
  name: string,
  description: string,
  body: string,
): Promise<string> {
  const root = path.join(directory, name);
  await mkdir(root, { recursive: true });
  const file = path.join(root, "SKILL.md");
  await writeFile(
    file,
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`,
    "utf8",
  );
  await writeFile(path.join(root, "helper.txt"), "resource\n", "utf8");
  return file;
}

function context(cwd: string, skills?: Map<string, SkillDefinition>): ToolContext {
  const todos: TodoItem[] = [];
  return {
    cwd,
    sessionId: "test",
    signal: new AbortController().signal,
    todos,
    log: () => {},
    skills,
  };
}

test("resolves a SKILL.md and lists its resources", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-skill-"));
  const file = await writeSkill(directory, "demo", "Demo skill", "# Demo\nUse $ARGUMENTS.");
  const skill = await resolveSkill(file);
  assert.ok(skill);
  assert.equal(skill?.name, "demo");
  assert.equal(skill?.description, "Demo skill");
  assert.match(skill?.body ?? "", /# Demo/);
  assert.deepEqual(skill?.files, ["SKILL.md", "helper.txt"]);
});

test("project skills override user skills and summaries omit the body", async () => {
  const user = await mkdtemp(path.join(tmpdir(), "agent-skills-user-"));
  const project = await mkdtemp(path.join(tmpdir(), "agent-skills-project-"));
  await writeSkill(user, "shared", "User version", "user body");
  await writeSkill(user, "only-user", "User only", "user only body");
  await writeSkill(
    path.join(project, ".ollama-agent", "skills"),
    "shared",
    "Project version",
    "project body",
  );

  const skills = await loadSkills(project, { userDirs: [user] });
  assert.equal(skills.get("shared")?.description, "Project version");
  assert.equal(skills.get("only-user")?.description, "User only");
  const summary = summarizeSkills(skills).find((entry) => entry.name === "shared");
  assert.ok(summary);
  assert.ok(!("body" in summary!));
  assert.match(skillCatalogPrompt(skills), /shared: Project version/);
});

test("Skill tool loads instructions, substitutes arguments, and errors clearly", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-skill-tool-"));
  await writeSkill(directory, "demo", "Demo skill", "Run $ARGUMENTS now.");
  const skills = await loadSkills(directory, { userDirs: [directory] });
  const ctx = context(directory, skills);

  const result = await skillTool.run({ name: "demo", args: "the tests" }, ctx);
  assert.match(result.content, /Run the tests now\./);
  assert.match(result.content, /Skill root:/);
  assert.match(result.content, /helper\.txt/);

  const unknown = await skillTool.run({ name: "missing" }, ctx);
  assert.equal(unknown.isError, true);
  assert.match(unknown.content, /Unknown skill/);

  const empty = await skillTool.run({ name: "demo" }, context(directory));
  assert.equal(empty.isError, true);
  assert.match(empty.content, /No skills are loaded/);
});

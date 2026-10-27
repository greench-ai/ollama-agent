import assert from "node:assert/strict";
import test from "node:test";
import { buildSystemPrompt } from "../src/core/prompt.ts";
import { allTools } from "../src/tools/index.ts";
import { PERMISSION_MODES } from "../src/core/permissions.ts";

test("the prompt advertises exactly the tools it is given", () => {
  const names = allTools.map((tool) => tool.name);
  const prompt = buildSystemPrompt({ cwd: "/repo", toolNames: names });

  const advertised = /Available tools: ([^.]+)\./.exec(prompt);
  assert.ok(advertised, "prompt must list the tools");
  const listed = advertised[1].split(",").map((name) => name.trim()).sort();
  assert.deepEqual(listed, [...names].sort());
});

test("the prompt does not invent tools that were not provided", () => {
  // Guards the old drift where the CLI prompt named a fixed historical set.
  const prompt = buildSystemPrompt({ cwd: "/repo", toolNames: ["Read", "Grep"] });
  assert.match(prompt, /Available tools: Grep, Read\./);
  assert.doesNotMatch(prompt, /MultiEdit/);
  assert.doesNotMatch(prompt, /TodoWrite/);
  assert.doesNotMatch(prompt, /Available tools:.*Bash/);
});

test("a tool that is provided is mentioned even when it has no note", () => {
  const prompt = buildSystemPrompt({
    cwd: "/repo",
    toolNames: ["Read", "mcp__server__thing"],
  });
  assert.match(prompt, /mcp__server__thing/);
  assert.match(prompt, /read each tool's description/i);
});

test("every permission mode produces distinct guidance", () => {
  const seen = new Set<string>();
  for (const mode of PERMISSION_MODES) {
    const prompt = buildSystemPrompt({ cwd: "/repo", toolNames: ["Read"], mode });
    assert.match(prompt, new RegExp(`Permission mode: ${mode}`));
    const guidance = prompt.split("Working rules")[0];
    seen.add(guidance);
  }
  assert.equal(seen.size, PERMISSION_MODES.length, "modes must not share text");
});

test("plan mode says it is read-only", () => {
  const prompt = buildSystemPrompt({ cwd: "/repo", toolNames: ["Read"], mode: "plan" });
  assert.match(prompt, /plan mode: read-only/i);
});

test("the prompt tells the model to verify changes", () => {
  const prompt = buildSystemPrompt({ cwd: "/repo", toolNames: ["Read", "Edit", "Bash"] });
  assert.match(prompt, /run the project's check/i);
  assert.match(prompt, /Do not claim a change works without it/i);
});

test("verification guidance is omitted for a read-only tool set", () => {
  // A read-only agent cannot verify anything, so promising it would be noise.
  const prompt = buildSystemPrompt({ cwd: "/repo", toolNames: ["Read", "Grep"], mode: "plan" });
  assert.doesNotMatch(prompt, /run the project's check/i);
});

test("project instructions come last and are clearly labelled", () => {
  const prompt = buildSystemPrompt({
    cwd: "/repo",
    toolNames: ["Read"],
    instructions: { path: "/repo/AGENTS.md", content: "Use tabs." },
  });
  const label = prompt.indexOf("Project instructions");
  assert.ok(label > prompt.indexOf("Working rules"), "instructions follow the rules");
  assert.ok(prompt.trimEnd().endsWith("Use tabs."));
});

test("subagent types and extra sections are included when provided", () => {
  const prompt = buildSystemPrompt({
    cwd: "/repo",
    toolNames: ["Read", "Task"],
    subagents: ["explore", "implementer"],
    extra: ["CATALOG_SENTINEL"],
  });
  assert.match(prompt, /Subagent types for the Task tool: explore, implementer\./);
  assert.match(prompt, /CATALOG_SENTINEL/);
});

test("the cwd appears verbatim so the model can use absolute paths", () => {
  const prompt = buildSystemPrompt({ cwd: "/home/x/project", toolNames: [] });
  assert.match(prompt, /Working directory: \/home\/x\/project/);
  assert.match(prompt, /You are a coding agent working in \/home\/x\/project/);
});

test("subagents get a subagent framing", () => {
  const prompt = buildSystemPrompt({ cwd: "/repo", toolNames: ["Read"], subagent: true });
  assert.match(prompt, /You are a coding subagent working in \/repo/);
});

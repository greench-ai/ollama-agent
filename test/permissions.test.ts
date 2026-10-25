import assert from "node:assert/strict";
import test from "node:test";
import { PermissionEngine, ruleKey } from "../src/core/permissions.ts";
import type { AskOutcome } from "../src/core/permissions.ts";

const readRequest = { tool: "Read", input: { file_path: "/tmp/a" }, mutating: false };
const writeRequest = { tool: "Write", input: { file_path: "/tmp/a" }, mutating: true };
const bashRequest = { tool: "Bash", input: { command: "npm test" }, mutating: true };

test("default mode allows read-only tools without asking", async () => {
  const engine = new PermissionEngine("default", async () => "deny");
  assert.deepEqual(await engine.check(readRequest), { allowed: true });
});

test("default mode denies mutating tools when the user says no", async () => {
  const engine = new PermissionEngine("default", async () => "deny");
  const result = await engine.check(writeRequest);
  assert.equal(result.allowed, false);
});

test("always is remembered for the rest of the session", async () => {
  let calls = 0;
  const engine = new PermissionEngine("default", async () => {
    calls += 1;
    return "always";
  });
  assert.equal((await engine.check(bashRequest)).allowed, true);
  assert.equal((await engine.check(bashRequest)).allowed, true);
  assert.equal(calls, 1);
  assert.equal(ruleKey("Bash", { command: "npm test --watch" }), "Bash(npm)");
});

test("acceptEdits auto-approves edits but still asks for Bash", async () => {
  let asked = 0;
  const ask = async (): Promise<AskOutcome> => {
    asked += 1;
    return "deny";
  };
  const engine = new PermissionEngine("acceptEdits", ask);
  assert.equal((await engine.check(writeRequest)).allowed, true);
  assert.equal((await engine.check(bashRequest)).allowed, false);
  assert.equal(asked, 1);
});

test("plan mode is read-only", async () => {
  const engine = new PermissionEngine("plan", async () => "allow");
  assert.equal((await engine.check(readRequest)).allowed, true);
  assert.equal((await engine.check(writeRequest)).allowed, false);
  assert.equal((await engine.check(bashRequest)).allowed, false);
});

test("bypassPermissions allows everything", async () => {
  const engine = new PermissionEngine("bypassPermissions");
  assert.equal((await engine.check(writeRequest)).allowed, true);
  assert.equal((await engine.check(bashRequest)).allowed, true);
});

import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadSettings, settingsPath, updateSettings } from "../src/core/settings.ts";

test("settings default, persist, and ignore invalid values", async () => {
  process.env.OLLAMA_AGENT_HOME = await mkdtemp(path.join(tmpdir(), "agent-settings-"));

  const defaults = await loadSettings();
  assert.equal(defaults.theme, "system");
  assert.equal(defaults.mode, "default");
  assert.equal(defaults.showThinking, true);
  assert.equal(defaults.model, undefined);

  const saved = await updateSettings({
    theme: "dark",
    model: "qwen3:8b",
    mode: "acceptEdits",
    showThinking: false,
  });
  assert.deepEqual(saved, {
    theme: "dark",
    model: "qwen3:8b",
    mode: "acceptEdits",
    showThinking: false,
  });

  const reloaded = await loadSettings();
  assert.deepEqual(reloaded, saved);

  const body = JSON.parse(await readFile(settingsPath(), "utf8"));
  assert.equal(body.theme, "dark");

  const ignored = await updateSettings({
    theme: "neon" as never,
    mode: "nope" as never,
  });
  assert.equal(ignored.theme, "dark");
  assert.equal(ignored.mode, "acceptEdits");

  const cleared = await updateSettings({ model: "" });
  assert.equal(cleared.model, undefined);
});

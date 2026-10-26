import assert from "node:assert/strict";
import test from "node:test";
import { promptText, toolKind } from "../src/acp.ts";

test("ACP prompt blocks map to text, resources, and images", () => {
  const prompt = promptText([
    { type: "text", text: "hello" },
    { type: "resource_link", name: "notes", uri: "file:///tmp/notes.md" },
    { type: "resource", resource: { uri: "file:///tmp/a.txt", text: "body" } },
    { type: "image", data: "YWJj", mimeType: "image/png" },
  ]);
  assert.match(prompt.text, /hello/);
  assert.match(prompt.text, /notes/);
  assert.match(prompt.text, /body/);
  assert.equal(prompt.images.length, 1);
  assert.equal(prompt.images[0]?.data, "YWJj");
  assert.equal(prompt.text.length > 0, true);

  const imageOnly = promptText([
    { type: "image", data: "YWJj", mimeType: "image/png" },
  ]);
  assert.match(imageOnly.text, /attached image/i);
});

test("ACP maps tools to protocol kinds", () => {
  assert.equal(toolKind("Read"), "read");
  assert.equal(toolKind("Grep"), "search");
  assert.equal(toolKind("Edit"), "edit");
  assert.equal(toolKind("Bash"), "execute");
  assert.equal(toolKind("TeamSpawn"), "other");
  assert.equal(toolKind("srv__thing"), "other");
});

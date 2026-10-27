import assert from "node:assert/strict";
import test from "node:test";
import { compactMessages, recapMessage } from "../src/core/tokens.ts";
import type { Message } from "../src/core/types.ts";

function user(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}
function assistant(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }] };
}
function toolResult(id: string, content: string): Message {
  return {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, name: "Read", content }],
  };
}

function conversation(turns: number, chars = 2_000): Message[] {
  const messages: Message[] = [user("ORIGINAL TASK: refactor the parser")];
  for (let i = 0; i < turns; i += 1) {
    messages.push(assistant("y".repeat(chars)));
    messages.push(user(`turn ${i}`));
  }
  return messages;
}

test("compaction keeps the original request instead of dropping it", () => {
  const messages = conversation(40);
  const result = compactMessages(messages, 4_000);

  assert.ok(result.dropped > 0, "something should be dropped");
  assert.equal(result.messages[0].role, "user");
  const first = result.messages[0].content[0];
  assert.equal(first.type, "text");
  assert.match(
    (first as { text: string }).text,
    /ORIGINAL TASK: refactor the parser/,
    "the stated goal must survive compaction",
  );
});

test("a recap note explains the drops to the model", () => {
  const result = compactMessages(conversation(40), 4_000);
  const note = result.messages
    .flatMap((message) => message.content)
    .find((block) => block.type === "text" && /Context note/.test(block.text));
  assert.ok(note, "expected a context note");
  assert.match((note as { text: string }).text, /refactor the parser/);
  assert.match((note as { text: string }).text, /Earlier turns were dropped/);
});

test("compaction always terminates and shrinks the conversation", () => {
  const messages = conversation(60);
  const result = compactMessages(messages, 3_000);
  assert.ok(
    result.messages.length < messages.length,
    `expected a shrink, got ${result.messages.length} vs ${messages.length}`,
  );
});

test("compaction never separates a tool_use from its tool_result", () => {
  const messages: Message[] = [
    user("fix the bug"),
    assistant("a".repeat(2_000)),
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
    toolResult("t1", "r".repeat(2_000)),
    assistant("b".repeat(2_000)),
    user("next"),
    assistant("c".repeat(2_000)),
    user("last"),
  ];
  const result = compactMessages(messages, 1_500);
  const ids = new Set<string>();
  for (const message of result.messages) {
    for (const block of message.content) {
      if (block.type === "tool_use") ids.add(block.id);
    }
  }
  for (const message of result.messages) {
    for (const block of message.content) {
      if (block.type === "tool_result") {
        assert.ok(ids.has(block.tool_use_id), "orphaned tool_result left behind");
      }
    }
  }
});

test("a conversation that already fits is returned untouched", () => {
  const messages = [user("hi"), assistant("hello")];
  const result = compactMessages(messages, 100_000);
  assert.equal(result.dropped, 0);
  assert.equal(result.truncated, 0);
  assert.deepEqual(result.messages, messages);
});

test("oversized tool results are truncated before turns are dropped", () => {
  const messages: Message[] = [user("task"), toolResult("t1", "z".repeat(20_000)), user("next")];
  // Budget is below the raw 20k-char result but above a truncated one.
  const result = compactMessages(messages, 2_500);
  assert.equal(result.truncated, 1);
  assert.equal(result.dropped, 0, "truncation should be enough on its own");
  const block = result.messages
    .flatMap((message) => message.content)
    .find((entry) => entry.type === "tool_result");
  assert.ok(block, "tool result should still be present");
  assert.match((block as { content: string }).content, /truncated \d+ chars/);
});

test("recapMessage ignores a message with no prose", () => {
  assert.equal(recapMessage(toolResult("t1", "x")), undefined);
});

test("recapMessage truncates a very long request", () => {
  const recap = recapMessage(user("q".repeat(5_000)));
  assert.ok(recap);
  const text = (recap!.content[0] as { text: string }).text;
  assert.ok(text.length < 600, `recap too long: ${text.length}`);
  assert.match(text, /…/);
});

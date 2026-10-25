import assert from "node:assert/strict";
import test from "node:test";
import { normalizeHost, toOllamaMessages } from "../src/core/ollama.ts";
import type { Message } from "../src/core/types.ts";

test("normalizeHost adds a scheme and strips trailing slashes", () => {
  assert.equal(normalizeHost("127.0.0.1:11434"), "http://127.0.0.1:11434");
  assert.equal(normalizeHost("https://ollama.com/"), "https://ollama.com");
  assert.equal(normalizeHost(""), "http://127.0.0.1:11434");
});

test("images attach to user messages and follow tool results", () => {
  const messages: Message[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image", data: "AAAA", mimeType: "image/png", name: "shot.png" },
      ],
    },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "c1", name: "Read", input: {} }],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "c1",
          name: "Read",
          content: "[image]",
          images: [{ data: "BBBB", mimeType: "image/png", name: "chart.png" }],
        },
      ],
    },
  ];

  const mapped = toOllamaMessages(messages, "system");
  const user = mapped.find((entry) => entry.role === "user" && entry.content === "what is this?");
  assert.deepEqual(user?.images, ["AAAA"]);

  const tool = mapped.find((entry) => entry.role === "tool");
  assert.equal(tool?.content, "[image]");

  const follow = mapped.find(
    (entry) =>
      entry.role === "user" &&
      typeof entry.content === "string" &&
      entry.content.includes("Images returned by tool results"),
  );
  assert.deepEqual(follow?.images, ["BBBB"]);
  assert.match(String(follow?.content), /chart\.png/);
});

test("conversation maps to Ollama chat messages", () => {
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: "list files" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "I should call Bash." },
        { type: "text", text: "Running ls." },
        { type: "tool_use", id: "c1", name: "Bash", input: { command: "ls" } },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "c1",
          name: "Bash",
          content: "a.txt",
        },
      ],
    },
  ];

  const mapped = toOllamaMessages(messages, "system prompt");
  assert.equal(mapped[0].role, "system");
  assert.equal(mapped[1].role, "user");
  assert.equal(mapped[2].role, "assistant");
  assert.equal(mapped[2].content, "Running ls.");
  assert.deepEqual(mapped[2].tool_calls, [
    { function: { name: "Bash", arguments: { command: "ls" } } },
  ]);
  // Thinking is not replayed into the model context.
  assert.equal(mapped[3].role, "tool");
  assert.equal(mapped[3].tool_name, "Bash");
  assert.equal(mapped[3].content, "a.txt");
});

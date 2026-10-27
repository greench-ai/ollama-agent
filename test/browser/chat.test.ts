/**
 * Browser regression tests for the web chat client.
 *
 * These are deliberately not part of `npm test`: they need a real Chromium and
 * take seconds, while the unit suite is expected to stay sub-second. Run them
 * with `npm run test:web`.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { assistantBlocks, openApp, sendMessage, sseBody } from "./harness.ts";
import type { SseEvent } from "./harness.ts";

/** A turn that goes prose -> tool -> prose -> tool -> prose. */
const INTERLEAVED: SseEvent[] = [
  ["thinking", { text: "Let me look at the file first." }],
  ["text", { text: "I'll start by reading the file." }],
  [
    "tool_start",
    {
      name: "Read",
      summary: "/tmp/demo.txt",
      input: { file_path: "/tmp/demo.txt" },
      id: "c1",
    },
  ],
  ["tool_end", { name: "Read", content: "file contents", isError: false, id: "c1" }],
  ["text", { text: "Now I understand it. Editing next." }],
  [
    "tool_start",
    {
      name: "Edit",
      summary: "/tmp/demo.txt",
      input: { file_path: "/tmp/demo.txt" },
      id: "c2",
    },
  ],
  ["tool_end", { name: "Edit", content: "ok", isError: false, id: "c2" }],
  ["text", { text: "Done. The change is in place." }],
];

test("prose and tool cards keep the order they were streamed in", async () => {
  const app = await openApp({ routes: { "/api/chat": () => sseBody(INTERLEAVED) } });
  try {
    await sendMessage(app.page, "do the thing");
    assert.deepEqual(await assistantBlocks(app.page), [
      "thinking",
      "text:I'll start by reading the file.",
      "tool:Read",
      "text:Now I understand it. Editing next.",
      "tool:Edit",
      "text:Done. The change is in place.",
      "actions",
    ]);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});

test("text is never dropped when a tool call interrupts it", async () => {
  // Text was once flushed by clearing the buffer, which silently discarded it.
  const app = await openApp({ routes: { "/api/chat": () => sseBody(INTERLEAVED) } });
  try {
    await sendMessage(app.page, "go");
    const blocks = await assistantBlocks(app.page);
    const prose = blocks.filter((block) => block.startsWith("text:"));
    assert.equal(prose.length, 3, `expected three paragraphs, got ${JSON.stringify(prose)}`);
    for (const block of prose) {
      assert.notEqual(block, "text:(empty)", "a paragraph rendered empty");
    }
  } finally {
    await app.close();
  }
});

test("the transcript follows the stream to the bottom", async () => {
  // A tall turn: many blocks appended after the first. The old client used a
  // 180px "near bottom" threshold that a full tool card exceeds, so it stopped
  // following partway through and later output rendered off-screen.
  const events: SseEvent[] = [["text", { text: "starting a long turn" }]];
  for (let i = 0; i < 12; i += 1) {
    events.push([
      "tool_start",
      { name: "Read", summary: `file-${i}.txt`, input: {}, id: `t${i}` },
    ]);
    events.push([
      "tool_end",
      {
        name: "Read",
        content: `line ${i}\n`.repeat(12),
        isError: false,
        id: `t${i}`,
      },
    ]);
    events.push(["text", { text: `Finished step ${i}.` }]);
  }
  const app = await openApp({ routes: { "/api/chat": () => sseBody(events) } });
  try {
    await sendMessage(app.page, "go");
    const scroll = (await app.page.evaluate(`(() => {
      const log = document.getElementById("log");
      return {
        atBottom: log.scrollHeight - log.scrollTop - log.clientHeight < 24,
        gap: log.scrollHeight - log.scrollTop - log.clientHeight,
        scrollable: log.scrollHeight > log.clientHeight * 2,
      };
    })()`)) as { atBottom: boolean; gap: number; scrollable: boolean };
    assert.equal(scroll.scrollable, true, "fixture should overflow well past one screen");
    assert.equal(scroll.atBottom, true, `view fell behind by ${scroll.gap}px`);
  } finally {
    await app.close();
  }
});

test("scrolling up to read history is not yanked back", async () => {
  const events: SseEvent[] = [];
  for (let i = 0; i < 12; i += 1) {
    events.push(["text", { text: `Paragraph ${i}.` }]);
    events.push([
      "tool_start",
      { name: "Read", summary: `f${i}`, input: {}, id: `s${i}` },
    ]);
    events.push([
      "tool_end",
      { name: "Read", content: `out ${i}\n`.repeat(10), isError: false, id: `s${i}` },
    ]);
  }
  const app = await openApp({ routes: { "/api/chat": () => sseBody(events) } });
  try {
    await sendMessage(app.page, "go");
    // Simulate the user scrolling up mid-session, then more output arriving.
    await app.page.evaluate(`(() => {
      const log = document.getElementById("log");
      log.scrollTop = 0;
      log.dispatchEvent(new Event("scroll"));
    })()`);
    const after = (await app.page.evaluate(`(() => {
      const log = document.getElementById("log");
      return { top: log.scrollTop, atBottom: log.scrollHeight - log.scrollTop - log.clientHeight < 24 };
    })()`)) as { top: number; atBottom: boolean };
    assert.equal(after.atBottom, false, "user position should be preserved");
  } finally {
    await app.close();
  }
});

test("copy on an assistant message yields all of its prose", async () => {
  const app = await openApp({ routes: { "/api/chat": () => sseBody(INTERLEAVED) } });
  try {
    await sendMessage(app.page, "go");
    const button = app.page.locator(".msg.assistant .msg-actions button").last();
    assert.equal(await button.textContent(), "Copy");
    await button.click();
    await app.page.waitForTimeout(300);
    const copied = String(
      await app.page.evaluate(`navigator.clipboard.readText()`),
    );
    assert.match(copied, /I'll start by reading the file\./);
    assert.match(copied, /Now I understand it\./);
    assert.match(copied, /Done\. The change is in place\./);
  } finally {
    await app.close();
  }
});

test("tool cards are only marked running while in flight", async () => {
  // A single-slot client left the first card stuck on "running..." forever.
  const events: SseEvent[] = [
    ["tool_start", { name: "Read", summary: "a", input: {}, id: "p1" }],
    ["tool_start", { name: "Grep", summary: "b", input: {}, id: "p2" }],
    ["tool_end", { name: "Read", content: "contents-of-a", isError: false, id: "p1" }],
    ["tool_end", { name: "Grep", content: "contents-of-b", isError: false, id: "p2" }],
    ["text", { text: "both done" }],
  ];
  const app = await openApp({ routes: { "/api/chat": () => sseBody(events) } });
  try {
    await sendMessage(app.page, "go");
    const bodies = await app.page.evaluate(`(() => {
      return [...document.querySelectorAll(".msg.assistant .tool pre")]
        .map((node) => node.textContent);
    })()`);
    assert.deepEqual(bodies, ["contents-of-a", "contents-of-b"]);
  } finally {
    await app.close();
  }
});

test("shows Working… during a turn and Idle when done", async () => {
  const app = await openApp({
    routes: {
      "/api/chat": async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return sseBody([["text", { text: "finished" }]]);
      },
    },
  });
  try {
    assert.equal(
      await app.page.textContent("#agent-status-label"),
      "Idle",
    );
    await app.page.fill("#input", "status test");
    await app.page.evaluate(`document.getElementById("composer").requestSubmit()`);
    await app.page.waitForFunction(
      `() => document.getElementById("agent-status-label")?.textContent === "Working…"`,
    );
    await app.page.waitForFunction(
      `() => document.getElementById("agent-status-label")?.textContent === "Idle"`,
      undefined,
      { timeout: 10_000 },
    );
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});

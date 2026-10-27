import type { Message, ToolResultBlock, ContentBlock } from "./types.ts";

/** Longest recap of the original request kept across compaction. */
const MAX_RECAP_CHARS = 400;

/** Rough token estimate: ~4 characters per token for English and code. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function blockTokens(block: ContentBlock): number {
  switch (block.type) {
    case "text":
      return estimateTokens(block.text);
    case "thinking":
      return estimateTokens(block.thinking);
    case "image":
      // Vision encoders vary; budget a flat allowance per image.
      return 1_000;
    case "file":
      return estimateTokens(block.content) + 20;
    case "tool_use":
      return estimateTokens(block.name) + estimateTokens(JSON.stringify(block.input));
    case "tool_result":
      return estimateTokens(block.content);
  }
}

export function estimateMessageTokens(message: Message): number {
  return message.content.reduce((sum, block) => sum + blockTokens(block), 8);
}

export function estimateMessages(messages: Message[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

function hasText(message: Message): boolean {
  return message.content.some((block) => block.type === "text" && block.text.trim() !== "");
}

/**
 * Trim the oldest turns until the conversation fits the budget.
 *
 * Cuts are made at a user turn that starts a fresh exchange, so an assistant
 * tool_use is never separated from its tool_result. Very large tool results are
 * truncated first, because they are the usual cause of overflow and dropping
 * them loses less than dropping whole turns.
 *
 * The first user message is always kept when dropping turns: it states the
 * task, and compaction used to discard it, leaving the model working on a goal
 * it could no longer see. Its text is also carried forward as a recap note so
 * the reason for the work survives even if the original is later dropped.
 */
export function compactMessages(
  messages: Message[],
  maxTokens: number,
): { messages: Message[]; dropped: number; truncated: number } {
  let current = messages;
  let dropped = 0;
  let truncated = 0;

  if (estimateMessages(current) <= maxTokens) {
    return { messages: current, dropped, truncated };
  }

  // Pass 1: truncate oversized tool results.
  const perResultLimit = 4000;
  current = current.map((message) => {
    if (message.role !== "user") return message;
    let changed = false;
    const content = message.content.map((block): ContentBlock => {
      if (block.type !== "tool_result") return block;
      const result = block as ToolResultBlock;
      if (result.content.length <= perResultLimit) return result;
      changed = true;
      truncated += 1;
      return {
        ...result,
        content:
          result.content.slice(0, perResultLimit) +
          `\n\n[truncated ${result.content.length - perResultLimit} chars]`,
      };
    });
    return changed ? { ...message, content } : message;
  });

  // Pass 2: drop whole turns from the front while keeping the opening request.
  //
  // The opening message is held aside, the rest is trimmed, and then the
  // opening message plus a short recap are put back at the head. Doing it in
  // that order keeps the cut simple: the recap is never itself a cut point, so
  // each iteration removes at least one message and the loop must terminate.
  const pinned = openingMessage(current);
  if (pinned && pinned === current[0]) {
    const tail = current.slice(1);
    let trimmed = tail;
    while (estimateMessages([pinned, ...trimmed]) > maxTokens && trimmed.length > 3) {
      let cut = -1;
      for (let i = 1; i < trimmed.length - 1; i += 1) {
        if (trimmed[i].role === "user" && hasText(trimmed[i])) {
          cut = i;
          break;
        }
      }
      if (cut <= 0) break;
      dropped += cut;
      trimmed = trimmed.slice(cut);
    }
    const recap = recapMessage(pinned);
    current = recap ? [pinned, recap, ...trimmed] : [pinned, ...trimmed];
  }

  return { messages: current, dropped, truncated };
}

/** The first user message that carries actual prose, i.e. the stated task. */
function openingMessage(messages: Message[]): Message | undefined {
  for (const message of messages) {
    if (message.role === "user" && hasText(message)) {
      // Only the text blocks; tool results are noise when recapping.
      const text = message.content
        .filter((block): block is Extract<ContentBlock, { type: "text" }> =>
          block.type === "text",
        )
        .map((block) => block.text)
        .join("\n")
        .trim();
      if (!text) return undefined;
      return message;
    }
  }
  return undefined;
}

/** A short note reminding the model what the original request was. */
export function recapMessage(original: Message): Message | undefined {
  if (original.role !== "user") return undefined;
  const text = original.content
    .filter((block): block is Extract<ContentBlock, { type: "text" }> =>
      block.type === "text",
    )
    .map((block) => block.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  const trimmed = text.length > MAX_RECAP_CHARS ? `${text.slice(0, MAX_RECAP_CHARS)}…` : text;
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `[Context note: the original request was "${trimmed}". Earlier turns were dropped to fit the context window; continue toward that goal.]`,
      },
    ],
  };
}

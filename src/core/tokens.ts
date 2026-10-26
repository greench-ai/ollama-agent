import type { Message, ToolResultBlock, ContentBlock } from "./types.ts";

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

  // Pass 2: drop whole turns from the front.
  while (estimateMessages(current) > maxTokens && current.length > 4) {
    let cut = -1;
    for (let i = 1; i < current.length - 1; i += 1) {
      if (current[i].role === "user" && hasText(current[i])) {
        cut = i;
        break;
      }
    }
    if (cut <= 0) break;
    dropped += cut;
    current = current.slice(cut);
  }

  return { messages: current, dropped, truncated };
}

import { readFile, writeFile } from "node:fs/promises";
import type { Tool, ToolResult } from "../core/types.ts";
import { assertWithinRoot, requireAbsolutePath, requireString } from "./shared.ts";

function diffSummary(before: string, after: string): string {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  let first = 0;
  while (
    first < beforeLines.length &&
    first < afterLines.length &&
    beforeLines[first] === afterLines[first]
  ) {
    first += 1;
  }
  let beforeEnd = beforeLines.length - 1;
  let afterEnd = afterLines.length - 1;
  while (
    beforeEnd >= first &&
    afterEnd >= first &&
    beforeLines[beforeEnd] === afterLines[afterEnd]
  ) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  const removed = beforeEnd - first + 1;
  const added = afterEnd - first + 1;
  return `line ${first + 1}: -${removed} +${added}`;
}

/**
 * Whitespace-tolerant fallback: match a run of whole lines after trimming
 * indentation and trailing spaces. It never guesses within a line.
 */
function fuzzyReplace(
  text: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): { after: string; count: number } {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const oldLines = oldString.split(/\r?\n/);
  if (oldLines.length === 0) return { after: text, count: 0 };
  const matches: Array<{ start: number }> = [];
  for (let start = 0; start + oldLines.length <= lines.length; start += 1) {
    let match = true;
    for (let offset = 0; offset < oldLines.length; offset += 1) {
      if (lines[start + offset].trim() !== oldLines[offset].trim()) {
        match = false;
        break;
      }
    }
    if (match) matches.push({ start });
  }
  if (matches.length === 0) return { after: text, count: 0 };
  if (matches.length > 1 && !replaceAll) {
    throw new Error(
      `old_string occurs ${matches.length} times after whitespace normalization. ` +
        "Include more surrounding context to make it unique, or set replace_all.",
    );
  }
  const newLines = newString.split(/\r?\n/);
  const selected = replaceAll ? matches : matches.slice(0, 1);
  for (const match of [...selected].reverse()) {
    lines.splice(match.start, oldLines.length, ...newLines);
  }
  return { after: lines.join(eol), count: selected.length };
}

export const editTool: Tool = {
  name: "Edit",
  description:
    "Replace a string in a file. old_string must be unique unless replace_all " +
    "is true. An exact match is preferred; if it is not found, whole lines are " +
    "matched after trimming indentation and trailing whitespace. Read the file " +
    "first so the replacement is accurate.",
  mutating: true,
  inputSchema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "The absolute path to the file to modify.",
      },
      old_string: { type: "string", description: "The text to replace." },
      new_string: {
        type: "string",
        description: "The replacement text; must differ from old_string.",
      },
      replace_all: {
        type: "boolean",
        description: "Replace every occurrence (default false).",
      },
    },
    required: ["file_path", "old_string", "new_string"],
  },

  async run(input, ctx): Promise<ToolResult> {
    const filePath = requireAbsolutePath(input);
    await assertWithinRoot(filePath, ctx.allowedRoot);
    const oldString = requireString(input, "old_string");
    const newString = requireString(input, "new_string");
    const replaceAll = input.replace_all === true;

    if (oldString === newString) {
      throw new Error("old_string and new_string are identical; nothing to do.");
    }

    let before: string;
    try {
      before = await readFile(filePath, "utf8");
    } catch {
      throw new Error(`File not found: ${filePath}`);
    }

    const occurrences = before.split(oldString).length - 1;
    let after: string;
    let count = occurrences;
    let fuzzy = false;
    if (occurrences === 0) {
      const fallback = fuzzyReplace(before, oldString, newString, replaceAll);
      if (fallback.count === 0) {
        throw new Error(
          `old_string not found in ${filePath}, including after whitespace normalization. ` +
            "Read the file again and copy the text exactly.",
        );
      }
      after = fallback.after;
      count = fallback.count;
      fuzzy = true;
    } else {
      if (occurrences > 1 && !replaceAll) {
        throw new Error(
          `old_string occurs ${occurrences} times in ${filePath}. ` +
            "Include more surrounding context to make it unique, or set replace_all.",
        );
      }
      after = replaceAll
        ? before.split(oldString).join(newString)
        : before.replace(oldString, newString);
    }
    await writeFile(filePath, after, "utf8");

    return {
      content:
        `Updated ${filePath} (${count} replacement(s))${fuzzy ? " using a whitespace-tolerant match" : ""}.\n` +
        diffSummary(before, after),
    };
  },
};

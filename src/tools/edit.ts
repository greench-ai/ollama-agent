import { readFile, writeFile } from "node:fs/promises";
import type { Tool, ToolResult } from "../core/types.ts";
import { requireAbsolutePath, requireString } from "./shared.ts";

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

export const editTool: Tool = {
  name: "Edit",
  description:
    "Replace an exact string in a file. old_string must be unique unless " +
    "replace_all is true. Read the file first so the replacement matches " +
    "indentation exactly.",
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

  async run(input): Promise<ToolResult> {
    const filePath = requireAbsolutePath(input);
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
    if (occurrences === 0) {
      throw new Error(`old_string not found in ${filePath}.`);
    }
    if (occurrences > 1 && !replaceAll) {
      throw new Error(
        `old_string occurs ${occurrences} times in ${filePath}. ` +
          "Include more surrounding context to make it unique, or set replace_all.",
      );
    }

    const after = replaceAll
      ? before.split(oldString).join(newString)
      : before.replace(oldString, newString);
    await writeFile(filePath, after, "utf8");

    return {
      content:
        `Updated ${filePath} (${occurrences} replacement(s)).\n` +
        diffSummary(before, after),
    };
  },
};

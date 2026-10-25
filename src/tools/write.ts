import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Tool, ToolResult } from "../core/types.ts";
import {
  requireAbsolutePath,
  requireString,
} from "./shared.ts";

export const writeTool: Tool = {
  name: "Write",
  description:
    "Write a file to the local filesystem, creating parent directories. " +
    "Overwrites an existing file. Use Edit for partial changes to a file you " +
    "have already read.",
  mutating: true,
  inputSchema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Absolute path of the file to write.",
      },
      content: {
        type: "string",
        description: "Full content to write.",
      },
    },
    required: ["file_path", "content"],
  },

  async run(input): Promise<ToolResult> {
    const filePath = requireAbsolutePath(input);
    const content = requireString(input, "content");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");
    const lines = content === "" ? 0 : content.split("\n").length;
    return {
      content: `Wrote ${Buffer.byteLength(content)} bytes (${lines} lines) to ${filePath}.`,
    };
  },
};

export const multiEditTool: Tool = {
  name: "MultiEdit",
  description:
    "Apply several exact string replacements to one file in a single call. " +
    "Edits are applied in order; each old_string must match exactly once.",
  mutating: true,
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path of the file." },
      edits: {
        type: "array",
        items: {
          type: "object",
          properties: {
            old_string: { type: "string" },
            new_string: { type: "string" },
            replace_all: { type: "boolean" },
          },
          required: ["old_string", "new_string"],
        },
      },
    },
    required: ["file_path", "edits"],
  },

  async run(input): Promise<ToolResult> {
    const filePath = requireAbsolutePath(input);
    const rawEdits = input.edits;
    if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
      throw new Error('"edits" must be a non-empty array.');
    }
    let text = await readFile(filePath, "utf8");
    const applied: string[] = [];

    for (const [index, raw] of rawEdits.entries()) {
      if (!raw || typeof raw !== "object") {
        throw new Error(`edits[${index}] must be an object.`);
      }
      const edit = raw as Record<string, unknown>;
      const oldString = requireString(edit, "old_string");
      const newString = requireString(edit, "new_string");
      const replaceAll = edit.replace_all === true;
      const count = text.split(oldString).length - 1;
      if (count === 0) {
        throw new Error(`edits[${index}]: old_string not found in ${filePath}.`);
      }
      if (count > 1 && !replaceAll) {
        throw new Error(
          `edits[${index}]: old_string occurs ${count} times. ` +
            "Add more context or set replace_all.",
        );
      }
      text = replaceAll
        ? text.split(oldString).join(newString)
        : text.replace(oldString, newString);
      applied.push(`edit ${index + 1}: ${count} replacement(s)`);
    }

    await writeFile(filePath, text, "utf8");
    return { content: `Updated ${filePath}.\n${applied.join("\n")}` };
  },
};

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Tool, ToolResult } from "../core/types.ts";
import {
  ToolInputError,
  optionalNumber,
  requireAbsolutePath,
  truncate,
} from "./shared.ts";

const DEFAULT_LINES = 2000;
const MAX_LINE_LENGTH = 2000;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

export const readTool: Tool = {
  name: "Read",
  description:
    "Read a file from the local filesystem. Returns line-numbered content " +
    "(cat -n format). Use offset and limit for large files. Images and PDFs " +
    "are reported but not rendered in this terminal client.",
  mutating: false,
  inputSchema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "The absolute path to the file to read.",
      },
      offset: {
        type: "integer",
        minimum: 0,
        description: "Line number to start reading from (0-based).",
      },
      limit: {
        type: "integer",
        minimum: 1,
        description: "Number of lines to read.",
      },
      pages: {
        type: "string",
        description: 'Page range for PDFs, e.g. "1-5".',
      },
    },
    required: ["file_path"],
  },

  async run(input, ctx): Promise<ToolResult> {
    const filePath = requireAbsolutePath(input);
    let info;
    try {
      info = await stat(filePath);
    } catch {
      throw new ToolInputError(`File not found: ${filePath}`);
    }
    if (info.isDirectory()) {
      throw new ToolInputError(
        `"${filePath}" is a directory. Use Glob or Grep to inspect directories.`,
      );
    }

    const extension = path.extname(filePath).toLowerCase();
    if (IMAGE_EXTENSIONS.has(extension)) {
      return {
        content: `[image "${path.basename(filePath)}", ${info.size} bytes — this client does not render images]`,
      };
    }
    if (extension === ".pdf") {
      return {
        content: `[PDF "${path.basename(filePath)}", ${info.size} bytes — PDF page extraction is not implemented]`,
      };
    }

    const buffer = await readFile(filePath);
    if (buffer.includes(0)) {
      throw new ToolInputError(
        `"${filePath}" appears to be a binary file (${info.size} bytes).`,
      );
    }

    const text = buffer.toString("utf8");
    const lines = text.split("\n");
    const offset = Math.max(0, Math.floor(optionalNumber(input, "offset") ?? 0));
    const limit = Math.max(1, Math.floor(optionalNumber(input, "limit") ?? DEFAULT_LINES));
    const slice = lines.slice(offset, offset + limit);

    if (slice.length === 0) {
      return { content: `(file is empty or offset ${offset} is past the end)` };
    }

    const rendered = slice
      .map((line, index) => {
        const number = `${String(offset + index + 1).padStart(6, " ")}\t`;
        const clipped =
          line.length > MAX_LINE_LENGTH
            ? `${line.slice(0, MAX_LINE_LENGTH)}…`
            : line;
        return `${number}${clipped}`;
      })
      .join("\n");

    const more = offset + limit < lines.length;
    const suffix = more
      ? `\n\n[${lines.length - (offset + slice.length)} more lines; continue with offset=${offset + slice.length}]`
      : "";

    void ctx;
    return { content: truncate(rendered, 120_000) + suffix };
  },
};

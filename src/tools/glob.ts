import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { Tool, ToolResult } from "../core/types.ts";
import {
  displayPath,
  globToRegExp,
  optionalString,
  requireString,
  walkFiles,
} from "./shared.ts";

const MAX_RESULTS = 500;

export const globTool: Tool = {
  name: "Glob",
  description:
    "Find files by glob pattern (e.g. \"**/*.ts\", \"src/**/*.{js,tsx}\"). " +
    "Returns paths sorted by modification time, newest first. Use it for " +
    "file-name searches; use Grep for content searches.",
  mutating: false,
  inputSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "The glob pattern to match files against.",
      },
      path: {
        type: "string",
        description:
          "Directory to search in. Defaults to the current working directory.",
      },
    },
    required: ["pattern"],
  },

  async run(input, ctx): Promise<ToolResult> {
    const pattern = requireString(input, "pattern");
    const rawPath = optionalString(input, "path");
    const root = rawPath ? path.resolve(ctx.cwd, rawPath) : ctx.cwd;
    const matcher = globToRegExp(pattern);

    let matched = await new Promise<string[]>((resolve) => {
      const child = spawn("rg", ["--files", "--glob", pattern], { cwd: root });
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (stdout.length > 4_000_000) child.kill("SIGKILL");
      });
      child.on("error", () => resolve([]));
      child.on("close", (code) => {
        if (code === 0 || code === 1) {
          resolve(
            stdout
              .split("\n")
              .filter(Boolean)
              .map((relative) => path.resolve(root, relative)),
          );
        } else {
          resolve([]);
        }
      });
    });

    if (matched.length === 0) {
      const all = await walkFiles(root, 20_000);
      matched = all.filter((file) => {
        const relative = path.relative(root, file).split(path.sep).join("/");
        return matcher.test(relative) || matcher.test(path.basename(file));
      });
    }
    if (matched.length === 0) {
      return { content: `No files matched "${pattern}" under ${root}.` };
    }

    const withTimes = await Promise.all(
      matched.slice(0, MAX_RESULTS).map(async (file) => {
        try {
          return { file, mtime: (await stat(file)).mtimeMs };
        } catch {
          return { file, mtime: 0 };
        }
      }),
    );
    withTimes.sort((a, b) => b.mtime - a.mtime);
    const rendered = withTimes
      .map((entry) => displayPath(entry.file, ctx.cwd))
      .join("\n");
    const suffix =
      matched.length > MAX_RESULTS
        ? `\n\n[showing first ${MAX_RESULTS} of ${matched.length} matches]`
        : "";
    return { content: rendered + suffix };
  },
};

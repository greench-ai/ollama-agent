import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Tool, ToolResult } from "../core/types.ts";
import {
  assertWithinRoot,
  displayPath,
  globToRegExp,
  optionalNumber,
  optionalString,
  requireString,
  truncate,
  walkFiles,
} from "./shared.ts";

type OutputMode = "content" | "files_with_matches" | "count";

interface GrepConfig {
  pattern: string;
  target: string;
  mode: OutputMode;
  glob?: string;
  type?: string;
  caseInsensitive: boolean;
  lineNumbers: boolean;
  after?: number;
  before?: number;
  around?: number;
  multiline: boolean;
}

interface RgOutput {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnFailed: boolean;
}

function runRg(config: GrepConfig, cwd: string): Promise<RgOutput> {
  const args = ["--color", "never", "--no-heading"];
  if (config.mode === "files_with_matches") args.push("-l");
  if (config.mode === "count") args.push("-c");
  if (config.mode === "content" && config.lineNumbers) args.push("--line-number");
  if (config.caseInsensitive) args.push("-i");
  if (config.around !== undefined) args.push("-C", String(config.around));
  if (config.after !== undefined) args.push("-A", String(config.after));
  if (config.before !== undefined) args.push("-B", String(config.before));
  if (config.multiline) args.push("-U", "--multiline-dotall");
  if (config.glob) args.push("--glob", config.glob);
  if (config.type) args.push("--type", config.type);
  args.push("--", config.pattern, config.target);

  return new Promise((resolve) => {
    const child = spawn("rg", args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 8_000_000) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) =>
      resolve({ code: null, stdout: "", stderr: String(error), spawnFailed: true }),
    );
    child.on("close", (code) =>
      resolve({ code, stdout, stderr, spawnFailed: false }),
    );
  });
}

/**
 * Pure-JS fallback used when ripgrep is not installed as a real binary
 * (some environments only expose a shell function). Covers the common cases:
 * literal/regex patterns, glob filter, case folding, context lines, and the
 * three output modes. Multiline matching is approximated.
 */
async function fallbackGrep(config: GrepConfig, cwd: string): Promise<string> {
  const isFile = (await stat(config.target).catch(() => undefined))?.isFile() ?? false;
  const root = isFile ? path.dirname(config.target) : config.target;
  const files = isFile
    ? [config.target]
    : await walkFiles(config.target, 20_000);
  const globMatcher = config.glob ? globToRegExp(config.glob) : undefined;
  const flags = `${config.caseInsensitive ? "i" : ""}${config.multiline ? "s" : ""}`;
  let regex: RegExp;
  try {
    regex = new RegExp(config.pattern, flags);
  } catch (error) {
    throw new Error(`Invalid pattern: ${error instanceof Error ? error.message : error}`);
  }

  const out: string[] = [];
  for (const file of files) {
    if (globMatcher) {
      const relative = path.relative(root, file).split(path.sep).join("/");
      if (!globMatcher.test(relative) && !globMatcher.test(path.basename(file))) {
        continue;
      }
    }
    let text: string;
    try {
      const info = await stat(file);
      if (info.size > 2_000_000) continue;
      const buffer = await readFile(file);
      if (buffer.includes(0)) continue;
      text = buffer.toString("utf8");
    } catch {
      continue;
    }

    const relative = displayPath(file, cwd);
    if (config.mode === "files_with_matches") {
      if (regex.test(text)) out.push(relative);
      continue;
    }

    const lines = text.split("\n");
    const matchLines: number[] = [];
    if (config.multiline && !config.lineNumbers) {
      const match = regex.exec(text);
      if (match) {
        matchLines.push(text.slice(0, match.index).split("\n").length - 1);
      }
    } else {
      for (const [index, line] of lines.entries()) {
        regex.lastIndex = 0;
        if (regex.test(line)) matchLines.push(index);
      }
    }
    if (matchLines.length === 0) continue;

    if (config.mode === "count") {
      out.push(`${relative}:${matchLines.length}`);
      continue;
    }

    const context = config.around ?? 0;
    const before = config.before ?? context;
    const after = config.after ?? context;
    const include = new Set<number>();
    for (const index of matchLines) {
      for (let i = Math.max(0, index - before); i <= Math.min(lines.length - 1, index + after); i += 1) {
        include.add(i);
      }
    }
    for (const index of [...include].sort((a, b) => a - b)) {
      const isMatch = matchLines.includes(index);
      const separator = isMatch ? ":" : "-";
      const line = lines[index].length > 2000 ? `${lines[index].slice(0, 2000)}…` : lines[index];
      out.push(`${relative}${separator}${index + 1}${separator}${line}`);
    }
  }
  return out.join("\n");
}

export const grepTool: Tool = {
  name: "Grep",
  description:
    "Search file contents with ripgrep (with a built-in fallback). Supports " +
    "full regex syntax, glob and type filters, context lines, and three " +
    "output modes: matching content, file paths, or match counts. Prefer this " +
    "over running grep in Bash.",
  mutating: false,
  inputSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "The regular expression pattern to search for.",
      },
      path: {
        type: "string",
        description: "File or directory to search. Defaults to the working directory.",
      },
      glob: {
        type: "string",
        description: 'Glob filter, e.g. "*.js" or "*.{ts,tsx}".',
      },
      type: {
        type: "string",
        description: 'ripgrep file type, e.g. "js", "py", "rust".',
      },
      output_mode: {
        type: "string",
        enum: ["content", "files_with_matches", "count"],
        description: 'Output mode; defaults to "files_with_matches".',
      },
      "-i": { type: "boolean", description: "Case-insensitive search." },
      "-n": {
        type: "boolean",
        description: "Show line numbers (content mode; default true).",
      },
      "-A": { type: "integer", description: "Lines of trailing context." },
      "-B": { type: "integer", description: "Lines of leading context." },
      "-C": { type: "integer", description: "Lines of context around matches." },
      multiline: {
        type: "boolean",
        description: "Allow patterns to match across lines.",
      },
      head_limit: {
        type: "integer",
        description: "Maximum output lines or entries (default 250).",
      },
      offset: {
        type: "integer",
        description: "Skip the first N output entries.",
      },
    },
    required: ["pattern"],
  },

  async run(input, ctx): Promise<ToolResult> {
    const pattern = requireString(input, "pattern");
    const mode =
      (optionalString(input, "output_mode") as OutputMode | undefined) ??
      "files_with_matches";
    const target = optionalString(input, "path")
      ? path.resolve(ctx.cwd, optionalString(input, "path") as string)
      : ctx.cwd;
    await assertWithinRoot(target, ctx.allowedRoot);

    const config: GrepConfig = {
      pattern,
      target,
      mode,
      glob: optionalString(input, "glob"),
      type: optionalString(input, "type"),
      caseInsensitive: input["-i"] === true,
      lineNumbers: input["-n"] !== false,
      after: optionalNumber(input, "-A"),
      before: optionalNumber(input, "-B"),
      around: optionalNumber(input, "-C"),
      multiline: input.multiline === true,
    };

    const rgOutput = await runRg(config, ctx.cwd);
    let stdout = rgOutput.stdout;
    let code = rgOutput.code;

    if (rgOutput.spawnFailed) {
      if (ctx.log) ctx.log("ripgrep binary not found; using the built-in search fallback.");
      stdout = await fallbackGrep(config, ctx.cwd);
      code = stdout ? 0 : 1;
    }

    if (code === 1) return { content: `No matches for "${pattern}".` };
    if (code !== 0) {
      return {
        content: `Search failed (exit ${code}): ${truncate(rgOutput.stderr || stdout, 2000)}`,
        isError: true,
      };
    }

    const headLimit = Math.max(1, Math.floor(optionalNumber(input, "head_limit") ?? 250));
    const offset = Math.max(0, Math.floor(optionalNumber(input, "offset") ?? 0));
    const lines = stdout.split("\n").filter((line) => line.length > 0);
    const slice = lines.slice(offset, offset + headLimit);
    const suffix =
      lines.length > offset + slice.length
        ? `\n\n[${lines.length - offset - slice.length} more; use offset=${offset + slice.length}]`
        : "";
    return { content: slice.join("\n") + suffix };
  },
};

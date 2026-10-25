import { spawn } from "node:child_process";
import type { Tool, ToolResult } from "../core/types.ts";
import { optionalNumber, optionalString, requireString, truncate } from "./shared.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_CAPTURE = 1_000_000;

interface ProcessOutput {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<ProcessOutput> {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const child = spawn("/bin/bash", ["-lc", command], {
      cwd,
      env: process.env,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_CAPTURE) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_CAPTURE) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr, timedOut });
    });
    child.on("timeout", () => {
      timedOut = true;
    });
  });
}

export const bashTool: Tool = {
  name: "Bash",
  description:
    "Execute a shell command in the working directory and return its output. " +
    "The working directory is fixed for the session; shell state (variables, " +
    "cd) does not persist between calls. Prefer Read/Grep/Glob over shell " +
    "equivalents. Commands that mutate files require approval.",
  mutating: true,
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command to execute." },
      timeout: {
        type: "integer",
        description: `Optional timeout in milliseconds (max ${MAX_TIMEOUT_MS}).`,
      },
      description: {
        type: "string",
        description: "Short description of what the command does.",
      },
    },
    required: ["command"],
  },

  async run(input, ctx): Promise<ToolResult> {
    const command = requireString(input, "command");
    const requested = optionalNumber(input, "timeout") ?? DEFAULT_TIMEOUT_MS;
    const timeout = Math.min(Math.max(1_000, requested), MAX_TIMEOUT_MS);

    const result = await runCommand(command, ctx.cwd, timeout);
    const sections: string[] = [];
    if (result.timedOut) {
      sections.push(`Command timed out after ${timeout}ms and was killed.`);
    }
    sections.push(`exit code: ${result.code ?? "signal " + (result.signal ?? "unknown")}`);
    if (result.stdout.trim()) sections.push(`stdout:\n${truncate(result.stdout, 40_000)}`);
    if (result.stderr.trim()) sections.push(`stderr:\n${truncate(result.stderr, 20_000)}`);
    if (!result.stdout.trim() && !result.stderr.trim()) sections.push("(no output)");
    void optionalString(input, "description");

    return {
      content: sections.join("\n"),
      isError: result.timedOut || (result.code !== null && result.code !== 0),
    };
  },
};

import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { agentHome } from "./session.ts";

export interface TelemetryRun {
  id: string;
  at: string;
  sessionId: string;
  agentName: string;
  model: string;
  cwd: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  turns: number;
  tools: Record<string, number>;
  inputTokens: number;
  outputTokens: number;
  compactions: number;
  toolErrors: number;
  stopReason: string;
  error?: string;
}

export interface TelemetrySummary {
  runs: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  toolErrors: number;
  compactions: number;
  durationMs: number;
  tools: Record<string, number>;
}

export class TelemetryStore {
  readonly file: string;

  constructor(sessionId: string, home = agentHome()) {
    this.file = path.join(home, "telemetry", `${sessionId}.jsonl`);
  }

  async record(run: TelemetryRun): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await appendFile(this.file, `${JSON.stringify(run)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  async list(limit = 50): Promise<TelemetryRun[]> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch {
      return [];
    }
    const runs: TelemetryRun[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        runs.push(JSON.parse(line) as TelemetryRun);
      } catch {
        // Skip a corrupt line.
      }
    }
    if (limit <= 0) return [];
    return runs.slice(-limit);
  }

  async summary(limit = 200): Promise<TelemetrySummary> {
    const runs = await this.list(limit);
    const summary: TelemetrySummary = {
      runs: runs.length,
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
      toolErrors: 0,
      compactions: 0,
      durationMs: 0,
      tools: {},
    };
    for (const run of runs) {
      summary.turns += run.turns;
      summary.inputTokens += run.inputTokens;
      summary.outputTokens += run.outputTokens;
      summary.toolErrors += run.toolErrors;
      summary.compactions += run.compactions;
      summary.durationMs += run.durationMs;
      for (const [tool, count] of Object.entries(run.tools ?? {})) {
        summary.tools[tool] = (summary.tools[tool] ?? 0) + count;
        summary.toolCalls += count;
      }
    }
    return summary;
  }
}

export function newTelemetryRun(input: {
  sessionId: string;
  agentName: string;
  model: string;
  cwd: string;
  startedAt: number;
  endedAt: number;
  turns: number;
  tools: Record<string, number>;
  inputTokens: number;
  outputTokens: number;
  compactions: number;
  toolErrors: number;
  stopReason: string;
  error?: string;
}): TelemetryRun {
  return {
    id: `run-${Date.now()}-${randomUUID().slice(0, 4)}`,
    at: new Date().toISOString(),
    sessionId: input.sessionId,
    agentName: input.agentName,
    model: input.model,
    cwd: input.cwd,
    startedAt: new Date(input.startedAt).toISOString(),
    endedAt: new Date(input.endedAt).toISOString(),
    durationMs: Math.max(0, input.endedAt - input.startedAt),
    turns: input.turns,
    tools: { ...input.tools },
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    compactions: input.compactions,
    toolErrors: input.toolErrors,
    stopReason: input.stopReason,
    error: input.error,
  };
}

export function formatTelemetry(run: TelemetryRun): string {
  const tools = Object.entries(run.tools)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name}×${count}`)
    .join(", ");
  return [
    `${run.at} ${run.agentName} ${run.model}`,
    `  ${run.turns} turn(s), ${run.inputTokens} in / ${run.outputTokens} out, ${run.durationMs}ms, ${run.stopReason}`,
    tools ? `  tools: ${tools}` : "",
    run.error ? `  error: ${run.error}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

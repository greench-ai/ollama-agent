import type { AgentEvent } from "../core/agent.ts";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

function paint(code: string, text: string): string {
  return useColor ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export const style = {
  dim: (text: string) => paint("2", text),
  bold: (text: string) => paint("1", text),
  red: (text: string) => paint("31", text),
  green: (text: string) => paint("32", text),
  yellow: (text: string) => paint("33", text),
  blue: (text: string) => paint("34", text),
  magenta: (text: string) => paint("35", text),
  cyan: (text: string) => paint("36", text),
};

function preview(text: string, lines = 6, width = 160): string {
  const slice = text.split("\n").slice(0, lines);
  const clipped = slice.map((line) =>
    line.length > width ? `${line.slice(0, width)}…` : line,
  );
  const more = text.split("\n").length > lines;
  return `${clipped.join("\n")}${more ? "\n…" : ""}`;
}

export class TerminalRenderer {
  private showThinking: boolean;
  private lineOpen = false;
  private turnHasContent = false;

  constructor(options: { showThinking?: boolean } = {}) {
    this.showThinking = options.showThinking ?? true;
  }

  setShowThinking(value: boolean): void {
    this.showThinking = value;
  }

  private ensureNewline(): void {
    if (this.lineOpen) {
      process.stdout.write("\n");
      this.lineOpen = false;
    }
  }

  handle(event: AgentEvent): void {
    switch (event.type) {
      case "text":
        process.stdout.write(event.text);
        this.lineOpen = !event.text.endsWith("\n");
        this.turnHasContent = true;
        break;

      case "thinking":
        if (!this.showThinking) break;
        this.ensureNewline();
        process.stdout.write(style.dim(event.text));
        this.lineOpen = !event.text.endsWith("\n");
        break;

      case "tool_start": {
        this.ensureNewline();
        const label = style.bold(event.name);
        const summary = event.summary ? ` ${style.dim(event.summary)}` : "";
        process.stdout.write(`${style.green("●")} ${label}${summary}\n`);
        this.turnHasContent = true;
        break;
      }

      case "tool_end": {
        this.ensureNewline();
        const body = preview(event.content, event.isError ? 8 : 4);
        const indent = body
          .split("\n")
          .map((line) => `  ${line}`)
          .join("\n");
        process.stdout.write(
          `${event.isError ? style.red("✗") : style.dim("│")}\n${style.dim(indent)}\n`,
        );
        break;
      }

      case "notice":
        this.ensureNewline();
        process.stdout.write(`${style.yellow("•")} ${style.dim(event.text)}\n`);
        break;

      case "subagent_start":
        this.ensureNewline();
        process.stdout.write(
          `${style.magenta("◎")} ${style.bold(event.name)} ` +
            `${style.dim(`(${event.subagentType})`)} ${event.description}\n`,
        );
        break;

      case "subagent_end":
        this.ensureNewline();
        process.stdout.write(
          `${event.ok ? style.magenta("◎") : style.red("◎")} ${style.bold(event.name)} ` +
            `${style.dim(event.ok ? "done" : "failed")}\n`,
        );
        break;

      case "error":
        this.ensureNewline();
        process.stdout.write(`${style.red("✗")} ${event.message}\n`);
        break;

      case "usage":
        break;

      case "turn_end":
        this.ensureNewline();
        break;
    }
  }

  endTurn(context?: { used: number; budget: number }): void {
    if (context) {
      const percent = Math.round((context.used / context.budget) * 100);
      process.stdout.write(
        style.dim(`  — context ~${context.used} / ${context.budget} tokens (${percent}%)\n`),
      );
    }
    this.turnHasContent = false;
  }
}

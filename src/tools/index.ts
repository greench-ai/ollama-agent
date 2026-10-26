import type { Tool } from "../core/types.ts";
import { readTool } from "./read.ts";
import { writeTool, multiEditTool } from "./write.ts";
import { editTool } from "./edit.ts";
import { bashTool } from "./bash.ts";
import { globTool } from "./glob.ts";
import { grepTool } from "./grep.ts";
import { todoTool } from "./todo.ts";
import { taskTool } from "./task.ts";
import { exitPlanModeTool } from "./exit-plan.ts";
import { teamTools } from "./team.ts";

export const allTools: Tool[] = [
  readTool,
  writeTool,
  editTool,
  multiEditTool,
  bashTool,
  globTool,
  grepTool,
  todoTool,
  taskTool,
  exitPlanModeTool,
  ...teamTools,
];

export function getTool(name: string): Tool | undefined {
  return allTools.find((tool) => tool.name === name);
}

export {
  readTool,
  writeTool,
  editTool,
  multiEditTool,
  bashTool,
  globTool,
  grepTool,
  todoTool,
  taskTool,
  exitPlanModeTool,
  teamTools,
};

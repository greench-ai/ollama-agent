import type { Tool, ToolResult, TodoItem } from "../core/types.ts";

const STATUSES = new Set(["pending", "in_progress", "completed"]);

function render(todos: TodoItem[]): string {
  if (todos.length === 0) return "(todo list is empty)";
  return todos
    .map((todo) => {
      const mark =
        todo.status === "completed" ? "[x]" : todo.status === "in_progress" ? "[~]" : "[ ]";
      return `${mark} ${todo.content}`;
    })
    .join("\n");
}

export const todoTool: Tool = {
  name: "TodoWrite",
  description:
    "Replace the session todo list. Use it to track multi-step work: keep at " +
    "least one item in_progress while working, and mark items completed as " +
    "soon as they are done.",
  mutating: false,
  inputSchema: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: "Imperative description of the task.",
            },
            activeForm: {
              type: "string",
              description: "Present-continuous description, e.g. \"Running tests\".",
            },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed"],
            },
          },
          required: ["content", "status", "activeForm"],
        },
      },
    },
    required: ["todos"],
  },

  async run(input, ctx): Promise<ToolResult> {
    const raw = input.todos;
    if (!Array.isArray(raw)) throw new Error('"todos" must be an array.');

    const todos: TodoItem[] = raw.map((item, index) => {
      if (!item || typeof item !== "object") {
        throw new Error(`todos[${index}] must be an object.`);
      }
      const record = item as Record<string, unknown>;
      const content = typeof record.content === "string" ? record.content.trim() : "";
      const activeForm =
        typeof record.activeForm === "string" && record.activeForm.trim()
          ? record.activeForm.trim()
          : content;
      const status = String(record.status ?? "");
      if (!content) throw new Error(`todos[${index}].content is required.`);
      if (!STATUSES.has(status)) {
        throw new Error(
          `todos[${index}].status must be pending, in_progress, or completed.`,
        );
      }
      return {
        content,
        activeForm,
        status: status as TodoItem["status"],
      };
    });

    ctx.todos.splice(0, ctx.todos.length, ...todos);
    return { content: render(ctx.todos) };
  },
};

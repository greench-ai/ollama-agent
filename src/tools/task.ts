import type { Tool, ToolResult } from "../core/types.ts";
import { optionalString, requireString } from "./shared.ts";

const TYPES = ["general-purpose", "explore", "plan"] as const;

export const taskTool: Tool = {
  name: "Task",
  description:
    "Launch a subagent to handle a self-contained, multi-step task in an " +
    "isolated context and return its final report. Use it for broad searches, " +
    "reviews, or investigations that would flood the main conversation with " +
    "intermediate output. The subagent cannot see this conversation, so the " +
    "prompt must be complete. Use \"explore\" or \"plan\" for read-only work. " +
    "Do not use it for a single file read or one command.",
  mutating: false,
  inputSchema: {
    type: "object",
    properties: {
      description: {
        type: "string",
        description: "Short (3-5 word) description of the delegated task.",
      },
      prompt: {
        type: "string",
        description:
          "Complete task for the subagent: goal, relevant paths, and what to report.",
      },
      subagent_type: {
        type: "string",
        enum: [...TYPES],
        description:
          "general-purpose (all tools), explore (read-only), or plan (read-only).",
      },
      model: {
        type: "string",
        description: "Optional model override for the subagent.",
      },
      name: {
        type: "string",
        description: "Short name used in progress messages, e.g. \"explorer\".",
      },
    },
    required: ["description", "prompt"],
  },

  async run(input, ctx): Promise<ToolResult> {
    if (!ctx.spawnSubagent) {
      return {
        content: "Subagents are not available in this context.",
        isError: true,
      };
    }

    const description = requireString(input, "description");
    const prompt = requireString(input, "prompt");
    const type = optionalString(input, "subagent_type") ?? "general-purpose";
    if (!(TYPES as readonly string[]).includes(type)) {
      throw new Error(
        `subagent_type must be one of: ${TYPES.join(", ")} (got "${type}").`,
      );
    }

    const result = await ctx.spawnSubagent({
      description,
      prompt,
      subagentType: type as (typeof TYPES)[number],
      model: optionalString(input, "model"),
      name: optionalString(input, "name"),
    });

    const label = optionalString(input, "name") ?? type;
    return {
      content: `Subagent report (${label}):\n${result.content}`,
      isError: result.isError ?? false,
    };
  },
};

import type { Tool, ToolResult } from "../core/types.ts";
import { requireString } from "./shared.ts";

export const exitPlanModeTool: Tool = {
  name: "ExitPlanMode",
  description:
    "Available only in plan mode. Present a concrete implementation plan for " +
    "the user to approve. On approval the session switches out of read-only " +
    "plan mode and you may start editing. Include the files you will change, " +
    "the approach, and how you will verify it. Do not call this before the " +
    "plan is specific enough to act on.",
  mutating: false,
  inputSchema: {
    type: "object",
    properties: {
      plan: {
        type: "string",
        description:
          "Markdown plan: goal, files to change, steps, and verification.",
      },
    },
    required: ["plan"],
  },

  async run(input, ctx): Promise<ToolResult> {
    const plan = requireString(input, "plan");
    if (!ctx.requestPlanApproval) {
      return {
        content: "Plan approval is not available in this context.",
        isError: true,
      };
    }

    const result = await ctx.requestPlanApproval(plan);
    if (result.approved) {
      return {
        content:
          "Plan approved. You may now make changes. Start with the first step " +
          "and keep the user informed.",
      };
    }
    return {
      content:
        "Plan rejected." +
        (result.feedback ? ` User feedback: ${result.feedback}` : "") +
        " Continue investigating and revise the plan.",
    };
  },
};

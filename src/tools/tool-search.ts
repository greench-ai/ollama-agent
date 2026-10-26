import type { Tool, ToolResult } from "../core/types.ts";
import { optionalNumber, requireString } from "./shared.ts";

export const toolSearchTool: Tool = {
  name: "ToolSearch",
  description:
    "Load the schemas of deferred tools (usually MCP tools) by keyword. " +
    "Call this before using a tool that is listed under Deferred tools but not " +
    "in your current tool set. Loaded tools become callable on the next turn.",
  mutating: false,
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Tool name, server, or keyword describing what you need.",
      },
      limit: {
        type: "integer",
        description: "Maximum number of tools to load (default 5, max 10).",
      },
    },
    required: ["query"],
  },
  async run(input, ctx): Promise<ToolResult> {
    const query = requireString(input, "query");
    if (!ctx.toolSearch) {
      return {
        content: "No deferred tools are available in this context.",
        isError: true,
      };
    }
    const limit = optionalNumber(input, "limit");
    const result = await ctx.toolSearch.search(query, limit);
    return { content: result.content, isError: result.loaded.length === 0 };
  },
};

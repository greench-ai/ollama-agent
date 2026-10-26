import type { Tool, ToolResult } from "../core/types.ts";
import { optionalString, requireString } from "./shared.ts";

export const skillTool: Tool = {
  name: "Skill",
  description:
    "Load one of the available skills by name. Returns the full SKILL.md " +
    "instructions and the skill's resource files. Call this before following a " +
    "skill; do not guess its contents.",
  mutating: false,
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Skill name from the catalog." },
      args: {
        type: "string",
        description: "Optional arguments substituted for $ARGUMENTS.",
      },
    },
    required: ["name"],
  },
  async run(input, ctx): Promise<ToolResult> {
    const name = requireString(input, "name");
    const skills = ctx.skills;
    if (!skills || skills.size === 0) {
      return {
        content: "No skills are loaded. Add SKILL.md directories under ~/.config/ollama-agent/skills or the project's .ollama-agent/skills.",
        isError: true,
      };
    }
    const skill = skills.get(name);
    if (!skill) {
      const available = [...skills.keys()].sort().join(", ");
      return {
        content: `Unknown skill "${name}". Available: ${available}.`,
        isError: true,
      };
    }
    const args = optionalString(input, "args");
    let body = skill.body;
    if (args) {
      body = body.includes("$ARGUMENTS")
        ? body.split("$ARGUMENTS").join(args)
        : `${body}\n\nArguments: ${args}`;
    }
    const files = skill.files.length > 0 ? skill.files.join("\n") : "(none)";
    return {
      content: `# Skill: ${skill.name}\n\n${body}\n\nSkill root: ${skill.root}\nFiles:\n${files}`,
    };
  },
};

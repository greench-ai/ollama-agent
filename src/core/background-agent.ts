import { Agent, type AgentEvent } from "./agent.ts";
import type { AgentDefinition } from "./agent-definitions.ts";
import type { HooksEngine } from "./hooks.ts";
import { PermissionEngine, type PermissionMode } from "./permissions.ts";
import { Session } from "./session.ts";
import type { SkillDefinition } from "./skills.ts";
import type { Provider, Tool } from "./types.ts";

export interface BackgroundAgentOptions {
  provider: Provider;
  tools: Tool[];
  system: string;
  cwd: string;
  model: string;
  mode: PermissionMode;
  agentDefinitions: Map<string, AgentDefinition>;
  skills?: Map<string, SkillDefinition>;
  hooks?: HooksEngine;
  numCtx?: number;
  temperature?: number;
  onEvent?: (event: AgentEvent) => void;
}

/**
 * Build an independent agent for a background job. It cannot ask the user for
 * permission, so mutating tools are denied unless the job's mode already grants
 * them (acceptEdits, bypassPermissions).
 */
export async function createBackgroundAgent(
  options: BackgroundAgentOptions,
): Promise<{ agent: Agent; session: Session }> {
  const session = await Session.create({
    cwd: options.cwd,
    model: options.model,
  });
  const permissions = new PermissionEngine(options.mode, async () => "deny");
  const agent = new Agent({
    provider: options.provider,
    model: options.model,
    tools: options.tools,
    permissions,
    session,
    cwd: options.cwd,
    system: options.system,
    think: false,
    numCtx: options.numCtx,
    temperature: options.temperature,
    maxTurns: 20,
    agentDefinitions: options.agentDefinitions,
    skills: options.skills,
    hooks: options.hooks,
    teamsEnabled: false,
    onEvent: options.onEvent,
  });
  return { agent, session };
}

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Agent } from "../src/core/agent.ts";
import { PermissionEngine } from "../src/core/permissions.ts";
import { Session } from "../src/core/session.ts";
import type {
  ChatRequest,
  Provider,
  ProviderEvent,
  Tool,
} from "../src/core/types.ts";
import { allTools } from "../src/tools/index.ts";

type Step = (request: ChatRequest, call: number) => ProviderEvent[];

class ScriptedProvider implements Provider {
  readonly name = "scripted-eval";
  calls: ChatRequest[] = [];
  private steps: Step[];

  constructor(steps: Step[]) {
    this.steps = steps;
  }

  async *chat(request: ChatRequest): AsyncGenerator<ProviderEvent> {
    this.calls.push({ ...request, messages: structuredClone(request.messages) });
    const step = this.steps[this.calls.length - 1];
    const events = step
      ? step(request, this.calls.length)
      : [
          { type: "text" as const, text: "done" },
          { type: "done" as const, stopReason: "end_turn" },
        ];
    for (const event of events) yield event;
  }

  async listModels() {
    return [{ name: "scripted" }];
  }
}

function mcpTool(name: string): Tool {
  return {
    name: `eval__${name}`,
    description: `Eval tool ${name}`,
    inputSchema: { type: "object", properties: {} },
    mutating: false,
    async run() {
      return { content: `eval-ok:${name}` };
    },
  };
}

interface Scenario {
  name: string;
  tools?: Tool[];
  threshold?: number;
  steps: Step[];
  setup: (cwd: string) => Promise<void>;
  verify: (agent: Agent, cwd: string) => Promise<void>;
}

const scenarios: Scenario[] = [
  {
    name: "read-tool-loop",
    setup: async (cwd) => {
      await writeFile(path.join(cwd, "note.txt"), "alpha\n", "utf8");
    },
    steps: [
      () => [
        {
          type: "tool_call",
          call: { id: "read-1", name: "Read", input: { file_path: "" } },
        },
        { type: "done", stopReason: "tool_use" },
      ],
      () => [
        { type: "text", text: "read complete" },
        { type: "done", stopReason: "end_turn" },
      ],
    ],
    verify: async (agent) => {
      const blocks = agent.messages.flatMap((message) => message.content);
      const result = blocks.find(
        (block) => block.type === "tool_result" && block.name === "Read",
      );
      if (!result || result.type !== "tool_result" || !result.content.includes("alpha")) {
        throw new Error("Read tool result did not include the file content.");
      }
    },
  },
  {
    name: "edit-and-checkpoint",
    setup: async (cwd) => {
      await writeFile(path.join(cwd, "edit.txt"), "before\n", "utf8");
    },
    steps: [
      () => [
        {
          type: "tool_call",
          call: {
            id: "edit-1",
            name: "Edit",
            input: {
              file_path: path.join(process.cwd(), "edit.txt"),
              old_string: "before",
              new_string: "after",
            },
          },
        },
        { type: "done", stopReason: "tool_use" },
      ],
      () => [
        { type: "text", text: "edit complete" },
        { type: "done", stopReason: "end_turn" },
      ],
    ],
    verify: async (agent, cwd) => {
      if ((await readFile(path.join(cwd, "edit.txt"), "utf8")) !== "after\n") {
        throw new Error("Edit did not update the file.");
      }
      const checkpoints = await agent.checkpoints!.list();
      if (checkpoints.length !== 1) throw new Error("Expected one checkpoint.");
      await agent.checkpoints!.restore(checkpoints[0]!.id);
      if ((await readFile(path.join(cwd, "edit.txt"), "utf8")) !== "before\n") {
        throw new Error("Checkpoint restore did not restore the original file.");
      }
    },
  },
  {
    name: "deferred-tool-search",
    tools: [...allTools, mcpTool("alpha"), mcpTool("beta"), mcpTool("gamma")],
    threshold: 5,
    setup: async () => {},
    steps: [
      () => [
        {
          type: "tool_call",
          call: { id: "search-1", name: "ToolSearch", input: { query: "alpha" } },
        },
        { type: "done", stopReason: "tool_use" },
      ],
      () => [
        {
          type: "tool_call",
          call: { id: "alpha-1", name: "eval__alpha", input: {} },
        },
        { type: "done", stopReason: "tool_use" },
      ],
      () => [
        { type: "text", text: "tool search complete" },
        { type: "done", stopReason: "end_turn" },
      ],
    ],
    verify: async (agent) => {
      const blocks = agent.messages.flatMap((message) => message.content);
      const result = blocks.find(
        (block) => block.type === "tool_result" && block.name === "eval__alpha",
      );
      if (!result || result.type !== "tool_result" || !result.content.includes("eval-ok:alpha")) {
        throw new Error("Deferred tool was not loaded or called.");
      }
    },
  },
];

async function runScenario(scenario: Scenario): Promise<void> {
  const home = await mkdtemp(path.join(tmpdir(), "agent-eval-home-"));
  process.env.OLLAMA_AGENT_HOME = home;
  const cwd = await mkdtemp(path.join(tmpdir(), "agent-eval-cwd-"));
  await scenario.setup(cwd);
  const provider = new ScriptedProvider(
    scenario.steps.map((step) => (request, call) => {
      // Fill in the file path after the cwd is known for path-based tools.
      return step(request, call).map((event) => {
        if (event.type === "tool_call" && event.call.name === "Read") {
          return {
            ...event,
            call: {
              ...event.call,
              input: { ...event.call.input, file_path: path.join(cwd, "note.txt") },
            },
          };
        }
        if (event.type === "tool_call" && event.call.name === "Edit") {
          return {
            ...event,
            call: {
              ...event.call,
              input: {
                ...event.call.input,
                file_path: path.join(cwd, "edit.txt"),
              },
            },
          };
        }
        return event;
      });
    }),
  );
  const session = await Session.create({ cwd, model: "scripted" });
  const agent = new Agent({
    provider,
    model: "scripted",
    tools: scenario.tools ?? allTools,
    permissions: new PermissionEngine("bypassPermissions"),
    session,
    cwd,
    system: "eval",
    teamsEnabled: false,
    toolSearchThreshold: scenario.threshold,
  });
  const started = Date.now();
  await agent.run("eval scenario");
  await scenario.verify(agent, cwd);
  const summary = await agent.telemetry!.summary();
  console.log(
    JSON.stringify({
      scenario: scenario.name,
      pass: true,
      durationMs: Date.now() - started,
      turns: summary.turns,
      toolCalls: summary.toolCalls,
      inputTokens: summary.inputTokens,
      outputTokens: summary.outputTokens,
    }),
  );
}

let failed = 0;
for (const scenario of scenarios) {
  try {
    await runScenario(scenario);
  } catch (error) {
    failed += 1;
    console.log(
      JSON.stringify({
        scenario: scenario.name,
        pass: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}
process.exit(failed === 0 ? 0 : 1);

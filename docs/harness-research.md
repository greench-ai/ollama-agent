# Agent Harnesses and Agent Teams — Research Brief for `ollama-agent`

Date: 2026-10-26
Scope: multi-agent orchestration and adjacent features worth adding to a local
Ollama coding client.

## 1. Executive summary

- Nine of the eleven production harnesses studied in the most detailed
  source-code survey (July 2026) support multi-agent execution, but they
  converge on **coordinator → workers**, not on autonomous swarms.
- Two levels are consistently distinguished:
  - **Subagents**: child context, result returned to the caller, no shared
    state. Cheap, predictable, already implemented here.
  - **Teams**: peers with a shared task board, mailboxes, direct messaging,
    persistent state, and often independent worktrees. Expensive, coordination
    heavy, best for breadth-first work.
- The most complete commercial designs (Claude Code, Cline) converge on the
  same primitives: **lead + named teammates, shared task list with dependencies
  and atomic claiming, per-agent mailbox, outcome synthesis, persistent team
  state, inherited permissions, per-agent models**.
- Isolation is the hard part. Claude Code offers `isolation: worktree` for
  subagents; parallel-agent practitioners split work by **contract, not by
  file**, and gate merges with a **trial merge + test run**, because git merges
  cleanly while semantics break.
- For `ollama-agent`, the highest-leverage additions are, in order:
  1. **Agent definitions** (Markdown + frontmatter) so roles are data, not code.
  2. **Team mode** (task board, mailbox, outcomes, lead tools) — opt-in.
  3. **Worktree isolation + serialized merge/test gate**.
  4. **Skills** (`SKILL.md`, progressive disclosure) — now the most-adopted
     extension standard (9/11 vs. MCP 8/11).
  5. **Checkpoints/rewind** and **model-aware fuzzy edits**, which matter more
     for local models than for frontier APIs.
  6. **Hooks/policy-as-code**, **deferred tool loading**, **ACP server**,
     **background/scheduled agents**.
- Recommendation: build teams as an **opt-in "team mode"** that composes with
  today's subagents, not a replacement. Default to a single agent. Add agent
  definitions first, then the team core, then worktrees and integration gates.

## 2. Method and sources

Primary evidence:

- *Harness Engineering: Anatomy, Architecture, and Evolution of Coding Agents —
  A Source-Code Study of Eleven Systems* (arXiv 2609.00006, 2026). A source-code
  anatomy of Claude Code, Codex CLI, Gemini CLI, Mistral Vibe, OpenHands, Aider,
  Mini-SWE-Agent, Hermes, Pi, OpenCode, OpenClaw, plus Omnigent as a
  meta-harness. This is the strongest structural source; it is descriptive, not
  a benchmark.
- Official documentation: Claude Code (agent teams, agents overview, subagents,
  hooks, checkpointing), Cline (multi-agent teams, subagents, scheduled agents),
  OpenCode (agents), Goose (subrecipes), Aider (architect/editor), OpenHands SDK
  papers and examples, Zed's ACP progress report.
- Practitioner writing on parallel agents in git worktrees and merge failures.
- Secondary comparison articles (Kendr, Graham Miranda) were read for context
  but not relied on for architectural claims, since some are vendor-scored or
  date-sensitive.

Caveats:

- Vendor docs describe intended behavior; the source-code study is a July-2026
  snapshot. Features move fast.
- Claude Code's analysis in the study draws on a March-2026 snapshot plus public
  docs; treat its internals as directional.
- The corpus is proprietary/closed in part; the patterns below are what the
  docs and source survey agree on.
- "Token cost" numbers from the literature are order-of-magnitude, not precise.

## 3. Landscape: six orchestration patterns

The study identifies six patterns across the corpus:

| Pattern | Systems | Shape |
| --- | --- | --- |
| 1. Single agent | Aider, Mini-SWE-Agent, Pi core | One loop; subagents only via extensions |
| 2. Sequential delegation | Mistral Vibe | Parent spawns one subagent and awaits it |
| 3. Parallel child sessions | OpenHands, OpenCode | Children run as separate conversations/sessions |
| 4. Hierarchical thread tree | Codex | Typed thread tree, fork modes, depth tracking, fan-out |
| 5. Recursive composition | Claude Code | Forked context, recursively composable agents, shared prompt cache |
| 6. Registry + protocol | Gemini CLI (A2A), OpenClaw (ACP), Hermes (SQLite Kanban swarm) | Named definitions behind a local/remote or process protocol |

Coordination primitives across the multi-agent systems:

| Concern | Common implementations |
| --- | --- |
| Isolation | Separate conversation + fresh context (all); worktree per agent (Claude `isolation: worktree`, Codex sandbox, Pi OS process) |
| Communication | Result return only (subagents); mailbox / message queue (Claude teams, Codex, Cline); SQLite blackboard (Hermes swarm); ACP/A2A (protocols) |
| Coordination | Parent-managed (subagents); shared task board with claim/dependencies (Claude teams, Cline); map-reduce fan-out (Codex CSV) |
| Depth | 1 hop default (Mistral, Hermes); recursive with guard (Claude, OpenHands); recursion off by default (OpenCode) |
| Tools | Whitelist/blacklist per definition; permission-derived (OpenCode); inherited ∩ parent (Hermes); 16-tool worker whitelist (Claude coordinator mode) |
| Persistence | Session-scoped (subagents); team DB / directories / task files (teams); resumes with the session |

Why teams are not the default: Claude's own docs warn that teams add
coordination overhead and "use significantly more tokens than a single
session", and work best when teammates can operate independently. The
literature the study cites puts multi-agent systems at roughly **15×** the
tokens of a chat baseline, and notes that most coding tasks have fewer truly
parallelizable parts than research tasks.

## 4. What the strongest harnesses actually do

### 4.1 Claude Code

**Subagents** are Markdown files with YAML frontmatter. Supported fields
include `description`, `tools`, `disallowedTools`, `model`, `permissionMode`,
`mcpServers`, `hooks`, `maxTurns`, `autoCompactWindow`, `skills`,
`initialPrompt`, `memory`, `effort`, `background`, `omitClaudeMd`, and
`isolation` (`worktree`). Only `name` and `description` are required. Scopes:
built-in → plugin → user → project → CLI/managed, with later scopes overriding.

- Context is forked along six dimensions (abort controller, file-state cache,
  permission prompts, app state, denial tracking, tool decisions). The rendered
  system prompt is frozen at fork time to preserve prompt-cache hits.
- Recursive composition is allowed; coordinator mode restricts workers to a
  16-tool whitelist and follows Research → Synthesis → Implementation →
  Verification.
- `isolation: worktree` runs the subagent's shell and edits in a temporary git
  worktree, with path checks to keep commands from escaping into the main
  checkout.

**Agent teams** are experimental and disabled by default:

- One session is the lead; teammates are full, independent sessions with their
  own context windows.
- A **shared task list** holds pending / in_progress / completed tasks with
  dependencies; claiming uses file locking; tasks unblock automatically.
- A **mailbox** per agent (`~/.claude/teams/{team}/inboxes/{agent}.json`) carries
  plain messages and structured protocol messages (plan approval, shutdown).
  Messages are validated on read; writes must succeed for delivery.
- Teammates can message each other directly, and the user can open any
  teammate's transcript and type to it. Display modes: in-process panel or
  split panes (tmux/iTerm2).
- Teammates start with the lead's permission mode; the lead session shows their
  prompts. A teammate cannot approve for the user or relay a denial.
- Plan-mode teammates send a plan approval request to the lead; the lead can
  approve or send it back.
- Models are chosen per teammate (spawn parameter → definition → inherited),
  with per-teammate effort.
- Team/task directories persist; tasks survive the session, team config is
  runtime state.
- Hooks include `TeammateIdle`, `TaskCreated`, `TaskCompleted`, and `SubagentStop`.

**Checkpointing**: every turn snapshots files touched by edit tools; 100
checkpoints per session; `/rewind` can restore code and/or conversation, or
summarize from/to a point. This is a strong safety net for agent edits.

**Hooks**: lifecycle events include `SessionStart`, `UserPromptSubmit`,
`PreToolUse` (can block), `PostToolUse`, `PostToolUseFailure`, `Notification`,
`SubagentStop`, `TaskCreated`, `TaskCompleted`, `Stop`, `StopFailure`,
`TeammateIdle`, `PreCompact`, `SessionEnd`.

### 4.2 Cline

- **Subagents**: `spawn_agent`; own context; report back; subagents can spawn
  subagents; no MCP tools; mode-based tool restrictions.
- **Teams**: coordinator + specialists; a shared task board; mailbox; mission
  log; runs (`team_run_task`, `team_await_runs`, cancel); outcomes
  (`team_create_outcome`, attach/review fragments, finalize); cleanup. Only the
  coordinator can spawn or shut down teammates.
- Team state (task board, mailbox, mission log, outcomes, teammates) is stored
  in `~/.cline/data/db/teams.db` under the session id, and is restored when the
  session resumes. Teams are explicitly for work resumed over days; subagents
  are for one-off delegation.
- CLI: `/team <prompt>`; resume with `cline --id`.
- Scheduled agents: cron schedules stored under `~/.cline/cron/`, run by a
  background hub, persisting across restarts.

### 4.3 OpenHands

- V1 SDK: stateless agent specifications, event-driven execution, structured
  events (messages, actions, observations) for streaming and security
  interleaving.
- Delegation is a **tool**, not a core feature: `TaskTool` (prompt,
  subagent_type, description, resume) creates a separate conversation;
  `DelegateTool` runs tasks concurrently in threads.
- Agents are Markdown files with frontmatter (name, description, model, tools,
  skills, hooks, MCP config, permission mode, condenser) discovered from
  project/user/builtin/plugin levels; built-ins include code-explorer,
  bash-runner, web-researcher.
- An outer loop can run an LLM judge over the transcript and inject follow-ups
  or stop; critics/refinement iterations are pluggable.
- Skills use progressive disclosure and path-triggered activation.

### 4.4 Codex CLI

- Thread-tree model with `AgentControl`, `AgentRegistry`, and persisted
  parent/child topology.
- `SpawnAgentForkMode`: full history or last N turns, with intermediate tool
  calls filtered out to prevent context bloat.
- Inter-agent communication flows through the session input queue with mailbox
  phases and typed records (spawn, message, followup, result); two tool
  generations coexist per model.
- Declarative TOML roles (explorer, worker); map-reduce fan-out via
  `spawn_agents_on_csv` with a shared JSON-schema result contract.
- Automatic delegation can be tied to the highest reasoning tier.

### 4.5 OpenCode

- Subagents are **child sessions** of the same loop, with `parentID`, resumable
  by `task_id`; only the final assistant text returns (wrapped in
  `<task_result>`); background results arrive as synthetic user messages.
- Agents and modes share one schema; plan mode is a permission ruleset plus a
  system reminder. Tool availability is permission-derived; children inherit the
  parent's deny rules only.
- Recursion is off by default, opt-in per agent, no numeric depth cap.
- Custom agents come from config, Markdown files, or LLM generation.

### 4.6 Gemini CLI, Goose, Aider, Hermes, Pi, OpenClaw, Omnigent

- **Gemini CLI**: named agent registry (Markdown), `invoke_agent`, isolated tool
  registry per run, symmetric local/remote session protocol, experimental A2A
  server, per-definition tool config.
- **Goose**: recipes + subrecipes. Each subrecipe becomes a tool, runs in an
  isolated session, accepts parameters, and is non-nesting. Sequential
  composition, configuration-driven.
- **Aider**: single-agent, but architect/editor split — a reasoning model
  proposes, an editor model produces edits. A two-model pipeline is the cheap
  version of a team for models weak at editing.
- **Hermes**: in-process `delegate_task` with summary return, toolset
  intersection, recursion blocklist, 3 concurrent children, depth 1; plus a
  process-level Kanban swarm coordinated through SQLite; plus mixture-of-agents
  advisory models.
- **Pi**: core is single-agent; the reference extension spawns OS processes,
  parses child JSONL, worker pool of 4 (max 8), no mid-run messaging.
- **OpenClaw**: ACP child processes with JSONL transcripts and event deltas.
- **Omnigent** (meta-harness): orchestrates eleven vendor harnesses behind one
  API over ACP, adding cross-harness policies, a uniform sandbox, and shared
  sessions. Harnesses are components.

## 5. Worktree isolation and integration — the hard part

Two practitioner sources on parallel agents converge on rules that matter more
than the spawning mechanism:

- **Split tasks by contract, not by file.** Two agents can touch different lines
  and still break each other: rename vs. new caller, replace vs. extend, schema
  change vs. old-shape code. Land shared interfaces first, then branch agents
  from that commit.
- **Run tests on the merged result, not only on each branch.** `git merge-tree`
  writes a trial tree without checking anything out; check that tree out in a
  throwaway worktree and run the suite. One source cites a 2011 study where 133
  of 399 clean merges broke the build or tests.
- **Serialize integration.** One merge lane; rebase each branch onto the
  current main, run tests, fast-forward only on success; abort and route to a
  human on failure.
- **Reserve paths pessimistically.** If two tasks need the same file, run them
  serially rather than letting models resolve conflict markers.
- **Do not let agents resolve textual conflicts.** Models drop adjacent
  changes, invent logic, or leave markers behind.

Claude Code's `isolation: worktree` confirms the direction: isolated checkouts
plus path enforcement. Cline and OpenHands instead isolate *contexts* and merge
results; both models are viable, but file isolation is the safer default for
parallel implementers.

## 6. What to add to `ollama-agent`

Current baseline: one-shot `Task` subagents (general-purpose / explore / plan),
a depth guard, tool loop, permissions, sessions, MCP, images/text/PDF
attachments, plan mode, CLI + HTTP server + Electron UI, settings, projects,
artifacts, update checker.

### 6.1 Agent definitions (foundation)

Add Markdown agent definitions with frontmatter, loaded from:

- built-ins (compiled): `explore`, `plan`, `implementer`, `reviewer`, `tester`
- user: `~/.config/ollama-agent/agents/*.md`
- project: `.ollama-agent/agents/*.md` (walk up to repo root)

Frontmatter to support initially: `name`, `description`, `model`, `tools`,
`disallowedTools`, `permissionMode`, `maxTurns`, `skills`, `mcpServers`,
`isolation` (`worktree` | `none`), `background`. The body becomes the agent's
system prompt. Reuse the existing `Task` tool: `subagent_type` resolves a
definition instead of the hardcoded three.

Why: it turns roles into data, enables teams, and matches every serious harness.

### 6.2 Team mode (the ask)

Make teams **opt-in** (`/team`, a UI toggle, or `team.enabled: true`). One lead
session, named teammates, shared task board, mailboxes, outcomes.

**Principles**

- Teams are for breadth-first work: independent modules, parallel research,
  competing hypotheses, cross-layer changes. Sequential or same-file work stays
  single-agent.
- Every teammate has its own context, session, and (ideally) worktree.
- Coordination is explicit: task board + messages, no shared memory.
- The lead synthesizes; teammates do not approve permissions for the user.
- Default limits: 3 concurrent workers, depth 1 (no teammate-spawned teams),
  25–40 turns per worker, token budget per worker.

**Tools (lead only unless noted)**

| Group | Tools |
| --- | --- |
| Teammates | `team_spawn`, `team_shutdown`, `team_status` |
| Task board | `team_task_create`, `team_task_list`, `team_task_claim`, `team_task_update`, `team_task_complete`, `team_task_block` |
| Runs | `team_run`, `team_list_runs`, `team_await`, `team_cancel` |
| Messages | `team_send`, `team_broadcast`, `team_mailbox`, `team_mission_log` |
| Outcomes | `team_outcome_create`, `team_outcome_attach`, `team_outcome_review`, `team_outcome_finalize` |
| Cleanup | `team_cleanup` |

Teammates get everything except spawn/shutdown/cleanup; task tools only if the
team setting enables self-claim.

**State model** (under `agentHome()/teams/<teamId>/`, session-linked):

```text
team.json          id, name, leadSession, members[], settings, createdAt
tasks/<id>.json    id, title, description, status, assignee, dependsOn[],
                   files[] (reservations), worktree, result, timestamps
inboxes/<name>.json  validated messages: id, from, to, kind, text, taskId, at
mission.log.jsonl   ordered events (spawn, claim, message, complete, merge)
outcomes/<id>.json  fragments, review notes, final summary
runs/<id>.json      run state, model, turns, usage, error
```

- Task claims are atomic (write-temp + rename or an in-process mutex guarded by
  a lock file). Dependencies unblock automatically on completion.
- Messages become **user-role** turns in the recipient's context, marked with
  the sender; the model is told the message is from another agent, not the user.
- Team and task state survive app restarts and resume with the session.

**Isolation**

- If the project is a git repository: each implementer gets a worktree at
  `.ollama-agent/worktrees/<team>/<agent>` on branch
  `agent/<team>/<agent>`, branched from the team's base commit. The teammate's
  cwd is the worktree; shell path checks prevent escaping to the main checkout.
- If not a git repo: shared cwd with pessimistic file reservations; overlapping
  tasks are serialized.
- Reviewer/lead operates in the main checkout for integration.

**Integration/merge gate**

1. Teammate completes a task and produces a diff + test result.
2. Lead/reviewer reviews the diff (UI diff view), not the model's summary alone.
3. Serialized merge lane: rebase branch onto current base, run tests on the
   branch, then create a trial merge (`git merge-tree`) and run tests on the
   merged tree in a throwaway worktree.
4. Fast-forward only on success; on failure, abort and return the task with
   feedback; never let a model resolve conflict markers.
5. Final merge to the user's branch requires approval (unless bypass mode).

**Permissions and models**

- Teammates inherit the lead's permission mode; mutating calls surface in the
  lead UI. Plan-mode teammates send plan approvals to the lead.
- No permission relay: a teammate cannot approve for the user, and a denial
  cannot be laundered through another agent.
- Per-agent `model`, with role defaults (planner/reviewer on the stronger model,
  workers on the fast model); fall back to the lead's model. Track per-agent
  context/tokens.

**Context and cost**

- Each teammate has its own `Agent`/session; optional fork of the lead's system
  prompt and last N turns (Codex-style), with tool outputs stripped.
- Ollama has no prompt caching. Keep teammate system prompts lean; avoid
  re-sending the whole lead transcript; rely on compaction and summaries.
- Enforce worker token/turn budgets and a team-wide concurrency cap.

**UI**

- Team drawer: teammate rows (status, model, current task, worktree), task board
  with states/dependencies, mailbox/mission log, run controls.
- Click a teammate to open its transcript and message it directly; stop a
  teammate; stop the team.
- Merge review: branch diff, test output, trial-merge result, approve/reject.
- CLI: `/team <prompt>`, `/team status`, `/team message <agent> <text>`,
  `/team stop`, `/team merge`.
- API: team state/actions over IPC and HTTP, with SSE events (`team_created`,
  `team_status`, `task_updated`, `mailbox`, `run_started`, `run_ended`,
  `merge_ready`).

### 6.3 Skills (highest adoption, lower effort than teams)

- Adopt the `SKILL.md` + YAML frontmatter convention (`name`, `description`;
  optional `paths`, `requires`, `user-invocable`).
- Discover from `~/.config/ollama-agent/skills/`, project
  `.ollama-agent/skills/`, and `~/.agents/skills/`; optionally read
  `~/.claude/skills/` for interoperability (OpenCode does this deliberately).
- Eagerly inject only name + description; load the body via a `Skill` tool
  (progressive disclosure). Add path-triggered activation for relevant skills.
- Skills can bundle scripts/templates; treat third-party skills as packages
  (trust tiers, scanning, quarantine) if you add a registry.
- This is a bigger differentiator per unit effort than teams, and the study
  finds skills now out-adopt MCP (9/11 vs. 8/11).

### 6.4 Checkpoints and rewind

- Snapshot files touched by `Write`/`Edit`/`MultiEdit` before each turn; keep the
  last ~100 snapshots per session.
- `/rewind` restores code, conversation, or both; "summarize from here" is a
  cheap context-management tool.
- This is the strongest safety net for autonomous edits and a natural companion
  to teams (rollback a bad worker merge).

### 6.5 Model-aware editing and tools

- Exact unique-match `Edit` is right for frontier models but brittle for small
  Ollama models. Add a fuzzy cascade: normalize whitespace/Unicode, then
  contextual/line-window matching with a similarity threshold, and an optional
  edit-repair model call. Never line-number edits.
- Select edit format/tool surface per model family (OpenCode/Aider pattern).
- Add deferred tool loading / tool search when MCP makes the tool count exceed
  ~15 (Claude Code and Codex both do this; ~40% prompt reduction reported for
  Claude).
- Add cheap stuck detection: repeated identical tool call counter, wall-clock
  cap, turn cap; avoid over-engineering.

### 6.6 Hooks and policy-as-code

- Add lifecycle hooks: `SessionStart`, `UserPromptSubmit`, `PreToolUse` (block),
  `PostToolUse`, `PostToolUseFailure`, `Stop`, `SubagentStop`, `TaskCreated`,
  `TaskCompleted`, `TeammateIdle`, `SessionEnd`.
- Hooks as shell commands with JSON on stdin, exit-code semantics; rules in a
  config file (policy-as-code), so teams and CI can share them.
- This enables formatting, linting, tests-on-stop, audit logs, and team idle
  rules without core changes.

### 6.7 ACP server and platform surface

- Ship an **ACP server**: it makes the harness usable from Zed/Neovim/Emacs and
  from meta-harnesses; the study recommends it explicitly and six of eleven
  systems ship one.
- Do not adopt A2A or ACP for internal subagent coordination; in-process
  primitives are what production systems use.

### 6.8 Background and scheduled work

- Background agent view: dispatch and monitor independent sessions, with a
  status list and transcript access.
- Scheduled agents: cron + prompt + config, persisted, results stored; useful
  for nightly reviews, dependency updates, changelog drafts.
- Our current single global `busy` lock would need per-session/team concurrency.

### 6.9 Observability and evaluation

- Per-run telemetry: model, turns, tokens in/out, wall time, tools used,
  retries, compactions, failures; a team-level rollup.
- A replay/eval harness with scripted providers (we already use mock providers in
  tests) and recorded transcripts; benchmark fuzzy edits and team coordination
  before enabling teams by default.

### 6.10 Priority matrix

| Addition | Impact | Effort | Notes |
| --- | --- | --- | --- |
| Agent definitions | High | Medium | Foundation for teams and custom roles |
| Team core (tasks/mailbox/outcomes) | High | High | The requested feature; opt-in |
| Worktrees + merge/test gate | High | Medium-High | Required for safe parallel edits |
| Skills + progressive disclosure | High | Medium | Better adoption/effort than teams |
| Checkpoints/rewind | High | Medium | Safety net for any mutation |
| Fuzzy edit cascade | High for Ollama | Medium | Small/local models are the bottleneck |
| Deferred tool loading | Medium | Medium | Needed when MCP tool count grows |
| Hooks/policy-as-code | Medium-High | Medium | Automation and team lifecycle |
| Model router per role | Medium | Low-Medium | Planner/reviewer vs. worker models |
| ACP server | Medium | High | IDE/meta-harness reach |
| Background/scheduled agents | Medium | Medium | Requires concurrency refactor |
| Sandboxing | High (security) | High | Bubblewrap/Seatbelt; enterprise floor |
| Code RAG | Negative | High | 0/11 harnesses do it; don't |

## 7. Proposed phased implementation

**Phase 1 — Agent definitions (small-medium).**
Parse Markdown frontmatter, resolve `subagent_type` to definitions, add scopes
and built-ins, expose in UI/CLI; keep `Task` one-shot. Tests for discovery,
scope precedence, tool filtering, and body-as-system-prompt.

**Phase 2 — Team core (large).**
Team state, task board with dependencies and atomic claims, mailbox, mission
log, outcomes, lead tools, teammate runs (start sequential), persistence,
team events, UI drawer and CLI `/team`. Permissions inherited; depth 1;
concurrency 1–2. Tests with scripted providers.

**Phase 3 — Parallelism and isolation (large).**
Parallel runs with a cap, per-teammate sessions, worktree manager (git),
non-git reservations, diff review, serialized merge queue, trial merge + tests,
stop/cancel, per-agent model/budget. Tests for worktree lifecycle, claim races,
merge gate rejection.

**Phase 4 — Ecosystem (medium).**
Skills (progressive disclosure), checkpoints/rewind, hooks, deferred tool
loading, model-aware edits, ACP server, background/scheduled sessions,
telemetry/eval.

## 8. Anti-patterns and risks

- **Teams for everything.** Coordination overhead and ~15× tokens; teams only
  for genuinely parallel, contract-separable work.
- **Same-file parallel edits.** Reserve paths or serialize.
- **Trusting clean merges.** Run tests on the trial merge; git merges text, not
  meaning.
- **Model-resolved conflicts.** Never.
- **Tool escalation.** Subagents/teammates must not gain tools the lead lacks;
  toolsets intersect with the parent (Hermes), and no permission relay.
- **Framework maximalism.** 0/11 production harnesses use LangChain/LangGraph/
  AutoGen/CrewAI-style runtimes; keep raw loops and explicit primitives.
- **Code RAG.** 0/11 do it; deterministic search plus tree-sitter is the norm.
- **Prompt-cache assumptions.** Ollama does not cache prompts; forked contexts
  re-send tokens. Budget accordingly.
- **Over-engineered stuck detection.** Ship cheap identity/iteration caps.
- **Unbounded teams/schedules.** Caps on workers, turns, tokens, runtime, and
  scheduled runs; audit trails.

## 9. Decisions to make before building teams

1. **Isolation default**: worktrees only for implementers? Allow shared-tree
   teams for non-git projects? (Recommend: worktrees when git, reservations
   otherwise.)
2. **Merge policy**: reviewer agent only, or reviewer + user approval? Auto-merge
   when tests pass? (Recommend: reviewer + user approval; no auto-merge.)
3. **Team size and depth**: default 3 workers, depth 1; allow opt-in depth 2?
4. **Task claiming**: lead-assigned, self-claim, or both? (Recommend both.)
5. **Model routing**: per-role defaults; who pays for the reviewer model?
6. **Where team state lives**: per-session vs. project-level reusable teams.
7. **UI**: drawer vs. split panes; transcript access; how much live output to
   stream from workers.
8. **Skills first or teams first?** Skills are cheaper and broadly useful;
   teams are the explicit ask.

## 10. Sources

- Harness Engineering source-code study: https://arxiv.org/html/2609.00006
- Claude Code agent teams: https://code.claude.com/docs/en/agent-teams
- Claude Code agents overview: https://code.claude.com/docs/en/agents
- Claude Code subagents: https://code.claude.com/docs/en/sub-agents
- Claude Code hooks: https://code.claude.com/docs/en/hooks
- Claude Code checkpointing: https://code.claude.com/docs/en/checkpointing
- Cline multi-agent teams: https://docs.cline.bot/sdk/guides/multi-agent-teams
- Cline subagents: https://github.com/cline/cline/blob/main/docs/features/subagents.mdx
- Cline scheduled agents: https://docs.cline.bot/sdk/guides/scheduled-agents
- OpenHands SDK: https://arxiv.org/html/2511.03690
- OpenHands delegation example:
  https://github.com/OpenHands/software-agent-sdk/blob/main/examples/01_standalone_sdk/25_agent_delegation.py
- OpenCode agents: https://opencode.ai/docs/agents/
- Goose subrecipes: https://block.github.io/goose/docs/guides/recipes/subrecipes
- Aider architect/editor: https://aider.chat/docs/usage/modes.html
- ACP progress report: https://zed.dev/blog/acp-progress-report
- Parallel agents in worktrees:
  https://stackness.dev/blog/running-coding-agents-in-parallel-git-worktrees-and-the-merge-check
- Multi-agent worktree merge conflicts:
  https://raylabs.app/articles/handling-git-merge-conflicts-in-multi-agent-worktrees/
- Skill-Use benchmark: https://arxiv.org/html/2608.04828
- Progressive disclosure report: https://arxiv.org/html/2609.35692v1

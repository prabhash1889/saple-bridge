// Swarm agent prompt builders (Phase 2). Split out of `swarmStore.launchAgentProcess` so the
// coordinator gets its own plan-contract prompt while workers keep the existing brief. The plan IS
// the assignment now: worker missions come from the coordinator's `plan.json` task, not a
// `tasks.json` convention nothing parsed.
import type { SwarmAgent } from '../stores/swarmStore';
import type { ContextFileRef } from '../types/wizard';
import { SWARM_SKILLS } from '../components/swarm/wizard/skills';
import { contextBriefSection } from './contextBrief';

export interface PromptContext {
  mission: string;
  skills: string[];
  contextFiles: ContextFileRef[];
}

const skillsSectionFor = (skills: string[]): string => {
  const active = SWARM_SKILLS.filter((s) => skills.includes(s.id));
  return active.length > 0
    ? `\n## Active Swarm Skills\n${active.map((s) => `- **${s.label}:** ${s.promptText}`).join('\n')}\n`
    : '';
};

const contextSectionFor = (contextFiles: ContextFileRef[]): string =>
  contextFiles.length > 0
    ? `\n## Provided Context Files\nRead these files for additional context:\n${contextFiles.map((f) => `- ${f.path}`).join('\n')}\n`
    : '';

// The `plan.json` contract, embedded verbatim so the coordinator emits exactly what `parsePlan`
// accepts. Kept in sync with `src/types/swarmPlan.ts` / `src/lib/swarmPlan.ts`.
const PLAN_CONTRACT = `{
  "version": 2,
  "acceptance": { "command": "npm test", "description": "how success is verified" },
  "tasks": [
    {
      "id": "unique_task_id",
      "mission": "what this worker must do, in full — this is the worker's only assignment",
      "role": "builder",
      "dependsOn": ["other_task_id"],
      "provider": "auto",
      "model": "default",
      "review": true,
      "strategy": "single"
    }
  ]
}`;

const buildCoordinatorPrompt = (agent: SwarmAgent, ctx: PromptContext): string => {
  const marker = agent.marker;
  return `# Swarm Coordinator Mission Instructions

**Mission:** ${ctx.mission || 'Coordinate the swarm.'}
**Agent Name:** ${agent.name}
**Role:** coordinator
**Agent ID:** ${agent.id}

## Your Job
You do not build. You decompose the mission into a task DAG and write it as \`.saple/swarm/plan.json\`.
Bridge parses that file and materializes one worker per task, launching them in dependency order.
Keep task \`mission\` fields self-contained — each is the worker's ONLY assignment.

## plan.json Contract (write this exact shape)
\`\`\`json
${PLAN_CONTRACT}
\`\`\`
Rules:
- Every task needs a unique \`id\` (append-only key) and a non-empty \`mission\`.
- \`dependsOn\` lists task ids that must finish first. No cycles — Bridge drops cyclic tasks.
- \`review: true\` asks Bridge to auto-generate a reviewer for that task.
- \`provider: "auto"\` lets Bridge assign a signed-in CLI; name a specific one only if it matters.
- \`acceptance.command\` is the real command Bridge runs to verify the whole mission (e.g. \`npm test\`).
- Unknown fields are dropped; a missing id/mission drops the task. Write valid JSON only.

## Mailbox
Write status notes to \`.saple/swarm/mailbox/${agent.id}.md\`; the operator can reply there mid-run.
${skillsSectionFor(ctx.skills)}${contextSectionFor(ctx.contextFiles)}
${contextBriefSection({ role: 'coordinator', agentId: agent.id })}
## Coordinator Signals
Emit EXACTLY ONE marker per event, each on its own line. ${marker ? `The \`:${marker}\` suffix identifies you — a signal without it is ignored, so include it verbatim.` : ''}
${marker
      ? `- After you write plan.json: \`[PLAN_READY:${marker}]\`
- If you later revise/append tasks (rewrite plan.json first): \`[PLAN_UPDATED:${marker}]\`
- When planning is complete and you have nothing to add: \`[AGENT_DONE:${marker}]\`
- Fatal failure (you cannot produce a plan): \`[AGENT_FAILED:${marker}]\``
      : `- After you write plan.json: \`[PLAN_READY]\`
- If you later revise/append tasks: \`[PLAN_UPDATED]\`
- When planning is complete: \`[AGENT_DONE]\`
- Fatal failure: \`[AGENT_FAILED]\``}
`;
};

const buildWorkerPrompt = (agent: SwarmAgent, ctx: PromptContext): string => {
  // P4: a rejected agent relaunches with the reviewer's feedback front-and-centre so its retry
  // addresses the rejection rather than repeating the same work.
  const reviewFeedbackSection = agent.lastReviewFeedback
    ? `\n## Review Feedback (rework attempt ${agent.attempt ?? 2})\nA previous attempt was rejected in review. Address this feedback before signaling completion:\n\n${agent.lastReviewFeedback}\n`
    : '';

  // Scope this agent's completion markers to its own token so its status can't be flipped by
  // another pane's output or by echoing the generic marker name. Older agents (restored from a
  // pre-marker state.json) have no token — they keep using the bare markers.
  const marker = agent.marker;
  // P3: before signaling, an agent may record a structured outcome so reviewers see what it did
  // without opening the terminal. Optional — a marker on its own still completes the agent.
  const outcomeSection = `## Structured Outcome (optional but recommended)
Before you signal completion, write your outcome as JSON to \`.saple/swarm/outcomes/${agent.id}.json\`:
\`\`\`json
{ "summary": "one line on what you did", "changedFiles": ["path/to/file"], "tests": { "command": "npm test", "passed": true }, "decisions": ["a decision you made"], "needsReview": true }
\`\`\`
`;
  const signalsSection = (marker
    ? `## Review / Completion Signals
Emit EXACTLY ONE of these on its own line when you finish. The \`:${marker}\` suffix identifies
you — a signal without it is ignored, so always include it verbatim:
- Success: \`[AGENT_DONE:${marker}]\`
- Human review needed: \`[REVIEW_REQUESTED:${marker}]\`
- Fatal failure: \`[AGENT_FAILED:${marker}]\`
`
    : `## Review / Completion Signals
- When you are finished, output \`[AGENT_DONE]\` or \`[TASK_COMPLETE]\` to signify success.
- If you require human review, output \`[REVIEW_REQUESTED]\` or \`## REVIEW REQUIRED\`.
- If you encounter a fatal failure, output \`[AGENT_FAILED]\` or \`[TASK_FAILED]\`.
`) + outcomeSection;

  return `# Swarm Agent Mission Instructions

**Mission:** ${ctx.mission || 'Execute coordinated tasks'}
**Agent Name:** ${agent.name}
**Role:** ${agent.role}
**Agent ID:** ${agent.id}

## System Instructions
${agent.systemPrompt}

## Swarm Integration Context
- Dependencies: ${agent.dependencies.join(', ') || 'None'}
- Mailbox Path: .saple/swarm/mailbox/${agent.id}.md (Write your updates/output here)
- Handoff Path: .saple/swarm/handoffs/${agent.id}-to-[next_agent].json
${skillsSectionFor(ctx.skills)}${contextSectionFor(ctx.contextFiles)}${reviewFeedbackSection}
${contextBriefSection({ role: agent.role, agentId: agent.id })}
${signalsSection}`;
};

// Build the launch prompt for a swarm agent. Coordinators get the plan-contract brief; every other
// role gets the worker brief whose assignment is its own `systemPrompt` (the plan task's mission).
export function buildAgentPrompt(agent: SwarmAgent, ctx: PromptContext): string {
  return agent.role === 'coordinator' ? buildCoordinatorPrompt(agent, ctx) : buildWorkerPrompt(agent, ctx);
}

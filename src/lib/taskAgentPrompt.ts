import type { Task } from '../types/task';
import { contextBriefSection } from './contextBrief';

// P1: single source for the prompt written when a Kanban task launches an agent. TaskCard, the task
// detail drawer, and the command palette all used to build near-identical prompts inline; they now
// share this so the context-brief contract and review signals stay consistent across every entry.
export function buildTaskAgentPrompt(task: Task): string {
  const systemPrompt = task.agentConfig?.systemPrompt || 'You are an autonomous coding builder.';
  const role = task.agentConfig?.role || 'builder';
  const acceptance = task.acceptanceCriteria ?? [];
  const targets = task.targetFiles ?? [];

  return `# Task: ${task.title}

## Description
${task.description || 'No description provided.'}

## Acceptance Criteria
${acceptance.length > 0 ? acceptance.map((a) => `- ${a}`).join('\n') : '* None specified.'}

## Target Files
${targets.length > 0 ? targets.map((t) => `- ${t}`).join('\n') : '* None specified.'}

## Agent Role Instructions
Role: ${role}
Instructions: ${systemPrompt}

${contextBriefSection({ role, taskId: task.id, taskTitle: task.title })}
## Review Signal Instructions
When you have finished the task and verified it, print a clear signal indicating completion.
You MUST output one of the following exact review trigger patterns on a line by itself:
- [REVIEW_REQUESTED]
- ## REVIEW REQUIRED
- Task complete. Review required.
`;
}

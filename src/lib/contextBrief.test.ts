import { describe, it, expect } from 'vitest';
import { contextBriefSection } from './contextBrief';
import { buildTaskAgentPrompt } from './taskAgentPrompt';
import type { Task } from '../types/task';

// P1: every launch must name its task/role and the smallest relevant brief tool, and must not
// inline the whole memory graph. These assert the shared contract used by task and swarm prompts.
describe('contextBriefSection (P1 context contract)', () => {
  it('directs a task launch to get_task_context and identifies the task', () => {
    const s = contextBriefSection({ role: 'builder', taskId: 't-42', taskTitle: 'Fix login' });
    expect(s).toContain('get_task_context');
    expect(s).toContain('Fix login');
    expect(s).toContain('t-42');
    expect(s).not.toContain('get_project_brief');
  });

  it('directs a coordinator with no task to get_project_brief', () => {
    const s = contextBriefSection({ role: 'coordinator' });
    expect(s).toContain('get_project_brief');
    expect(s).not.toContain('get_task_context');
  });

  it('directs any other registered agent to get_agent_brief', () => {
    const s = contextBriefSection({ role: 'reviewer', agentId: 'a-7' });
    expect(s).toContain('get_agent_brief');
    expect(s).toContain('a-7');
  });

  it('does not inline project memories and degrades gracefully without the sidecar', () => {
    const s = contextBriefSection({ role: 'builder', taskId: 't-1' });
    // Points at search_memories rather than dumping memories inline.
    expect(s).toContain('search_memories');
    expect(s).toContain('do not assume the whole memory graph');
    // Clear fallback when the MCP server is down.
    expect(s.toLowerCase()).toContain('unavailable');
  });
});

describe('buildTaskAgentPrompt (P1)', () => {
  const task: Task = {
    id: 'task-9',
    title: 'Add rate limiting',
    description: 'Throttle the API',
    column: 'backlog',
    priority: 'normal',
    createdAt: '',
    updatedAt: '',
    labels: [],
    agentConfig: { role: 'builder', systemPrompt: 'do it', model: 'default', provider: 'codex' },
  };

  it('embeds the task brief instruction and review signal', () => {
    const prompt = buildTaskAgentPrompt(task);
    expect(prompt).toContain('get_task_context');
    expect(prompt).toContain('task-9');
    expect(prompt).toContain('Add rate limiting');
    expect(prompt).toContain('[REVIEW_REQUESTED]');
  });
});

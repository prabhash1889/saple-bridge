// P1: a short "context contract" appended to every agent launch prompt. It points the agent at the
// smallest relevant saple-memory MCP brief tool instead of inlining the project's memories, and
// tells it to record durable decisions/lessons back through MCP as it works.
//
// This is pure prompt text — the agent's provider CLI owns the MCP connection, so Bridge never calls
// these tools at launch. If the saple-memory sidecar is unavailable the agent simply reports it and
// proceeds from the mission text and attached files (see the fallback line below), so nothing on the
// launch path breaks.

export interface ContextBriefOptions {
  // Agent role (coordinator / builder / scout / reviewer / custom).
  role: string;
  // Kanban/canonical task id + title, when the launch is tied to a task.
  taskId?: string;
  taskTitle?: string;
  // Registered agent id (swarm), when available — used only to identify the agent to itself.
  agentId?: string;
}

// Choose the single brief tool the agent should call first, per the P1 contract:
// - a task launch → get_task_context (before editing)
// - a coordinator → get_project_brief (before planning)
// - any other registered agent → get_agent_brief (role-specific context)
function primaryBriefLine({ role, taskId, taskTitle, agentId }: ContextBriefOptions): string {
  if (taskId) {
    const id = taskTitle ? `"${taskTitle}" (${taskId})` : taskId;
    return `- Call \`get_task_context\` for task ${id} before you edit anything.`;
  }
  if (role === 'coordinator') {
    return '- Call `get_project_brief` before you plan.';
  }
  const who = agentId ? ` for your agent (${agentId})` : '';
  return `- Call \`get_agent_brief\`${who} when you need role-specific context.`;
}

export function contextBriefSection(opts: ContextBriefOptions): string {
  return `## Context Brief (saple-memory MCP)
Pull only the context you need — do not assume the whole memory graph is in this prompt.
${primaryBriefLine(opts)}
- Use \`search_memories\` for an individual memory only when a brief points you to it.
- Record durable decisions and lessons with \`record_decision\` / \`record_lesson\` as you work.
- If the saple-memory MCP server is unavailable, say so briefly and continue from the mission text and attached files.
`;
}

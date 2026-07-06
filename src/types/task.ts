import type { AgentProvider } from './provider';
import type { AgentRole } from './agent';

export type TaskColumn = 'backlog' | 'progress' | 'review' | 'done';
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface ChecklistItem {
  text: string;
  done: boolean;
}

export interface AgentConfig {
  role: AgentRole;
  systemPrompt: string;
  model: string;
  provider: AgentProvider;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  column: TaskColumn;
  priority: TaskPriority;
  createdAt: string;
  updatedAt: string;
  labels: string[];
  // Optional metadata; absent on tasks written before these fields existed.
  dueDate?: string; // ISO date (yyyy-mm-dd)
  checklist?: ChecklistItem[];
  template?: string;
  targetFiles?: string[];
  acceptanceCriteria?: string[];
  agentConfig?: AgentConfig;
  terminalId?: string;
  sessionId?: string;
}

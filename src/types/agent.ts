import type { AgentProvider } from './provider';

export type AgentRole = 'coordinator' | 'builder' | 'scout' | 'reviewer';

export type AgentStatus =
  | 'idle'
  | 'queued'
  | 'starting'
  | 'running'
  | 'waiting'
  | 'review'
  | 'blocked'
  | 'done'
  | 'failed'
  | 'stopped';

export interface AgentArtifact {
  id: string;
  type: 'changed_file' | 'test_result' | 'memory_note' | 'handoff' | 'log' | 'summary';
  title: string;
  path?: string;
  content?: string;
  createdAt: string;
}

export interface AgentSession {
  id: string;
  taskId?: string;
  swarmId?: string;
  provider: AgentProvider;
  accountProfile?: string;
  model: string;
  role: AgentRole;
  name: string;
  cwd: string;
  terminalId?: string;
  promptPath?: string;
  transcriptPath?: string;
  outputLogPath: string;
  status: AgentStatus;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  exitCode?: number;
  reviewRequestedAt?: string;
  artifacts: AgentArtifact[];
}

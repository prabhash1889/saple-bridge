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

/// Structured completion outcome (Improvement Plan P3). Agents emit this (via the MCP artifact
/// tools) or Bridge records it, so Review/handoffs/history get predictable evidence instead of only
/// a terminal marker. All fields optional — invalid or partial data must never break completion.
export interface AgentOutcome {
  summary?: string;
  changedFiles?: string[];
  tests?: {
    command?: string;
    passed?: boolean;
  };
  decisions?: string[];
  needsReview?: boolean;
}

export interface AgentSession {
  id: string;
  taskId?: string;
  swarmId?: string;
  /// Cross-references into the canonical control plane (P0). Set at launch when the agent + run
  /// records are created; the canonical `.saple/{agents,runs,artifacts}.json` files stay
  /// authoritative and `sessions.json` is Bridge's runtime/PTY state that points at them.
  agentId?: string;
  runId?: string;
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

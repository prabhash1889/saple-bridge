// TS mirrors of the mission engine's serde wire types (src-tauri/src/missions.rs).
// Single source of truth is the Rust side; keep this file in sync by hand. The store
// tests round-trip a real engine-shaped payload against these types.

export type MissionStatus =
  | 'draft'
  | 'running'
  | 'paused'
  | 'gated'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type TaskKind = 'implement' | 'review' | 'verify';

export type TaskStatus =
  | 'pending'
  | 'ready'
  | 'dispatched'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'circuit_broken';

export interface CoordinatorSpec {
  provider: string;
  model?: string;
  permission?: string;
}

export interface MissionSpec {
  title: string;
  objective: string;
  acceptance: string[];
  maxParallel: number;
  maxRounds: number;
  budgetUsdCap: number;
  worktreeMode: 'per-task' | 'per-mission' | 'shared';
  coordinator?: CoordinatorSpec;
}

export interface MissionTask {
  id: string;
  title: string;
  kind: TaskKind;
  spec: string;
  deps: string[];
  fanout: number;
  status: TaskStatus;
  result?: unknown | null;
  gateId?: string | null;
}

export type MissionDispatchStatus =
  | 'pending'
  | 'starting'
  | 'starting_unknown'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'stop_unknown'
  | 'abandoned';

export interface AgentResultDto {
  text: string;
  sessionId?: string | null;
  costUsd?: number | null;
  isError: boolean;
  structured?: unknown | null;
}

export interface MissionDispatch {
  id: string;
  taskId: string;
  attemptId: string;
  retryOf?: string | null;
  provider: string;
  model: string;
  worktreePath?: string | null;
  paneId?: string | null;
  capabilityHash: string;
  status: MissionDispatchStatus;
  failureCount: number;
  lastHeartbeatAt?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  terminationReason?: string | null;
  outputLogPath?: string | null;
  result?: AgentResultDto | null;
}

export interface PoolEntry {
  key: string;
  provider: string;
  model: string;
  worktreePath?: string | null;
  sessionId: string;
  state: 'idle' | 'retained' | 'released';
  lastTaskId?: string | null;
  reusedCount: number;
}

export interface MissionGate {
  id: string;
  taskId: string;
  question: string;
  options: string[];
  status: 'pending' | 'resolved' | 'timeout';
  resolution?: string | null;
}

export interface MissionMessage {
  id: string;
  threadId: string;
  from: string;
  to: string;
  kind: 'message' | 'ask' | 'reply' | 'notice';
  body: string;
  expectsReply: boolean;
  inReplyTo?: string | null;
  answeredBy?: string | null;
  read: boolean;
  acked: boolean;
  createdAt: string;
}

export interface TaskDispatchOutput {
  state: MissionState;
  dispatchId: string;
  attemptId: string;
  paneId: string;
  promptFile: string;
  capabilityToken: string;
}

export interface ProviderAdapterDto {
  id: string;
  isMissionEligible: boolean;
  supportsMcp: boolean;
  resultFormat: string;
  testedVersionRange: [string, string];
}

export interface MissionEvent {
  seq: number;
  kind: string;
  payload?: unknown;
  at: string;
}

export interface MissionEventPayload {
  missionId: string;
  seq: number;
  event: MissionEvent;
}

export interface CommandOutcome {
  applied: boolean;
  revision: number;
  error?: string;
  state?: MissionState | null;
}

export interface MissionState {
  id: string;
  revision: number;
  status: MissionStatus;
  spec: MissionSpec;
  tasks: MissionTask[];
  dispatches: MissionDispatch[];
  gates?: MissionGate[];
  messages?: MissionMessage[];
  pool?: PoolEntry[];
  events: MissionEvent[];
  idempotency: Record<string, CommandOutcome>;
  createdAt: string;
  updatedAt: string;
}

export interface MissionSummary {
  id: string;
  title: string;
  status: MissionStatus | 'corrupt';
  taskTotal: number;
  taskCompleted: number;
  updatedAt: string;
}

// `mission_read` outcome - mirrors the Rust tagged enum and the state_load taxonomy.
export type MissionReadResult =
  | { status: 'loaded'; state: MissionState; doc: string; warnings: string[] }
  | { status: 'missing' }
  | { status: 'corrupt'; error: string; backupPath: string }
  | { status: 'locked' };

// Settlement Types ---------------------------------------------------------------------

export interface StepReport {
  dispatchId: string;
  attemptId: string;
  token: string;
  paneId?: string | null;
  status: 'done' | 'progress' | 'blocked' | 'failed';
  summary: string;
  changedFiles?: string[] | null;
  tests?: string[] | null;
}

export type SettlementRejectionCode =
  | 'sender_not_assignee'
  | 'stale_attempt'
  | 'task_dispatch_mismatch'
  | 'inactive_dispatch'
  | 'invalid_payload'
  | 'unknown_dispatch';

export type SettlementResult =
  | { status: 'succeeded'; taskId: string }
  | { status: 'failed'; taskId: string; retryScheduled: boolean }
  | { status: 'progress'; taskId: string }
  | { status: 'blocked'; taskId: string; reason: string }
  | { status: 'rejected'; code: SettlementRejectionCode; reason: string }
  | { status: 'duplicate_ignored'; taskId: string };

export interface SettlementOutcome {
  state: MissionState;
  result: SettlementResult;
}

// Gate & Ask/Reply & Mailbox Types -----------------------------------------------------

export interface GateRequestInput {
  dispatchId: string;
  question: string;
  options: string[];
}

export interface AskInput {
  dispatchId: string;
  attemptId: string;
  token: string;
  paneId?: string | null;
  question: string;
  options?: string[] | null;
  timeoutMs?: number | null;
}

export interface AskOutput {
  threadId: string;
  messageId: string;
  autoReply?: string | null;
}

export interface AskOutcome {
  state: MissionState;
  output: AskOutput;
}

export interface SendMessageInput {
  from: string;
  to: string;
  kind: string;
  body: string;
  expectsReply?: boolean;
  threadId?: string | null;
  inReplyTo?: string | null;
}

export interface ArtifactPublishInput {
  dispatchId: string;
  kind?: string;
  content: string;
  label: string;
}

// Inputs -------------------------------------------------------------------------------

export interface MissionCreateInput {
  title: string;
  objective: string;
  options?: {
    acceptance?: string[];
    maxParallel?: number;
    maxRounds?: number;
    budgetUsdCap?: number;
    worktreeMode?: MissionSpec['worktreeMode'];
    coordinator?: CoordinatorSpec;
    body?: string;
  };
}

export interface TaskSpecInput {
  key?: string;
  title: string;
  kind?: TaskKind;
  spec?: string;
  deps?: string[];
  fanout?: number;
}

export type MissionCommand =
  | { type: 'start' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'cancel' }
  | { type: 'retry'; dispatchId: string }
  | { type: 'abandon'; dispatchId: string }
  | { type: 'resolve_gate'; gateId: string; resolution: string };

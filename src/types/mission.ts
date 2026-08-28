// TS mirrors of the mission engine's serde wire types (src-tauri/src/missions.rs).
// Single source of truth is the Rust side; keep this file in sync by hand. The store
// tests round-trip a real engine-shaped payload against these types.

export type MissionStatus =
  'draft' | 'running' | 'paused' | 'gated' | 'completed' | 'failed' | 'cancelled';

export type TaskKind = 'implement' | 'review' | 'verify';

export type TaskStatus =
  'pending' | 'ready' | 'dispatched' | 'completed' | 'failed' | 'blocked' | 'circuit_broken';

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

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
}

export interface MissionState {
  id: string;
  revision: number;
  status: MissionStatus;
  spec: MissionSpec;
  tasks: MissionTask[];
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

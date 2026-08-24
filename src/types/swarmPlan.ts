import type { AgentRole } from './agent';
import type { AgentProvider } from './provider';

// Swarm v2 contracts. These describe the machine-read files the coordinator and reviewers write
// under `.saple/swarm/` (`plan.json`, `verdicts/*.json`). Everything here is untrusted agent output
// on the wire — the parsers in `src/lib/swarmPlan.ts` are the trust boundary; these types describe
// the sanitized shape that survives.

// How much a swarm may do without a human click. `manual` records everything but gates every
// transition; `gated` (default) auto-reworks but wants plan approval; `auto` is hands-free.
export type AutonomyMode = 'manual' | 'gated' | 'auto';

// A plan task's provider is either an explicit signed-in CLI or `auto` (resolved by the Phase 6
// subscription assigner). Kept as a string on the plan; resolution happens at materialization.
export type PlanProvider = AgentProvider | 'auto';

// `single` = one builder. `debate` = N parallel builders + a judge (Phase 8). Anything else is
// sanitized down to `single`.
export type TaskStrategy = 'single' | 'debate';

// The command Bridge runs to verify the whole swarm (Phase 5). `completed` means this passed.
export interface PlanAcceptance {
  command: string;
  description?: string;
}

// One unit of work in the coordinator's plan. `id` is an append-only dedup key across waves.
export interface PlanTask {
  id: string;
  mission: string;
  role: AgentRole;
  dependsOn: string[];
  provider: PlanProvider;
  model: string;
  review: boolean;
  strategy: TaskStrategy;
  // Only meaningful for `strategy: 'debate'` — how many parallel builders compete.
  attempts?: number;
}

export interface SwarmPlan {
  version: number;
  acceptance: PlanAcceptance | null;
  tasks: PlanTask[];
}

// Phase 5 acceptance runner state. `passed` is the only state that lets the swarm complete when
// the plan carries an acceptance command; a load reconciles a stale `running` back to `idle`.
export type AcceptanceStatus = 'idle' | 'running' | 'passed' | 'failed';

// Why Bridge stopped looping repair waves and handed the swarm to a human.
export type EscalationReason = 'max_waves' | 'repeated_failure' | 'no_new_tasks';

// Phase 5 structured escalation report. Written to `.saple/swarm/escalation.json` and persisted in
// state.json so the (Phase 7) escalation panel can offer: one more wave / redirect / stop.
export interface SwarmEscalation {
  reason: EscalationReason;
  wavesAttempted: number;
  maxWaves: number;
  acceptanceCommand?: string;
  // Truncated output of the last failing acceptance run.
  failureOutput?: string;
  // Best-effort: the coordinator's structured-outcome summary at escalation time.
  diagnosis?: string;
  // Valid plan tasks written but not yet materialized - the coordinator's proposed next wave.
  proposedTasks: { id: string; mission: string }[];
}

export type VerdictDecision = 'approve' | 'reject';

// A reviewer's machine-read judgement on a reviewed task. Only `approve`/`reject` are accepted;
// anything else parks the task for a human (`parseVerdict` returns null).
export interface Verdict {
  taskId: string;
  verdict: VerdictDecision;
  feedback?: string;
}

// A single build -> review -> acceptance cycle. Bridge increments `wave` on each repair loop.
export interface SwarmWave {
  wave: number;
  taskIds: string[];
  status: 'building' | 'reviewing' | 'accepting' | 'completed' | 'failed';
}

// The typed events the realtime backbone (Phase 1+) fans out from watcher/marker signals. Consumers
// switch on `type`; payloads carry only sanitized data.
export type SwarmEvent =
  | { type: 'plan_ready'; plan: SwarmPlan }
  | { type: 'plan_updated'; newTasks: PlanTask[] }
  | { type: 'task_completed'; taskId: string }
  | { type: 'task_failed'; taskId: string; reason?: string }
  | { type: 'verdict_recorded'; verdict: Verdict }
  | { type: 'wave_completed'; wave: number }
  | { type: 'acceptance_passed'; command: string }
  | { type: 'acceptance_failed'; command: string; output?: string }
  | { type: 'escalated'; reason: string };

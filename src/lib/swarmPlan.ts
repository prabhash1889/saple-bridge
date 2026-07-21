// Swarm v2 trust boundary. The coordinator and reviewers write `plan.json` / `verdicts/*.json` as
// untrusted agent output; these parsers sanitize-or-drop so a malformed, partial, or hostile file
// can never crash the scheduler or launch a bad worker. Mirrors the `parseWorkerRequests` /
// `parseAgentOutcome` posture: drop, never throw.
import type { AgentRole } from '../types/agent';
import type {
  PlanAcceptance,
  PlanProvider,
  PlanTask,
  SwarmPlan,
  TaskStrategy,
  Verdict,
} from '../types/swarmPlan';

const VALID_ROLES: AgentRole[] = ['coordinator', 'builder', 'scout', 'reviewer'];
const VALID_STRATEGIES: TaskStrategy[] = ['single', 'debate'];

const parseAcceptance = (raw: unknown): PlanAcceptance | null => {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  const command = typeof a.command === 'string' ? a.command.trim() : '';
  if (!command) return null;
  const description = typeof a.description === 'string' ? a.description : undefined;
  return description ? { command, description } : { command };
};

const sanitizeTask = (item: unknown): PlanTask | null => {
  if (!item || typeof item !== 'object') return null;
  const r = item as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id.trim() : '';
  const mission = typeof r.mission === 'string' ? r.mission.trim() : '';
  if (!id || !mission) return null; // missing id/mission drops the task

  const role = VALID_ROLES.includes(r.role as AgentRole) ? (r.role as AgentRole) : 'builder';
  // `auto` is the default; an explicit provider string is kept verbatim for the Phase 6 assigner.
  const provider =
    typeof r.provider === 'string' && r.provider.trim() ? (r.provider.trim() as PlanProvider) : 'auto';
  const model = typeof r.model === 'string' && r.model.trim() ? r.model.trim() : 'default';
  const review = typeof r.review === 'boolean' ? r.review : false;
  const strategy = VALID_STRATEGIES.includes(r.strategy as TaskStrategy)
    ? (r.strategy as TaskStrategy)
    : 'single';
  const dependsOn = Array.isArray(r.dependsOn)
    ? r.dependsOn.filter((d): d is string => typeof d === 'string')
    : [];

  const task: PlanTask = { id, mission, role, dependsOn, provider, model, review, strategy };
  if (strategy === 'debate') {
    task.attempts =
      typeof r.attempts === 'number' && Number.isFinite(r.attempts) ? Math.max(2, Math.floor(r.attempts)) : 2;
  }
  return task;
};

// Kahn's algorithm over the sanitized task list: return only tasks reachable in dependency order.
// Tasks in a cycle never reach indegree 0, so they (and anything transitively stuck behind them)
// are dropped — a cycle can never wedge the scheduler. Uses a Map for the id index so a task id of
// `__proto__`/`constructor` can't pollute anything.
const acyclicSubset = (tasks: PlanTask[]): PlanTask[] => {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const indegree = new Map<string, number>(tasks.map((t) => [t.id, 0]));
  const dependents = new Map<string, string[]>();
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      if (!byId.has(dep)) continue;
      indegree.set(t.id, (indegree.get(t.id) ?? 0) + 1);
      dependents.set(dep, [...(dependents.get(dep) ?? []), t.id]);
    }
  }
  const queue = tasks.filter((t) => (indegree.get(t.id) ?? 0) === 0).map((t) => t.id);
  const resolved = new Set<string>();
  while (queue.length) {
    const id = queue.shift() as string;
    resolved.add(id);
    for (const dependent of dependents.get(id) ?? []) {
      const left = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, left);
      if (left === 0) queue.push(dependent);
    }
  }
  return tasks.filter((t) => resolved.has(t.id)); // preserve input order
};

// Full plan sanitizer. Always returns a usable `SwarmPlan` (empty when the input is garbage) so
// callers never branch on parse failure. Dedups task ids (first wins, append-only key), filters
// deps to known non-self ids, and drops cyclic tasks.
export function parsePlan(raw: unknown): SwarmPlan {
  const empty: SwarmPlan = { version: 2, acceptance: null, tasks: [] };
  if (!raw || typeof raw !== 'object') return empty;
  const o = raw as Record<string, unknown>;

  const version = typeof o.version === 'number' && Number.isFinite(o.version) ? o.version : 2;
  const acceptance = parseAcceptance(o.acceptance);

  const sanitized: PlanTask[] = [];
  const knownIds = new Set<string>();
  const rawTasks = Array.isArray(o.tasks) ? o.tasks : [];
  for (const item of rawTasks) {
    const task = sanitizeTask(item);
    if (!task || knownIds.has(task.id)) continue; // duplicate ids collapse to the first
    knownIds.add(task.id);
    sanitized.push(task);
  }
  // Deps to unknown ids or to self are dropped (a self-edge is a trivial cycle).
  for (const task of sanitized) {
    task.dependsOn = task.dependsOn.filter((d) => d !== task.id && knownIds.has(d));
  }

  return { version, acceptance, tasks: acyclicSubset(sanitized) };
}

// Reviewer verdict sanitizer. Only `approve`/`reject` are accepted; anything else (missing verdict,
// unknown string, no taskId) returns null so the caller parks the task for a human — never guesses.
export function parseVerdict(raw: unknown): Verdict | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const taskId = typeof o.taskId === 'string' ? o.taskId.trim() : '';
  if (!taskId) return null;
  if (o.verdict !== 'approve' && o.verdict !== 'reject') return null;
  const feedback = typeof o.feedback === 'string' ? o.feedback : undefined;
  return feedback ? { taskId, verdict: o.verdict, feedback } : { taskId, verdict: o.verdict };
}

// Given the ids already materialized into the roster and a freshly parsed plan (the coordinator
// re-emits the full plan on every `[PLAN_UPDATED]`), return only the tasks that are new. `incoming`
// is already sanitized + acyclic, so this is a pure novelty filter; deps onto already-applied tasks
// are legitimate and left intact.
export function diffPlan(appliedIds: string[], incoming: SwarmPlan): PlanTask[] {
  const applied = new Set(appliedIds);
  return incoming.tasks.filter((t) => !applied.has(t.id));
}

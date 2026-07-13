// Control-plane client (Improvement Plan P0/P3).
//
// Thin wrappers over the Rust `canonical_record_write` command. They own the *shape* of the
// canonical agent/run/artifact records Bridge writes (the fields match saple-mcp's so the sidecar
// and Review read one compatible store); the Rust layer owns containment, the file whitelist, and
// the cross-process lock.
//
// Every call is best-effort: the control plane is durable bookkeeping, not the critical launch
// path, so a write that fails (sidecar contention, missing project) is logged and swallowed rather
// than aborting a launch or a completion. Callers get `null` on failure.

import { invoke } from '@tauri-apps/api/core';
import { createId } from './id';
import { nowIso } from './date';
import type { AgentOutcome, AgentSession, AgentStatus } from '../types/agent';

const AGENTS = '.saple/agents.json';
const RUNS = '.saple/runs.json';
const ARTIFACTS = '.saple/artifacts.json';

async function writeRecord(
  projectPath: string,
  filePath: string,
  id: string,
  patch: Record<string, unknown>,
  create: boolean,
): Promise<unknown | null> {
  try {
    return await invoke('canonical_record_write', { projectPath, filePath, id, patch, create });
  } catch (error) {
    console.error(`control plane write to ${filePath} (${id}) failed:`, error);
    return null;
  }
}

/// Register the canonical agent + run for a launch: one agent record and one run record,
/// cross-referenced to the session. Idempotent by id — re-registering an existing session (restart
/// reconciliation) merges rather than duplicating. `projectPath` is explicit (a session's `cwd` is
/// the agent's working dir, not necessarily the project root).
export async function registerLaunch(
  projectPath: string,
  session: AgentSession,
): Promise<{ agentId: string; runId: string }> {
  const agentId = session.agentId ?? createId('agent');
  const runId = session.runId ?? createId('run');
  const now = nowIso();

  await writeRecord(projectPath, AGENTS, agentId, {
    name: session.name,
    role: session.role,
    model: session.model,
    provider: session.provider,
    status: 'active',
    metadata: {
      source: 'bridge',
      sessionId: session.id,
      swarmId: session.swarmId,
      taskId: session.taskId,
    },
  }, true);

  await writeRecord(projectPath, RUNS, runId, {
    agentId,
    taskId: session.taskId,
    title: session.name,
    status: 'running',
    phase: 'ship',
    mission: '',
    summary: '',
    startedAt: now,
    finishedAt: null,
    metadata: { sessionId: session.id, swarmId: session.swarmId },
  }, true);

  return { agentId, runId };
}

/// Record a run's terminal/review outcome. A completed session (done/failed) finishes the run;
/// 'review' just advances its phase (the human decision finishes it later, in review.rs).
export async function recordRunOutcome(
  projectPath: string,
  runId: string,
  status: AgentStatus,
  outcome?: AgentOutcome,
): Promise<void> {
  const now = nowIso();
  if (status === 'done' || status === 'failed') {
    await writeRecord(projectPath, RUNS, runId, {
      status: status === 'done' ? 'succeeded' : 'failed',
      phase: status === 'done' ? 'done' : 'failed',
      finishedAt: now,
      summary: outcome?.summary ?? '',
    }, false);
  } else if (status === 'review') {
    await writeRecord(projectPath, RUNS, runId, { phase: 'review' }, false);
  }
}

/// Persist a structured outcome (P3) as canonical artifacts: a summary report plus, when present, a
/// test_result artifact Review reads for the command + pass/fail. Tolerant of partial data.
export async function writeOutcomeArtifacts(
  projectPath: string,
  session: AgentSession,
  outcome: AgentOutcome,
): Promise<void> {
  if (!session.runId) return;
  const base = { runId: session.runId, agentId: session.agentId, taskId: session.taskId };

  if (outcome.summary || outcome.changedFiles?.length || outcome.decisions?.length) {
    await writeRecord(projectPath, ARTIFACTS, createId('artifact'), {
      ...base,
      kind: 'report',
      title: 'Agent outcome',
      content: outcome.summary ?? '',
      metadata: {
        changedFiles: outcome.changedFiles ?? [],
        decisions: outcome.decisions ?? [],
        needsReview: outcome.needsReview ?? false,
      },
    }, true);
  }

  if (outcome.tests && (outcome.tests.command || outcome.tests.passed !== undefined)) {
    const command = outcome.tests.command ?? '';
    const passed = outcome.tests.passed;
    await writeRecord(projectPath, ARTIFACTS, createId('artifact'), {
      ...base,
      kind: 'test_result',
      title: 'Tests',
      content: `${command}\n${passed === undefined ? '' : passed ? 'PASSED' : 'FAILED'}`.trim(),
      metadata: { command, passed },
    }, true);
  }
}

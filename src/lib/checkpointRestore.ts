// Restore gating for per-agent-run checkpoints (Phase 8.2). Pure logic so the
// rules stay testable without Tauri IPC. The backend refuses any restore whose
// `confirmed` flag is false; this module mirrors the gate so the UI can explain
// itself before asking.

import type { Checkpoint } from '../stores/gitStore';

export interface RestoreGateInput {
  checkpoints: Checkpoint[];
  runId: string | null;
  // Number of files currently changed in the working tree (any git status).
  dirtyFiles: number;
  confirmed: boolean;
}

export interface RestoreGate {
  allowed: boolean;
  reason?: string;
}

export function findCheckpoint(checkpoints: Checkpoint[], runId: string | null): Checkpoint | null {
  if (!runId) return null;
  return checkpoints.find((c) => c.id === runId) ?? null;
}

export function evaluateRestoreGate({
  checkpoints,
  runId,
  dirtyFiles,
  confirmed,
}: RestoreGateInput): RestoreGate {
  if (checkpoints.length === 0) {
    return { allowed: false, reason: 'No checkpoints exist yet.' };
  }
  if (!runId || !findCheckpoint(checkpoints, runId)) {
    return { allowed: false, reason: 'No checkpoint recorded for this run.' };
  }
  if (!confirmed) {
    return {
      allowed: false,
      reason:
        dirtyFiles > 0
          ? 'Restoring overwrites tracked files; confirm to discard changes made since the checkpoint.'
          : 'Confirm before restoring.',
    };
  }
  return { allowed: true };
}

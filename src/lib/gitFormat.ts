// Formatting helpers for git branch sync state (Phase 8.1). Pure functions so
// they are testable without Tauri IPC.

export interface AheadBehind {
  ahead: number;
  behind: number;
}

export interface SyncSummary {
  branch: string;
  upstream?: string | null;
  ahead: number;
  behind: number;
}

export function formatAheadBehind({ ahead, behind }: AheadBehind): string {
  const parts: string[] = [];
  if (ahead > 0) parts.push(`↑${ahead}`);
  if (behind > 0) parts.push(`↓${behind}`);
  return parts.join(' ');
}

export function describeSyncState(state: SyncSummary): string {
  const base = state.branch;
  const counts = formatAheadBehind(state);
  const tracked = state.upstream ? ` · tracks ${state.upstream}` : ' · no upstream';
  return counts ? `${base} ${counts}${tracked}` : `${base} · in sync${tracked}`;
}

export function hasDiverged({ ahead, behind }: AheadBehind): boolean {
  return ahead > 0 && behind > 0;
}

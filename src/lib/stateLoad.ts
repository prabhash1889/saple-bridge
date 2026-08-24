// Typed bridge to the Rust state-load commands (Improvement Plan Phase 2: state integrity).
//
// Every persisted store must distinguish `missing` from `unreadable`/`corrupt`. A corrupt
// `.saple/*.json` file is never treated as empty state: Rust preserves the original bytes in a
// sibling backup, flags the path so every write is blocked, and the UI surfaces recovery actions
// (retry / reveal / restore backup / explicitly start empty) before the store may write again.

import { invoke } from '@tauri-apps/api/core';

export type StateLoadResult =
  | { status: 'missing' }
  | { status: 'loaded'; content: string }
  | { status: 'corrupt'; error: string; backupPath: string }
  | { status: 'locked' }
  | { status: 'ioError'; error: string };

/** Corrupt-state info a store keeps while the user has not resolved recovery yet. */
export interface CorruptState {
  filePath: string;
  error: string;
  backupPath: string;
}

export const loadStateFile = (
  projectPath: string,
  filePath: string,
): Promise<StateLoadResult> =>
  invoke('load_state_file', { projectPath, filePath });

export type CorruptionAction = 'retry' | 'restore_backup' | 'start_empty';

export const resolveStateCorruption = (
  projectPath: string,
  filePath: string,
  action: CorruptionAction,
): Promise<StateLoadResult> =>
  invoke('resolve_state_corruption', { projectPath, filePath, action });

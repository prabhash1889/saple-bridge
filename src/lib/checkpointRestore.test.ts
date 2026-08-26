import { describe, it, expect } from 'vitest';
import { evaluateRestoreGate, findCheckpoint } from './checkpointRestore';
import type { Checkpoint } from '../stores/gitStore';

const cp = (id: string): Checkpoint => ({ id, commit: `${id}-sha` });

describe('findCheckpoint', () => {
  it('matches by run id', () => {
    const list = [cp('run-a'), cp('run-b')];
    expect(findCheckpoint(list, 'run-b')?.id).toBe('run-b');
    expect(findCheckpoint(list, 'missing')).toBeNull();
    expect(findCheckpoint(list, null)).toBeNull();
  });
});

describe('evaluateRestoreGate', () => {
  const input = { checkpoints: [cp('run-a')], runId: 'run-a', dirtyFiles: 0 };

  it('blocks when nothing is checkpointed or the run is unknown', () => {
    expect(evaluateRestoreGate({ ...input, checkpoints: [], confirmed: false }).allowed).toBe(false);
    expect(evaluateRestoreGate({ ...input, runId: 'ghost', confirmed: false }).reason).toContain('No checkpoint recorded');
    expect(evaluateRestoreGate({ ...input, runId: null, confirmed: false }).allowed).toBe(false);
  });

  it('requires explicit confirmation and says why when the tree is dirty', () => {
    const dirty = evaluateRestoreGate({ ...input, dirtyFiles: 3, confirmed: false });
    expect(dirty.allowed).toBe(false);
    expect(dirty.reason).toContain('overwrite');

    const clean = evaluateRestoreGate({ ...input, dirtyFiles: 0, confirmed: false });
    expect(clean.allowed).toBe(false);
  });

  it('allows once confirmed', () => {
    expect(evaluateRestoreGate({ ...input, dirtyFiles: 3, confirmed: true }).allowed).toBe(true);
  });
});

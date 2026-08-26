import { describe, it, expect } from 'vitest';
import {
  formatAheadBehind,
  describeSyncState,
  hasDiverged,
} from './gitFormat';

describe('formatAheadBehind', () => {
  it('renders nothing when in sync', () => {
    expect(formatAheadBehind({ ahead: 0, behind: 0 })).toBe('');
  });

  it('renders each direction independently', () => {
    expect(formatAheadBehind({ ahead: 2, behind: 0 })).toBe('↑2');
    expect(formatAheadBehind({ ahead: 0, behind: 3 })).toBe('↓3');
    expect(formatAheadBehind({ ahead: 1, behind: 4 })).toBe('↑1 ↓4');
  });
});

describe('hasDiverged', () => {
  it('is true only when both sides hold commits', () => {
    expect(hasDiverged({ ahead: 1, behind: 0 })).toBe(false);
    expect(hasDiverged({ ahead: 0, behind: 1 })).toBe(false);
    expect(hasDiverged({ ahead: 2, behind: 5 })).toBe(true);
  });
});

describe('describeSyncState', () => {
  it('mentions the upstream when one is configured', () => {
    expect(
      describeSyncState({ branch: 'main', upstream: 'origin/main', ahead: 1, behind: 0 })
    ).toBe('main ↑1 · tracks origin/main');
  });

  it('says in-sync without an arrow when clean', () => {
    expect(
      describeSyncState({ branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0 })
    ).toBe('main · in sync · tracks origin/main');
  });

  it('flags a missing upstream explicitly', () => {
    expect(describeSyncState({ branch: 'feature', upstream: null, ahead: 0, behind: 0 }))
      .toBe('feature · in sync · no upstream');
  });
});

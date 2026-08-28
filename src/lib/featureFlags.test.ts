import { describe, expect, it } from 'vitest';
import { isMissionsEnabled } from './featureFlags';
import type { WorkspaceConfig } from '../stores/projectStore';

const baseConfig: WorkspaceConfig = {
  workspaceId: 'w',
  workspaceName: 'w',
  memoryMode: 'saple',
  defaultProvider: 'codex',
  defaultModelByProvider: {},
  maxParallelAgents: 12,
  enableEditMode: true,
  verificationPresets: [],
  missionsEnabled: false,
  createdAt: '',
  updatedAt: '',
};

describe('isMissionsEnabled', () => {
  it('defaults to off when the flag is absent (legacy config)', () => {
    const legacy = { ...baseConfig } as Partial<WorkspaceConfig>;
    delete legacy.missionsEnabled;
    expect(isMissionsEnabled(legacy as WorkspaceConfig)).toBe(false);
  });

  it('defaults to off for a missing config', () => {
    expect(isMissionsEnabled(null)).toBe(false);
    expect(isMissionsEnabled(undefined)).toBe(false);
  });

  it('reads an explicit false as off and true as on', () => {
    expect(isMissionsEnabled({ ...baseConfig, missionsEnabled: false })).toBe(false);
    expect(isMissionsEnabled({ ...baseConfig, missionsEnabled: true })).toBe(true);
  });
});

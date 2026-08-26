import type { WorkspaceConfig } from '../stores/projectStore';

// Feature flags for rooms and commands that are still in development. Every flag
// defaults to off: a missing config, a legacy config without the field, or an
// explicit `false` all read as disabled. Flags gate nothing until the feature that
// consumes them ships - see docs/missions-orchestration-plan.md (Phase M0).

export const isMissionsEnabled = (config: WorkspaceConfig | null | undefined): boolean =>
  config?.missionsEnabled === true;

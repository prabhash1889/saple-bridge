import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { invoke } from '@tauri-apps/api/core';
import { createId } from '../lib/id';
import { enqueueWrite } from '../lib/writeQueue';
import type { AgentRole, AgentStatus, AgentOutcome } from '../types/agent';
import type { AgentProvider } from '../types/provider';
import type { WizardLaunchInput, ContextFileRef } from '../types/wizard';
import type { SwarmPlan, AutonomyMode } from '../types/swarmPlan';
import { useTerminalStore, getPaneSignalTail } from './terminalStore';
import { useProjectStore } from './projectStore';
import { useAgentSessionStore } from './agentSessionStore';
import { useModelCatalogStore } from './modelCatalogStore';
import { parseAgentOutcome } from '../lib/controlPlane';
import { parsePlan, diffPlan } from '../lib/swarmPlan';
import { buildAgentPrompt } from '../lib/swarmPrompts';
import { hasReviewSignal, getSwarmStatusFromOutput, exitFallbackTransition } from '../lib/agentSignals';
import { notifyAgentStatusChanged } from '../lib/desktopNotifications';

export type { AgentRole, AgentStatus } from '../types/agent';

export interface SwarmAgent {
  id: string;
  name: string;
  role: AgentRole;
  provider?: AgentProvider;
  model: string;
  systemPrompt: string; 
  dependencies: string[]; // Agent IDs that must complete first
  status: AgentStatus;
  taskId?: string;
  terminalId?: string;
  autoApprove?: boolean; // Auto-advance from 'review' to 'done' without human approval
  // Human-readable reason for the current status ("exited with code 1", "terminal lost on
  // restart", ...). Set together with the status transition that caused it; cleared on the next.
  statusReason?: string;
  // Per-agent completion-marker token. Minted at seed time and embedded in the agent's prompt so
  // its `[AGENT_DONE:<marker>]`/etc. signals can't be triggered by another pane's output or by
  // narrating the generic marker name. Absent on agents seeded before scoped markers existed —
  // those fall back to bare-marker matching.
  marker?: string;
  // P4 bounded review-and-rework. `attempt` is the 1-based number of the current/last run (unset =
  // 1). A reviewer rejection bumps it and relaunches the agent with `lastReviewFeedback` embedded in
  // the prompt (and appended to the mailbox). `maxAttempts` (default 1) is the REWORK budget: how
  // many rejections may relaunch without extra approval. Reworks past it require explicit human
  // approval, so repeated review signals can't silently loop forever.
  attempt?: number;
  maxAttempts?: number;
  lastReviewFeedback?: string;
  // Ms epoch stamped when the agent last went `running`, for the elapsed-time badge (P9). Persisted
  // in state.json so the duration survives room/project switches and restart; re-stamped on relaunch.
  startedAt?: number;
}

// P6: a durable request from a running agent (coordinator) for another specialist worker. Agents
// append these to `.saple/swarm/requests.json`; Bridge shows them, gates approval, and inserts
// approved ones through the existing scheduler. Agents record the request but never execute it.
export interface WorkerRequest {
  id: string;
  role: AgentRole;
  provider?: AgentProvider;
  model: string;
  mission: string;
  dependsOn: string[];
}

export interface SwarmTemplate {
  id: string;
  name: string;
  description: string;
  agents: Omit<SwarmAgent, 'status' | 'taskId' | 'terminalId'>[];
}

interface SwarmState {
  swarmId: string | null;
  swarmName: string;
  loadedProjectPath: string | null;
  mission: string;
  skills: string[];
  contextFiles: ContextFileRef[];
  status: 'idle' | 'running' | 'paused' | 'stopped' | 'completed' | 'failed';
  activeAgents: SwarmAgent[];
  // Swarm v2 (Phase 2). The coordinator's parsed plan (last-read snapshot), the append-only set of
  // plan task ids already materialized into the roster (dedup key for `diffPlan`), and the run's
  // autonomy/wave/limit knobs. All persisted in state.json and round-tripped through reconciliation.
  plan: SwarmPlan | null;
  appliedPlanTaskIds: string[];
  autonomy: AutonomyMode;
  wave: number;
  maxWaves: number;
  // 0 = fall back to the global pane limit; a positive value caps concurrent agents below it.
  maxParallel: number;
  templates: SwarmTemplate[];
  swarmActive: boolean;
  activeTemplateId: string | null;
  // P11: the workspace instance the running swarm's panes are pinned to (its own instance, so agent
  // terminals don't mix with the user's interactive panes). null for swarms started before P11.
  swarmWorkspaceId: string | null;
  // One-shot: the Command Palette composer requests a new swarm seeded with this mission text.
  // SwarmWorkspace consumes it on render, opens the wizard pre-filled, and clears it. Transient
  // (not persisted).
  pendingWizardMission: string | null;
  // P6: request ids Bridge has already approved or rejected. Persisted in state.json (which Bridge
  // owns exclusively) so it never has to write back the agent-owned requests.json, and so an
  // approved/rejected request can't reappear or relaunch a duplicate worker across reloads.
  resolvedWorkerRequests: string[];

  setPendingWizardMission: (mission: string | null) => void;
  loadSwarmState: (projectPath: string, force?: boolean) => Promise<void>;
  saveSwarmState: (projectPath: string) => Promise<void>;
  startSwarmFromWizard: (input: WizardLaunchInput) => Promise<void>;
  // Swarm v2 (Phase 2): mission-first launch. Seeds ONE coordinator; its plan.json materializes the
  // workers. Replaces the wizard DAG as the real launch path.
  startSwarm: (
    projectPath: string,
    mission: string,
    options?: { autonomy?: AutonomyMode; maxParallel?: number; maxWaves?: number; provider?: AgentProvider; model?: string },
  ) => Promise<void>;
  // Read `.saple/swarm/plan.json`, sanitize it, and materialize any not-yet-applied tasks as worker
  // agents wired by dependency. Idempotent (dedup on `appliedPlanTaskIds`); safe to call from the
  // coordinator's plan marker, the plan.json watcher event, or coordinator completion.
  ingestPlan: (projectPath: string) => Promise<void>;
  pauseSwarm: (projectPath: string) => Promise<void>;
  resumeSwarm: (projectPath: string) => Promise<void>;
  stopSwarm: (projectPath: string) => Promise<void>;
  updateAgentStatus: (projectPath: string, agentId: string, status: AgentStatus, extra?: Partial<SwarmAgent>) => Promise<void>;
  checkAndRunNextAgents: (projectPath: string) => Promise<void>;
  runAgentScan: (projectPath: string) => Promise<void>;
  relaunchAgent: (projectPath: string, agentId: string) => Promise<void>;
  // P4: reject an in-review agent and route it back through one bounded rework. Appends `feedback`
  // to its mailbox, records it for the relaunch prompt, bumps `attempt`, and relaunches. Returns
  // `limitReached` (with the configured `maxAttempts`) instead of relaunching when the attempt
  // budget is spent and `force` is false — the caller must get explicit human approval and retry
  // with `force: true`.
  reworkAgent: (
    projectPath: string,
    agentId: string,
    feedback: string,
    force?: boolean,
  ) => Promise<{ ok: boolean; limitReached?: boolean; maxAttempts?: number }>;
  forceCompleteAgent: (projectPath: string, agentId: string) => Promise<void>;
  addCustomAgent: (agent: SwarmAgent) => void;
  removeAgent: (agentId: string) => void;
  // P6: read the pending (unresolved, well-formed) worker requests agents have written.
  loadWorkerRequests: (projectPath: string) => Promise<WorkerRequest[]>;
  // P6: approve (insert a worker through the scheduler) or reject (dismiss) a request. Either way
  // the id is marked resolved so it can't be acted on twice.
  resolveWorkerRequest: (projectPath: string, request: WorkerRequest, approve: boolean) => Promise<void>;
  saveTemplatePreset: (template: SwarmTemplate) => void;
  writeMailbox: (projectPath: string, agentId: string, content: string) => Promise<void>;
  // Append an operator note under an agent's existing mailbox content (re-reads disk so it never
  // clobbers what the agent wrote). Returns the new full mailbox content. Shared by the Swarm room
  // composer and the Command Palette composer.
  postToMailbox: (projectPath: string, agentId: string, message: string) => Promise<string>;
  readHandoff: (projectPath: string, fromAgent: string, toAgent: string) => Promise<string | null>;
  writeHandoff: (projectPath: string, fromAgent: string, toAgent: string, content: string) => Promise<void>;
}

const DEFAULT_TEMPLATES: SwarmTemplate[] = [
  {
    id: 'full_stack',
    name: 'Full-Stack Feature Swarm',
    description: '1 Coordinator breaks down task, 2 Builders code frontend/backend, 1 Reviewer approves.',
    agents: [
      {
        id: 'coord',
        name: 'Lead Coordinator',
        role: 'coordinator',
        provider: 'codex',
        model: 'default',
        dependencies: [],
        systemPrompt: 'You are the Swarm Coordinator. Analyze the high-level request, break it down into modular frontend/backend tasks, write them to .saple/swarm/tasks.json, and coordinate builders.',
      },
      {
        id: 'fe_builder',
        name: 'Frontend Builder',
        role: 'builder',
        provider: 'codex',
        model: 'default',
        dependencies: ['coord'],
        systemPrompt: 'You are the Frontend Builder. Implement UI elements and state logic. Read your sub-task details from .saple/swarm/tasks.json, write the React code, and write tests.',
      },
      {
        id: 'be_builder',
        name: 'Backend Builder',
        role: 'builder',
        provider: 'codex',
        model: 'default',
        dependencies: ['coord'],
        systemPrompt: 'You are the Backend Builder. Implement API endpoints, database structures, and backend business logic. Read your sub-task from .saple/swarm/tasks.json.',
      },
      {
        id: 'reviewer',
        name: 'Validation Reviewer',
        role: 'reviewer',
        provider: 'codex',
        model: 'default',
        dependencies: ['fe_builder', 'be_builder'],
        systemPrompt: 'You are the Code Reviewer. Validate that both frontend and backend builders have completed their tasks, verify the code syntax and structure, run compilation tests, and signal approval.',
      }
    ]
  },
  {
    id: 'bug_hunt',
    name: 'Bug Hunt Swarm',
    description: '1 Scout investigates logs, 1 Builder fixes the issue, 1 Reviewer verifies.',
    agents: [
      {
        id: 'scout',
        name: 'Log Scout',
        role: 'scout',
        provider: 'codex',
        model: 'default',
        dependencies: [],
        systemPrompt: 'You are the Scout. Analyze error logs, find the file and lines responsible for the failure, and write detailed recommendations to .saple/swarm/bug_report.json.',
      },
      {
        id: 'bug_fixer',
        name: 'Bug Fixer',
        role: 'builder',
        provider: 'codex',
        model: 'default',
        dependencies: ['scout'],
        systemPrompt: 'You are the Bug Fixer. Read the bug report in .saple/swarm/bug_report.json and implement the corrective fix in the target code file.',
      },
      {
        id: 'verifier',
        name: 'QA Verifier',
        role: 'reviewer',
        provider: 'codex',
        model: 'default',
        dependencies: ['bug_fixer'],
        systemPrompt: 'You are the QA Verifier. Check the bug fix, run automated tests or compile checks to verify that the bug is fixed and no regressions were introduced.',
      }
    ]
  },
  {
    id: 'review_only',
    name: 'Review-Only Swarm',
    description: '1 Auditor inspects diffs, 1 Gatekeeper approves release merge.',
    agents: [
      {
        id: 'auditor',
        name: 'Security Auditor',
        role: 'reviewer',
        provider: 'codex',
        model: 'default',
        dependencies: [],
        systemPrompt: 'Inspect the git diff of the workspace for safety vulnerabilities, hardcoded credentials, or violations of project standards. Output findings in auditor_report.md.',
      },
      {
        id: 'gatekeeper',
        name: 'Release Gatekeeper',
        role: 'reviewer',
        provider: 'codex',
        model: 'default',
        dependencies: ['auditor'],
        systemPrompt: 'Read the findings in auditor_report.md. If there are no blockers, output [AGENT_DONE]. Otherwise, output [AGENT_FAILED] with mitigation instructions.',
      }
    ]
  },
  {
    id: 'scout_and_plan',
    name: 'Scout and Plan Swarm',
    description: '1 Researcher gathers files, 1 Planner writes implementation steps.',
    agents: [
      {
        id: 'researcher',
        name: 'Codebase Researcher',
        role: 'scout',
        provider: 'codex',
        model: 'default',
        dependencies: [],
        systemPrompt: 'Search the codebase, list relevant files, read their dependencies, and explain the current architecture. Save your findings in research_notes.md.',
      },
      {
        id: 'planner',
        name: 'Lead Architect Planner',
        role: 'coordinator',
        provider: 'codex',
        model: 'default',
        dependencies: ['researcher'],
        systemPrompt: 'Read research_notes.md and outline a step-by-step implementation plan.md for adding the requested feature. Ensure clear module boundaries.',
      }
    ]
  },
  {
    id: 'test_hardening',
    name: 'Test Hardening Swarm',
    description: '1 Analyzer finds test gaps, 1 Test Writer drafts tests, 1 Runner executes.',
    agents: [
      {
        id: 'analyzer',
        name: 'Coverage Analyzer',
        role: 'scout',
        provider: 'codex',
        model: 'default',
        dependencies: [],
        systemPrompt: 'Scan the project files, find files lacking tests or functions that have high complexity, and list them in gaps.json.',
      },
      {
        id: 'writer',
        name: 'Unit Test Writer',
        role: 'builder',
        provider: 'codex',
        model: 'default',
        dependencies: ['analyzer'],
        systemPrompt: 'Read gaps.json. Write comprehensive unit tests for the targeted files. Ensure mocks are set up correctly.',
      },
      {
        id: 'runner',
        name: 'Test Executable Runner',
        role: 'reviewer',
        provider: 'codex',
        model: 'default',
        dependencies: ['writer'],
        systemPrompt: 'Run the project test suite. Verify that all unit tests pass, and report coverage metrics. If errors arise, coordinate fixes.',
      }
    ]
  }
];

const VALID_ROLES: AgentRole[] = ['coordinator', 'builder', 'scout', 'reviewer'];

// Sanitize the untrusted, agent-written `.saple/swarm/requests.json` into well-formed worker
// requests. Anything missing an id or a mission is dropped, and same-id duplicates collapse to the
// first — so a malformed or partial file can never break the requests panel or launch a bad worker.
export const parseWorkerRequests = (raw: unknown): WorkerRequest[] => {
  if (!Array.isArray(raw)) return [];
  const out: WorkerRequest[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id.trim() : '';
    const mission = typeof r.mission === 'string' ? r.mission.trim() : '';
    if (!id || !mission || seen.has(id)) continue;
    seen.add(id);
    const role = VALID_ROLES.includes(r.role as AgentRole) ? (r.role as AgentRole) : 'builder';
    const provider = typeof r.provider === 'string' ? (r.provider as AgentProvider) : undefined;
    const model = typeof r.model === 'string' && r.model.trim() ? r.model.trim() : 'default';
    const dependsOn = Array.isArray(r.dependsOn)
      ? r.dependsOn.filter((d): d is string => typeof d === 'string')
      : [];
    out.push({ id, role, provider, model, mission, dependsOn });
  }
  return out;
};

// A short random token that scopes an agent's completion markers to itself. 8 hex chars is
// plenty to make accidental collisions with real output effectively impossible, while staying
// short enough to read in the terminal. Charset stays within agentSignals' MARKER_TOKEN_RE.
const createMarker = (): string => {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid.replace(/-/g, '').slice(0, 8);
  return Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
};

// P13: pty-exits for panes whose project isn't the loaded one, recorded by terminalStore and
// replayed by loadSwarmState (after the marker-tail check, which wins when both exist). In-memory
// on purpose: the switch-and-return scenario lives within one app session; across a restart the
// PTYs are dead anyway and the existing orphan reconciliation applies.
const pendingAgentExits = new Map<string, Map<string, number | null | undefined>>();

export const recordPendingAgentExit = (
  projectPath: string,
  terminalId: string,
  exitCode: number | null | undefined,
): void => {
  const forProject = pendingAgentExits.get(projectPath) ?? new Map();
  forProject.set(terminalId, exitCode);
  pendingAgentExits.set(projectPath, forProject);
};

const consumePendingAgentExits = (projectPath: string) => {
  const forProject = pendingAgentExits.get(projectPath) ?? new Map<string, number | null | undefined>();
  pendingAgentExits.delete(projectPath);
  return forProject;
};

// Serializes checkAndRunNextAgents: it awaits saves mid-scan, and a PTY-driven
// updateAgentStatus arriving during that await would re-enter with the same stale snapshot and
// launch the same agent's PTY + prompt file twice. Concurrent triggers coalesce into one queued
// re-run that re-reads fresh state.
let agentScanInFlight = false;
let agentScanQueued = false;

const launchAgentProcess = async (projectPath: string, agent: SwarmAgent) => {
  const { updateAgentStatus } = useSwarmStore.getState();
  try {
    await updateAgentStatus(projectPath, agent.id, 'starting');

    const { mission, skills, contextFiles } = useSwarmStore.getState();

    // Coordinators get the plan-contract brief; workers get their own systemPrompt (the plan task
    // mission) as the assignment. Built in swarmPrompts.ts (Phase 2).
    const promptContent = buildAgentPrompt(agent, { mission, skills, contextFiles });

    const promptFile = `.saple/agents/prompts/swarm_${agent.id}.md`;
    await invoke('write_project_file', {
      projectPath,
      filePath: promptFile,
      content: promptContent
    });

    // Clear any stale structured outcome from a previous attempt: if this relaunch finishes
    // without writing its own outcome, completion must not pick up the old attempt's file.
    // `{}` parses to "no outcome" (parseAgentOutcome returns null). Best-effort.
    await invoke('write_project_file', {
      projectPath,
      filePath: `.saple/swarm/outcomes/${agent.id}.json`,
      content: '{}',
    }).catch(() => {});

    // 1. Spawn terminal pane. spawn_pty launches the provider CLI with this prompt
    // file piped in, so no separate launch command is written to the PTY.
    const provider = agent.provider || 'codex';
    // Remember the launched model so the picker resurfaces it next time (P8).
    useModelCatalogStore.getState().recordUsed(provider, agent.model);
    // P11: pin the pane to the swarm's own workspace instance so it doesn't land in whatever
    // instance the user currently has active.
    const swarmWorkspaceId = useSwarmStore.getState().swarmWorkspaceId || undefined;
    const paneId = await useTerminalStore.getState().addPane(projectPath, provider, agent.model, promptFile, undefined, swarmWorkspaceId);

    // 2. Set terminal metadata
    useTerminalStore.getState().updateSession(paneId, {
      name: `${agent.name} (${agent.role.toUpperCase()})`
    });

    // 3. Link agent status to terminal ID and set session ID
    const session = await useAgentSessionStore.getState().createSession({
      projectPath,
      name: agent.name,
      cwd: projectPath,
      provider: provider,
      model: agent.model,
      role: agent.role,
      swarmId: useSwarmStore.getState().swarmId || undefined,
      terminalId: paneId,
    });

    await updateAgentStatus(projectPath, agent.id, 'running', { terminalId: paneId, taskId: session.id, startedAt: Date.now() });
  } catch (error) {
    console.error(`Failed to launch agent ${agent.id}:`, error);
    await updateAgentStatus(projectPath, agent.id, 'failed', { statusReason: `Launch failed: ${error}` });
  }
};

export const useSwarmStore = create<SwarmState>()(
  persist(
    (set, get) => ({
      swarmId: null,
      swarmName: '',
      loadedProjectPath: null,
      mission: '',
      skills: [],
      contextFiles: [],
      status: 'idle',
      activeAgents: [],
      plan: null,
      appliedPlanTaskIds: [],
      autonomy: 'gated',
      wave: 1,
      maxWaves: 3,
      maxParallel: 0,
      templates: DEFAULT_TEMPLATES,
      swarmActive: false,
      activeTemplateId: null,
      swarmWorkspaceId: null,
      pendingWizardMission: null,
      resolvedWorkerRequests: [],

      setPendingWizardMission: (mission) => set({ pendingWizardMission: mission }),

      loadSwarmState: async (projectPath, force = false) => {
        // loadedProjectPath is rehydrated from localStorage (persist), so without `force`
        // reopening a project would skip re-reading .saple/swarm/state.json and discard
        // external/MCP edits. The project-open flow passes force=true to always re-read disk.
        if (!force && get().loadedProjectPath === projectPath) return;

        // P11: a swarm launch now switches workspace instance, which fires App's workspace-change
        // force-reload while the launch is still in flight. Re-reading disk mid-launch could
        // reconcile a just-'starting' agent (its pane hasn't spawned yet, so it looks orphaned)
        // into 'failed'. While an agent of the currently-loaded same-path swarm is 'starting', a
        // launch is in flight and in-memory state is the fresher writer, so skip the reload.
        // Cross-project recovery (P13) is unaffected: there loadedProjectPath points at the other
        // project, so this guard doesn't trigger.
        if (get().loadedProjectPath === projectPath && get().activeAgents.some((a) => a.status === 'starting')) {
          return;
        }
        try {
          const content = await invoke<string>('read_swarm_state', { projectPath });
          const parsed = JSON.parse(content);

          // Crash/restart reconciliation: state.json can say an agent is running while its PTY
          // no longer exists (app restarted mid-run). Left alone, those zombies stay "running"
          // forever and dependents never start. Downgrade them to failed (Relaunch stays one
          // click away) and pause a running swarm so continuing is a deliberate Resume.
          //
          // P13, checked first: an agent may have FINISHED while this project wasn't loaded — its
          // signal was dropped by the live handlers on purpose. Recover it here instead of failing
          // it: the scoped marker still sits in the pane's rolling signal tail (fast path), and a
          // pty-exit that fired while away was recorded as a pending exit (safety net). Recovered
          // transitions run through updateAgentStatus below so completion side effects (outcome
          // artifacts, run close-out, scheduler advance) all fire exactly as if the user had been
          // watching.
          const loadedAgents: SwarmAgent[] = parsed.agents || [];
          const liveSessions = useTerminalStore.getState().sessions;
          const pendingExits = consumePendingAgentExits(projectPath);
          let orphaned = false;
          const recovered: Array<{ agentId: string; status: AgentStatus; statusReason?: string }> = [];
          const reconciledAgents = loadedAgents.map((agent) => {
            if (agent.status !== 'running' && agent.status !== 'starting') return agent;
            if (agent.terminalId) {
              const tail = getPaneSignalTail(agent.terminalId);
              if (tail) {
                const scopedReview = hasReviewSignal(tail, agent.marker);
                const recoveredStatus = getSwarmStatusFromOutput(tail, scopedReview, agent.marker);
                if (recoveredStatus) {
                  recovered.push({ agentId: agent.id, status: recoveredStatus });
                  return agent;
                }
              }
              if (pendingExits.has(agent.terminalId)) {
                const transition = exitFallbackTransition(pendingExits.get(agent.terminalId));
                recovered.push({ agentId: agent.id, ...transition });
                return agent;
              }
              if (liveSessions[agent.terminalId]) return agent;
            }
            orphaned = true;
            return {
              ...agent,
              status: 'failed' as AgentStatus,
              terminalId: undefined,
              statusReason: 'Agent terminal was lost (app restarted mid-run) — relaunch to continue.',
            };
          });
          const loadedStatus = parsed.status || 'idle';
          const status = orphaned && loadedStatus === 'running' ? 'paused' : loadedStatus;

          set({
            loadedProjectPath: projectPath,
            swarmId: parsed.swarmId || null,
            swarmName: parsed.swarmName || '',
            mission: parsed.mission || '',
            skills: parsed.skills || [],
            contextFiles: parsed.contextFiles || [],
            status,
            swarmActive: status === 'running' || status === 'paused',
            activeTemplateId: parsed.templateId || null,
            swarmWorkspaceId: parsed.swarmWorkspaceId || null,
            resolvedWorkerRequests: parsed.resolvedWorkerRequests || [],
            plan: parsed.plan || null,
            appliedPlanTaskIds: parsed.appliedPlanTaskIds || [],
            autonomy: parsed.autonomy || 'gated',
            wave: parsed.wave || 1,
            maxWaves: parsed.maxWaves || 3,
            maxParallel: parsed.maxParallel || 0,
            activeAgents: reconciledAgents,
          });
          if (orphaned) {
            await get().saveSwarmState(projectPath);
          }
          // P13: replay recovered transitions now that this project's agents are loaded. Each one
          // persists, notifies, closes out the run/outcome, and advances dependents.
          for (const r of recovered) {
            await get().updateAgentStatus(
              projectPath,
              r.agentId,
              r.status,
              r.statusReason ? { statusReason: r.statusReason } : undefined,
            );
          }
        } catch {
          // Reset if file not found
          set({ loadedProjectPath: projectPath, activeAgents: [], swarmActive: false, status: 'idle', swarmId: null, swarmName: '', mission: '', skills: [], contextFiles: [], activeTemplateId: null, swarmWorkspaceId: null, resolvedWorkerRequests: [], plan: null, appliedPlanTaskIds: [], autonomy: 'gated', wave: 1, maxWaves: 3, maxParallel: 0 });
        }
        // P1: follow this project's swarm dir with the Rust watcher so mailbox/handoff/outcome/plan
        // edits push into the room in ms instead of being polled. No-ops when the dir doesn't exist
        // yet (no swarm has run here); re-armed on the next load once it does.
        void invoke('watch_swarm_dir', { projectPath }).catch(() => {});
      },

      saveSwarmState: async (projectPath) => {
        try {
          const state = {
            swarmId: get().swarmId,
            swarmName: get().swarmName,
            mission: get().mission,
            skills: get().skills,
            contextFiles: get().contextFiles,
            templateId: get().activeTemplateId,
            swarmWorkspaceId: get().swarmWorkspaceId,
            resolvedWorkerRequests: get().resolvedWorkerRequests,
            plan: get().plan,
            appliedPlanTaskIds: get().appliedPlanTaskIds,
            autonomy: get().autonomy,
            wave: get().wave,
            maxWaves: get().maxWaves,
            maxParallel: get().maxParallel,
            agents: get().activeAgents,
            status: get().status,
            active: get().status === 'running' || get().status === 'paused'
          };
          // Serialized per project: the scheduler can fire several saves in one tick.
          await enqueueWrite(`swarm:${projectPath}`, () =>
            invoke('write_swarm_state', {
              projectPath,
              stateJson: JSON.stringify(state, null, 2)
            })
          );
        } catch (error) {
          console.error('Failed to save swarm state:', error);
        }
      },

      startSwarmFromWizard: async (input) => {
        const { projectPath, swarmName, mission, agents, skills, contextFiles, templateId } = input;

        // Initialize directories (.saple/swarm/context included).
        try {
          await invoke('ensure_workspace_dirs', { projectPath });
        } catch (error) {
          console.error('Failed to ensure workspace dirs:', error);
        }

        // Persist attached context files into .saple/swarm/context/ at launch.
        const writtenContext: ContextFileRef[] = [];
        for (const file of contextFiles) {
          const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
          const filePath = `.saple/swarm/context/${safeName}`;
          try {
            await invoke('write_project_file', { projectPath, filePath, content: file.content });
            writtenContext.push({ name: file.name, path: filePath });
          } catch (err) {
            console.error(`Failed to write context file ${file.name}:`, err);
          }
        }

        // P11: give the swarm its own workspace instance of the same folder so its agent panes don't
        // mix with the user's interactive terminals. Same path means every store and the lifecycle
        // signal handling stay loaded when the user flips between the two instances. The id is pinned
        // onto each launched pane (see launchAgentProcess) so late dependent agents still land here
        // even after the user has switched back to their own instance.
        const project = useProjectStore.getState();
        await project.addWorkspace(projectPath);
        const swarmWorkspaceId = useProjectStore.getState().currentWorkspaceId;
        if (swarmWorkspaceId) {
          const base = projectPath.split(/[\\/]/).pop() || projectPath;
          project.renameWorkspace(swarmWorkspaceId, `${base} (swarm)`);
        }

        // Seed run-state for each roster agent (drop wizard-only `expanded`).
        const seededAgents: SwarmAgent[] = agents.map((a) => ({
          id: a.id,
          name: a.name,
          role: a.role,
          provider: a.provider,
          model: a.model,
          systemPrompt: a.systemPrompt,
          dependencies: a.dependencies,
          autoApprove: a.autoApprove,
          marker: createMarker(),
          status: a.dependencies.length > 0 ? 'waiting' : ('idle' as AgentStatus),
        }));

        set({
          swarmId: createId('swarm'),
          swarmName,
          mission,
          skills,
          contextFiles: writtenContext,
          activeTemplateId: templateId ?? 'custom',
          activeAgents: seededAgents,
          status: 'running',
          swarmActive: true,
          loadedProjectPath: projectPath,
          swarmWorkspaceId,
          resolvedWorkerRequests: [],
        });

        await get().saveSwarmState(projectPath);
        await get().checkAndRunNextAgents(projectPath);
      },

      startSwarm: async (projectPath, mission, options = {}) => {
        const {
          autonomy = 'gated',
          maxParallel = 0,
          maxWaves = 3,
          provider = 'codex',
          model = 'default',
        } = options;

        try {
          await invoke('ensure_workspace_dirs', { projectPath });
        } catch (error) {
          console.error('Failed to ensure workspace dirs:', error);
        }

        // P11: give the swarm its own workspace instance so its agent panes don't mix with the
        // user's interactive terminals (same flow as startSwarmFromWizard).
        const project = useProjectStore.getState();
        await project.addWorkspace(projectPath);
        const swarmWorkspaceId = useProjectStore.getState().currentWorkspaceId;
        if (swarmWorkspaceId) {
          const base = projectPath.split(/[\\/]/).pop() || projectPath;
          project.renameWorkspace(swarmWorkspaceId, `${base} (swarm)`);
        }

        // Seed ONE coordinator. Its plan.json materializes every worker (see ingestPlan); the
        // wizard DAG is gone. A fresh marker scopes its PLAN_READY/PLAN_UPDATED/AGENT_DONE signals.
        const coordinator: SwarmAgent = {
          id: 'coordinator',
          name: 'Coordinator',
          role: 'coordinator',
          provider,
          model,
          systemPrompt: 'You are the Swarm Coordinator. Decompose the mission into a plan.',
          dependencies: [],
          marker: createMarker(),
          status: 'idle',
        };

        set({
          swarmId: createId('swarm'),
          swarmName: 'Swarm',
          mission,
          skills: [],
          contextFiles: [],
          activeTemplateId: null,
          activeAgents: [coordinator],
          plan: null,
          appliedPlanTaskIds: [],
          autonomy,
          wave: 1,
          maxWaves,
          maxParallel,
          status: 'running',
          swarmActive: true,
          loadedProjectPath: projectPath,
          swarmWorkspaceId,
          resolvedWorkerRequests: [],
        });

        await get().saveSwarmState(projectPath);
        await get().checkAndRunNextAgents(projectPath);
      },

      ingestPlan: async (projectPath) => {
        // Only the loaded project's swarm materializes here; an away-project plan is picked up when
        // its swarm loads. Guards a watcher/marker event that fires just after a project switch.
        if (get().loadedProjectPath !== projectPath) return;

        let plan: SwarmPlan;
        try {
          const raw = await invoke<string>('read_project_file', {
            projectPath,
            filePath: '.saple/swarm/plan.json',
          });
          plan = parsePlan(JSON.parse(raw));
        } catch {
          return; // no plan written yet (the common case before PLAN_READY) or unreadable
        }

        const newTasks = diffPlan(get().appliedPlanTaskIds, plan);
        if (newTasks.length === 0) {
          set({ plan }); // keep the latest snapshot even when nothing new to apply
          return;
        }

        // Map plan task ids -> agent ids. Seed with tasks already materialized in earlier waves,
        // then pre-assign ids for this batch so a task depending on a sibling later in the same
        // plan still resolves (parsePlan preserves input order, not topological order).
        const taskToAgent = new Map<string, string>();
        for (const a of get().activeAgents) if (a.taskId) taskToAgent.set(a.taskId, a.id);
        const ids = newTasks.map(() => createId('agent'));
        newTasks.forEach((task, i) => taskToAgent.set(task.id, ids[i]));

        // `provider: "auto"` resolves to the coordinator's provider for now (the Phase 6 subscription
        // assigner refines this); an explicit provider is kept verbatim.
        const coordinatorProvider = get().activeAgents.find((a) => a.role === 'coordinator')?.provider;

        const materialized: SwarmAgent[] = newTasks.map((task, i) => {
          const dependencies = task.dependsOn
            .map((d) => taskToAgent.get(d))
            .filter((x): x is string => !!x);
          return {
            id: ids[i],
            taskId: task.id,
            name: `${task.role.charAt(0).toUpperCase()}${task.role.slice(1)}: ${task.id}`,
            role: task.role,
            provider: task.provider === 'auto' ? coordinatorProvider : (task.provider as AgentProvider),
            model: task.model,
            systemPrompt: task.mission,
            dependencies,
            marker: createMarker(),
            maxAttempts: 1,
            status: dependencies.length > 0 ? 'waiting' : 'idle',
          };
        });

        set((state) => ({
          plan,
          activeAgents: [...state.activeAgents, ...materialized],
          appliedPlanTaskIds: [...state.appliedPlanTaskIds, ...newTasks.map((t) => t.id)],
        }));
        await get().saveSwarmState(projectPath);
        await get().checkAndRunNextAgents(projectPath);
      },

      pauseSwarm: async (projectPath) => {
        set({ status: 'paused' });
        await get().saveSwarmState(projectPath);
      },

      resumeSwarm: async (projectPath) => {
        set({ status: 'running' });
        await get().saveSwarmState(projectPath);
        await get().checkAndRunNextAgents(projectPath);
      },

      stopSwarm: async (projectPath) => {
        // Deactivate BEFORE tearing panes down: the removePane awaits below yield to PTY-output
        // handlers, and a concurrent [AGENT_DONE] -> checkAndRunNextAgents must see the swarm as
        // stopped or it launches a fresh agent mid-shutdown, outside the kill list.
        set({
          swarmId: null,
          status: 'stopped',
          swarmActive: false,
          activeAgents: get().activeAgents.map(a => ({ ...a, status: 'stopped' }))
        });

        // Kill linked terminals
        const activePanes = get().activeAgents.filter(a => a.terminalId).map(a => a.terminalId!);
        for (const paneId of activePanes) {
          try {
            await useTerminalStore.getState().removePane(paneId);
          } catch (e) {
            console.error('Error removing terminal pane:', e);
          }
        }

        await get().saveSwarmState(projectPath);
      },

      updateAgentStatus: async (projectPath, agentId, status, extra) => {
        // Auto-approve: an agent that requests review but is flagged auto-approve
        // advances straight to 'done' so dependents unblock without manual sign-off.
        const previousAgent = get().activeAgents.find(a => a.id === agentId);

        // Coordinator completion containment (Phase 2): before treating the coordinator's
        // done/review as terminal, make sure its plan has been ingested (a plan written right
        // before the marker/exit must not be missed). If it never produced a valid task, park it
        // in 'review' — relaunching the coordinator retries planning — instead of a silent finish.
        if (previousAgent?.role === 'coordinator' && (status === 'done' || status === 'review')) {
          await get().ingestPlan(projectPath);
          if (get().appliedPlanTaskIds.length === 0) {
            status = 'review';
            extra = { ...extra, statusReason: 'Planning produced no valid tasks — relaunch to retry planning.' };
          } else {
            // Planning succeeded: the coordinator is done whether it printed AGENT_DONE or just
            // exited cleanly after writing the plan (Phase 2 fire-and-forget; Phase 3 keeps it
            // live). Its own completion never needs a human click — the plan is the deliverable.
            status = 'done';
          }
        }

        let effectiveStatus = status;
        if (status === 'review') {
          if (previousAgent?.autoApprove) {
            effectiveStatus = 'done';
          }
        }
        set(state => ({
          activeAgents: state.activeAgents.map(a =>
            // statusReason belongs to one transition; reset it unless this one supplies its own.
            a.id === agentId ? { ...a, status: effectiveStatus, statusReason: undefined, ...extra } : a
          )
        }));
        if (
          previousAgent &&
          previousAgent.status !== effectiveStatus &&
          (effectiveStatus === 'done' || effectiveStatus === 'failed')
        ) {
          notifyAgentStatusChanged(previousAgent.name, effectiveStatus);
        }
        // P0: mirror the swarm agent's terminal/review transition onto its canonical run so the
        // run is finished (done/failed) or advanced to review — routed through the same session the
        // launch created, found by the agent's terminal pane. Outcome artifacts (P3) flow in from
        // agents via MCP; here we just close the run.
        if (
          previousAgent &&
          previousAgent.status !== effectiveStatus &&
          (effectiveStatus === 'done' || effectiveStatus === 'failed' || effectiveStatus === 'review')
        ) {
          const linkedSession = previousAgent.terminalId
            ? useAgentSessionStore.getState().getSessionByTerminalId(previousAgent.terminalId)
            : undefined;
          if (linkedSession) {
            // P3: pick up a structured outcome the agent may have written to its known outcome
            // path, so the run's summary + test result become artifacts Review and the swarm card
            // display. Absent/garbage file → marker-only fallback (parseAgentOutcome returns null).
            let outcome: AgentOutcome | undefined;
            try {
              const raw = await invoke<string>('read_project_file', {
                projectPath,
                filePath: `.saple/swarm/outcomes/${agentId}.json`,
              });
              outcome = parseAgentOutcome(JSON.parse(raw)) ?? undefined;
            } catch {
              // no outcome file written — the common case
            }
            void useAgentSessionStore
              .getState()
              .completeSession(projectPath, linkedSession.id, effectiveStatus, outcome);
          }
        }
        await get().saveSwarmState(projectPath);
        await get().checkAndRunNextAgents(projectPath);
      },

      checkAndRunNextAgents: async (projectPath) => {
        if (agentScanInFlight) {
          agentScanQueued = true;
          return;
        }
        agentScanInFlight = true;
        try {
          await get().runAgentScan(projectPath);
        } finally {
          agentScanInFlight = false;
          if (agentScanQueued) {
            agentScanQueued = false;
            void get().checkAndRunNextAgents(projectPath);
          }
        }
      },

      // The actual dependency scan. Only ever called via checkAndRunNextAgents' guard.
      runAgentScan: async (projectPath) => {
        const { activeAgents, status, swarmActive } = get();
        if (!swarmActive || status !== 'running') return;

        // The scan decides transitions against a local working copy, then commits them onto LIVE
        // state by agent id — never by writing back the whole captured array. A launchAgentProcess
        // kicked off below is NOT awaited: it advances its own agent to 'running' (with a
        // terminalId) via a functional set during our awaits. Overwriting state with the snapshot
        // captured here would revert that to 'starting' and drop the terminalId, so the agent's
        // completion marker (matched by terminalId) never lands and it — plus every dependent —
        // hangs until a restart reconciles it. Each pending change is applied once and then
        // dropped, so a later commit can't re-stamp 'starting' over an agent already running.
        const working = [...activeAgents];
        let pending = new Map<string, Partial<SwarmAgent>>();
        const commit = async () => {
          if (pending.size === 0) return;
          const changes = pending;
          pending = new Map();
          set(state => ({
            activeAgents: state.activeAgents.map(a =>
              changes.has(a.id) ? { ...a, ...changes.get(a.id) } : a
            ),
          }));
          await get().saveSwarmState(projectPath);
        };

        // 1. Mark dependents as blocked if any dependency failed or is blocked
        let changedBlocked = true;
        while (changedBlocked) {
          changedBlocked = false;
          for (let i = 0; i < working.length; i++) {
            const agent = working[i];
            if (agent.status !== 'blocked' && agent.status !== 'failed' && agent.status !== 'done') {
              const hasFailedDependency = agent.dependencies.some(depId => {
                const depAgent = working.find(a => a.id === depId);
                return depAgent && (depAgent.status === 'failed' || depAgent.status === 'blocked');
              });
              if (hasFailedDependency) {
                working[i] = { ...agent, status: 'blocked' };
                pending.set(agent.id, { status: 'blocked' });
                changedBlocked = true;
              }
            }
          }
        }

        // 2. Check general completion
        const allCompleted = working.every(a => a.status === 'done');
        const anyFailedOrBlocked = working.some(a => a.status === 'failed' || a.status === 'blocked');
        const allFinished = working.every(a => ['done', 'failed', 'blocked', 'stopped'].includes(a.status));

        if (allCompleted) {
          await commit();
          set({ status: 'completed' });
          await get().saveSwarmState(projectPath);
          return;
        } else if (allFinished && anyFailedOrBlocked) {
          await commit();
          set({ status: 'failed' });
          await get().saveSwarmState(projectPath);
          return;
        }

        // 3. Start agents whose dependencies are all done, bounded by the configured
        // parallel-agent limit. Without this cap a wide swarm (many dependency-ready agents)
        // would spawn every CLI at once, blowing past maxParallelAgents and swamping the machine.
        // Over-limit agents stay 'waiting'/'idle' and launch on a later scan — each completion
        // fires checkAndRunNextAgents, which frees a slot and picks up the next one.
        // The swarm's own cap when set (Phase 2 `maxParallel`), else the global pane limit.
        const maxParallel = get().maxParallel || useTerminalStore.getState().getMaxPaneLimit();
        let activeCount = working.filter(a => a.status === 'starting' || a.status === 'running').length;
        for (let i = 0; i < working.length; i++) {
          if (activeCount >= maxParallel) break;
          const agent = working[i];
          if (agent.status === 'waiting' || agent.status === 'idle') {
            const allDepsDone = agent.dependencies.every(depId => {
              const depAgent = working.find(a => a.id === depId);
              return depAgent && depAgent.status === 'done';
            });

            if (allDepsDone) {
              working[i] = { ...agent, status: 'starting' };
              pending.set(agent.id, { status: 'starting' });
              activeCount++;

              // Commit 'starting' (plus any pending blocks) and persist BEFORE launching, so the
              // pane shows as starting immediately; then kick off the unawaited async launch.
              await commit();

              launchAgentProcess(projectPath, agent).catch(err => {
                console.error(`Error launching agent ${agent.id}:`, err);
              });
            }
          }
        }

        // Flush any leftover changes (e.g. blocks with no launches this scan).
        await commit();
      },

      relaunchAgent: async (projectPath, agentId) => {
        const agent = get().activeAgents.find(a => a.id === agentId);
        if (!agent) return;

        // Reset state BEFORE killing the old terminal: the kill fires a pty-exit event, and the
        // exit fallback in terminalStore must not find this agent still linked to the dying pane
        // (it would mark it failed mid-relaunch). Clearing terminalId first makes that lookup miss.
        set(state => {
          const resetAgents = state.activeAgents.map(a => {
            if (a.id === agentId) {
              return { ...a, status: 'starting' as AgentStatus, terminalId: undefined, taskId: undefined, statusReason: undefined };
            }
            // If another agent had a dependency on this one and was blocked, reset it to waiting/idle
            if (a.status === 'blocked' && a.dependencies.includes(agentId)) {
              return { ...a, status: 'waiting' as AgentStatus };
            }
            return a;
          });
          return { activeAgents: resetAgents };
        });

        if (agent.terminalId) {
          try {
            await useTerminalStore.getState().removePane(agent.terminalId);
          } catch (e) {
            console.error('Failed to kill terminal on relaunch:', e);
          }
        }

        await get().saveSwarmState(projectPath);
        
        const freshAgent = get().activeAgents.find(a => a.id === agentId);
        if (freshAgent) {
          await launchAgentProcess(projectPath, freshAgent);
        }
      },

      reworkAgent: async (projectPath, agentId, feedback, force = false) => {
        const agent = get().activeAgents.find(a => a.id === agentId);
        if (!agent) return { ok: false };
        const attempt = agent.attempt ?? 1;
        const maxAttempts = agent.maxAttempts ?? 1;
        // `maxAttempts` budgets REWORKS, not total runs: attempt 1 is the initial run, so with the
        // default budget of 1 the first rejection relaunches freely and the second is the
        // "automatically exceeding maxAttempts" case, gated behind explicit human approval
        // instead of silently looping.
        const reworksUsed = attempt - 1;
        if (reworksUsed >= maxAttempts && !force) {
          return { ok: false, limitReached: true, maxAttempts };
        }
        const trimmed = feedback.trim();
        const nextAttempt = attempt + 1;
        if (trimmed) {
          // Land the feedback in the builder's mailbox so the relaunched agent (and the operator)
          // can read it there in addition to the prompt section.
          await get().postToMailbox(
            projectPath,
            agentId,
            `Review feedback (rework attempt ${nextAttempt}):\n\n${trimmed}`,
          );
        }
        set(state => ({
          activeAgents: state.activeAgents.map(a =>
            a.id === agentId
              ? { ...a, attempt: nextAttempt, lastReviewFeedback: trimmed || a.lastReviewFeedback }
              : a
          ),
        }));
        // relaunchAgent rebuilds the prompt from the (now feedback-carrying) agent and resets any
        // dependents that had blocked on this one — the same "previous context + feedback" retry.
        await get().relaunchAgent(projectPath, agentId);
        return { ok: true };
      },

      forceCompleteAgent: async (projectPath, agentId) => {
        await get().updateAgentStatus(projectPath, agentId, 'done');
      },

      addCustomAgent: (agent) => {
        // Ensure every agent carries a completion-marker token even when added outside the wizard.
        const withMarker = agent.marker ? agent : { ...agent, marker: createMarker() };
        set(state => ({
          activeAgents: [...state.activeAgents, withMarker]
        }));
      },

      removeAgent: (agentId) => {
        set(state => ({
          activeAgents: state.activeAgents.filter(a => a.id !== agentId)
        }));
      },

      loadWorkerRequests: async (projectPath) => {
        let parsed: WorkerRequest[] = [];
        try {
          const raw = await invoke<string>('read_project_file', {
            projectPath,
            filePath: '.saple/swarm/requests.json',
          });
          parsed = parseWorkerRequests(JSON.parse(raw));
        } catch {
          return []; // no requests file yet (the common case) or unreadable
        }
        const resolved = new Set(get().resolvedWorkerRequests);
        return parsed.filter((r) => !resolved.has(r.id));
      },

      resolveWorkerRequest: async (projectPath, request, approve) => {
        // Idempotent: a duplicate approval (double-click, re-poll) can't insert a second worker.
        if (get().resolvedWorkerRequests.includes(request.id)) return;

        if (approve) {
          // The request's own id is the dedup key; the roster agent gets a fresh unique id so a
          // request id that happens to collide with an existing agent can't corrupt the roster.
          const existingIds = new Set(get().activeAgents.map((a) => a.id));
          // Unknown dependencies would strand the worker as permanently 'waiting', so keep only
          // dependsOn entries that name a real agent already in the swarm.
          const dependencies = request.dependsOn.filter((d) => existingIds.has(d));
          const worker: SwarmAgent = {
            id: createId('agent'),
            name: `${request.role.charAt(0).toUpperCase()}${request.role.slice(1)} (requested)`,
            role: request.role,
            provider: request.provider,
            model: request.model,
            systemPrompt: request.mission,
            dependencies,
            marker: createMarker(),
            maxAttempts: 1,
            status: dependencies.length > 0 ? 'waiting' : 'idle',
          };
          set((state) => ({
            activeAgents: [...state.activeAgents, worker],
            resolvedWorkerRequests: [...state.resolvedWorkerRequests, request.id],
          }));
          await get().saveSwarmState(projectPath);
          // The scheduler enforces provider launch + the parallel-agent cap; an idle/ready worker
          // starts on this scan, an over-limit or dependency-waiting one on a later one.
          await get().checkAndRunNextAgents(projectPath);
        } else {
          set((state) => ({
            resolvedWorkerRequests: [...state.resolvedWorkerRequests, request.id],
          }));
          await get().saveSwarmState(projectPath);
        }
      },

      saveTemplatePreset: (template) => {
        set(state => {
          const index = state.templates.findIndex(t => t.id === template.id);
          const newTemplates = [...state.templates];
          if (index !== -1) {
            newTemplates[index] = template;
          } else {
            newTemplates.push(template);
          }
          return { templates: newTemplates };
        });
      },

      // Operator-posted message into an agent's mailbox. Agents read their own mailbox via
      // their FS tools; this lets a human inject guidance mid-run. Path-contained by the
      // `write_mailbox_file` command. Serialized per project so it can't race the scheduler.
      writeMailbox: async (projectPath, agentId, content) => {
        await enqueueWrite(`mailbox:${projectPath}:${agentId}`, () =>
          invoke('write_mailbox_file', { projectPath, agentId, content })
        );
      },

      postToMailbox: async (projectPath, agentId, message) => {
        const trimmed = message.trim();
        if (!trimmed) return '';
        // Read the current mailbox from disk (source of truth) so we append rather than clobber.
        // Missing file -> the command errors -> treat as empty.
        let existing = '';
        try {
          existing = await invoke<string>('read_mailbox_file', { projectPath, agentId });
        } catch {
          existing = '';
        }
        const stamp = `\n\n---\n**Operator message:**\n\n${trimmed}\n`;
        const next = existing ? `${existing.replace(/\s+$/, '')}${stamp}` : stamp.trimStart();
        await get().writeMailbox(projectPath, agentId, next);
        return next;
      },

      // Read a from→to handoff file. Returns null when the file doesn't exist yet (the
      // command errors in that case), so callers can poll candidate pairs without spamming
      // the console for handoffs that simply haven't been written.
      readHandoff: async (projectPath, fromAgent, toAgent) => {
        try {
          return await invoke<string>('read_handoff_file', { projectPath, fromAgent, toAgent });
        } catch {
          return null;
        }
      },

      writeHandoff: async (projectPath, fromAgent, toAgent, content) => {
        await enqueueWrite(`handoff:${projectPath}:${fromAgent}:${toAgent}`, () =>
          invoke('write_handoff_file', { projectPath, fromAgent, toAgent, content })
        );
      }
    }),
    {
      name: 'saple-bridge-swarm-store-v2',
      // Persist only what localStorage is the source of truth for: user template presets and
      // the last template choice. Run state (agents, mission, status) is re-read from
      // .saple/swarm/state.json on every project open (loadSwarmState force=true), and
      // persisting it all — long system prompts included — risks QuotaExceededError, which
      // silently breaks persistence entirely.
      partialize: (state) => ({
        templates: state.templates,
        activeTemplateId: state.activeTemplateId,
      }),
    }
  )
);

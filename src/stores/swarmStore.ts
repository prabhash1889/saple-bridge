import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { invoke } from '@tauri-apps/api/core';
import { createId } from '../lib/id';
import { enqueueWrite } from '../lib/writeQueue';
import type { AgentRole, AgentStatus } from '../types/agent';
import type { AgentProvider } from '../types/provider';
import type { WizardLaunchInput, ContextFileRef } from '../types/wizard';
import { SWARM_SKILLS } from '../components/swarm/wizard/skills';
import { useTerminalStore } from './terminalStore';
import { useAgentSessionStore } from './agentSessionStore';
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
  templates: SwarmTemplate[];
  swarmActive: boolean;
  activeTemplateId: string | null;

  loadSwarmState: (projectPath: string, force?: boolean) => Promise<void>;
  saveSwarmState: (projectPath: string) => Promise<void>;
  startSwarmFromWizard: (input: WizardLaunchInput) => Promise<void>;
  pauseSwarm: (projectPath: string) => Promise<void>;
  resumeSwarm: (projectPath: string) => Promise<void>;
  stopSwarm: (projectPath: string) => Promise<void>;
  updateAgentStatus: (projectPath: string, agentId: string, status: AgentStatus, extra?: Partial<SwarmAgent>) => Promise<void>;
  checkAndRunNextAgents: (projectPath: string) => Promise<void>;
  runAgentScan: (projectPath: string) => Promise<void>;
  relaunchAgent: (projectPath: string, agentId: string) => Promise<void>;
  forceCompleteAgent: (projectPath: string, agentId: string) => Promise<void>;
  addCustomAgent: (agent: SwarmAgent) => void;
  removeAgent: (agentId: string) => void;
  saveTemplatePreset: (template: SwarmTemplate) => void;
  writeMailbox: (projectPath: string, agentId: string, content: string) => Promise<void>;
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

// A short random token that scopes an agent's completion markers to itself. 8 hex chars is
// plenty to make accidental collisions with real output effectively impossible, while staying
// short enough to read in the terminal. Charset stays within agentSignals' MARKER_TOKEN_RE.
const createMarker = (): string => {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid.replace(/-/g, '').slice(0, 8);
  return Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
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

    // Inject active swarm skills (global) into every agent's brief.
    const activeSkills = SWARM_SKILLS.filter((s) => skills.includes(s.id));
    const skillsSection = activeSkills.length > 0
      ? `\n## Active Swarm Skills\n${activeSkills.map((s) => `- **${s.label}:** ${s.promptText}`).join('\n')}\n`
      : '';
    const contextSection = contextFiles.length > 0
      ? `\n## Provided Context Files\nRead these files for additional context:\n${contextFiles.map((f) => `- ${f.path}`).join('\n')}\n`
      : '';

    // Scope this agent's completion markers to its own token so its status can't be flipped by
    // another pane's output or by echoing the generic marker name. Older agents (restored from a
    // pre-marker state.json) have no token — they keep using the bare markers.
    const marker = agent.marker;
    const signalsSection = marker
      ? `## Review / Completion Signals
Emit EXACTLY ONE of these on its own line when you finish. The \`:${marker}\` suffix identifies
you — a signal without it is ignored, so always include it verbatim:
- Success: \`[AGENT_DONE:${marker}]\`
- Human review needed: \`[REVIEW_REQUESTED:${marker}]\`
- Fatal failure: \`[AGENT_FAILED:${marker}]\`
`
      : `## Review / Completion Signals
- When you are finished, output \`[AGENT_DONE]\` or \`[TASK_COMPLETE]\` to signify success.
- If you require human review, output \`[REVIEW_REQUESTED]\` or \`## REVIEW REQUIRED\`.
- If you encounter a fatal failure, output \`[AGENT_FAILED]\` or \`[TASK_FAILED]\`.
`;

    // Generate prompt content
    const promptContent = `# Swarm Agent Mission Instructions

**Mission:** ${mission || "Execute coordinated tasks"}
**Agent Name:** ${agent.name}
**Role:** ${agent.role}
**Agent ID:** ${agent.id}

## System Instructions
${agent.systemPrompt}

## Swarm Integration Context
- Dependencies: ${agent.dependencies.join(', ') || 'None'}
- Mailbox Path: .saple/swarm/mailbox/${agent.id}.md (Write your updates/output here)
- Handoff Path: .saple/swarm/handoffs/${agent.id}-to-[next_agent].json
${skillsSection}${contextSection}
${signalsSection}`;

    const promptFile = `.saple/agents/prompts/swarm_${agent.id}.md`;
    await invoke('write_project_file', {
      projectPath,
      filePath: promptFile,
      content: promptContent
    });

    // 1. Spawn terminal pane. spawn_pty launches the provider CLI with this prompt
    // file piped in, so no separate launch command is written to the PTY.
    const provider = agent.provider || 'codex';
    const paneId = await useTerminalStore.getState().addPane(projectPath, provider, agent.model, promptFile);

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

    await updateAgentStatus(projectPath, agent.id, 'running', { terminalId: paneId, taskId: session.id });
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
      templates: DEFAULT_TEMPLATES,
      swarmActive: false,
      activeTemplateId: null,

      loadSwarmState: async (projectPath, force = false) => {
        // loadedProjectPath is rehydrated from localStorage (persist), so without `force`
        // reopening a project would skip re-reading .saple/swarm/state.json and discard
        // external/MCP edits. The project-open flow passes force=true to always re-read disk.
        if (!force && get().loadedProjectPath === projectPath) return;
        try {
          const content = await invoke<string>('read_swarm_state', { projectPath });
          const parsed = JSON.parse(content);

          // Crash/restart reconciliation: state.json can say an agent is running while its PTY
          // no longer exists (app restarted mid-run). Left alone, those zombies stay "running"
          // forever and dependents never start. Downgrade them to failed (Relaunch stays one
          // click away) and pause a running swarm so continuing is a deliberate Resume.
          const loadedAgents: SwarmAgent[] = parsed.agents || [];
          const liveSessions = useTerminalStore.getState().sessions;
          let orphaned = false;
          const reconciledAgents = loadedAgents.map((agent) => {
            if (agent.status !== 'running' && agent.status !== 'starting') return agent;
            if (agent.terminalId && liveSessions[agent.terminalId]) return agent;
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
            activeAgents: reconciledAgents,
          });
          if (orphaned) {
            await get().saveSwarmState(projectPath);
          }
        } catch {
          // Reset if file not found
          set({ loadedProjectPath: projectPath, activeAgents: [], swarmActive: false, status: 'idle', swarmId: null, swarmName: '', mission: '', skills: [], contextFiles: [], activeTemplateId: null });
        }
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
        });

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

        let stateChanged = false;
        const updatedAgents = [...activeAgents];

        // 1. Mark dependents as blocked if any dependency failed or is blocked
        let changedBlocked = true;
        while (changedBlocked) {
          changedBlocked = false;
          for (let i = 0; i < updatedAgents.length; i++) {
            const agent = updatedAgents[i];
            if (agent.status !== 'blocked' && agent.status !== 'failed' && agent.status !== 'done') {
              const hasFailedDependency = agent.dependencies.some(depId => {
                const depAgent = updatedAgents.find(a => a.id === depId);
                return depAgent && (depAgent.status === 'failed' || depAgent.status === 'blocked');
              });
              if (hasFailedDependency) {
                updatedAgents[i] = { ...agent, status: 'blocked' };
                stateChanged = true;
                changedBlocked = true;
              }
            }
          }
        }

        // 2. Check general completion
        const allCompleted = updatedAgents.every(a => a.status === 'done');
        const anyFailedOrBlocked = updatedAgents.some(a => a.status === 'failed' || a.status === 'blocked');
        const allFinished = updatedAgents.every(a => ['done', 'failed', 'blocked', 'stopped'].includes(a.status));

        if (allCompleted) {
          set({ status: 'completed', activeAgents: updatedAgents });
          await get().saveSwarmState(projectPath);
          return;
        } else if (allFinished && anyFailedOrBlocked) {
          set({ status: 'failed', activeAgents: updatedAgents });
          await get().saveSwarmState(projectPath);
          return;
        }

        // 3. Start agents whose dependencies are all done, bounded by the configured
        // parallel-agent limit. Without this cap a wide swarm (many dependency-ready agents)
        // would spawn every CLI at once, blowing past maxParallelAgents and swamping the machine.
        // Over-limit agents stay 'waiting'/'idle' and launch on a later scan — each completion
        // fires checkAndRunNextAgents, which frees a slot and picks up the next one.
        const maxParallel = useTerminalStore.getState().getMaxPaneLimit();
        let activeCount = updatedAgents.filter(a => a.status === 'starting' || a.status === 'running').length;
        for (let i = 0; i < updatedAgents.length; i++) {
          if (activeCount >= maxParallel) break;
          const agent = updatedAgents[i];
          if (agent.status === 'waiting' || agent.status === 'idle') {
            const allDepsDone = agent.dependencies.every(depId => {
              const depAgent = updatedAgents.find(a => a.id === depId);
              return depAgent && depAgent.status === 'done';
            });

            if (allDepsDone) {
              updatedAgents[i] = { ...agent, status: 'starting' };
              stateChanged = true;
              activeCount++;

              set({ activeAgents: updatedAgents });
              await get().saveSwarmState(projectPath);

              // Launch async process
              launchAgentProcess(projectPath, agent).catch(err => {
                console.error(`Error launching agent ${agent.id}:`, err);
              });
            }
          }
        }

        if (stateChanged) {
          set({ activeAgents: updatedAgents });
          await get().saveSwarmState(projectPath);
        }
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

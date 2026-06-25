import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { createId } from '../lib/id';
import { nowIso } from '../lib/date';
import type { AgentSession, AgentStatus } from '../types/agent';
import type { AgentProvider } from '../types/provider';
import type { AgentRole } from '../types/agent';

interface AgentSessionState {
  sessions: AgentSession[];
  loaded: boolean;
  loadedProjectPath: string | null;

  loadSessions: (projectPath: string, force?: boolean) => Promise<void>;
  saveSessions: (projectPath: string) => Promise<void>;
  createSession: (opts: {
    id?: string;
    projectPath: string;
    name: string;
    cwd: string;
    provider?: AgentProvider;
    model?: string;
    role?: AgentRole;
    taskId?: string;
    swarmId?: string;
    terminalId: string;
  }) => Promise<AgentSession>;
  updateSession: (sessionId: string, updates: Partial<AgentSession>) => void;
  setSessionStatus: (sessionId: string, status: AgentStatus, exitCode?: number) => void;
  getRecoverableSessions: () => AgentSession[];
  getSessionByTerminalId: (terminalId: string) => AgentSession | undefined;
  persistAndUpdate: (projectPath: string, sessionId: string, updates: Partial<AgentSession>) => Promise<void>;
}

const SESSION_FILE = '.saple/agents/sessions.json';

export const useAgentSessionStore = create<AgentSessionState>()(
  (set, get) => ({
    sessions: [],
    loaded: false,
    loadedProjectPath: null,

    loadSessions: async (projectPath, force = false) => {
      if (!force && get().loadedProjectPath === projectPath) return;
      try {
        const content = await invoke<string>('read_project_file', {
          projectPath,
          filePath: SESSION_FILE,
        });
        const parsed = JSON.parse(content) as AgentSession[];
        const sessions = parsed.map(s => ({
          ...s,
          status: s.status === 'running' || s.status === 'starting' ? 'stopped' as AgentStatus : s.status,
        }));
        set({ sessions, loaded: true, loadedProjectPath: projectPath });
      } catch {
        set({ sessions: [], loaded: true, loadedProjectPath: projectPath });
      }
    },

    saveSessions: async (projectPath) => {
      try {
        await invoke('write_project_file', {
          projectPath,
          filePath: SESSION_FILE,
          content: JSON.stringify(get().sessions, null, 2),
        });
      } catch (error) {
        console.error('Failed to save agent sessions:', error);
      }
    },

    createSession: async (opts) => {
      const now = nowIso();
      const sessionId = opts.id || createId('agent');
      const session: AgentSession = {
        id: sessionId,
        taskId: opts.taskId,
        swarmId: opts.swarmId,
        provider: opts.provider || 'codex',
        model: opts.model || 'default',
        role: opts.role || 'builder',
        name: opts.name,
        cwd: opts.cwd,
        terminalId: opts.terminalId,
        promptPath: `.saple/agents/prompts/${sessionId}.md`,
        outputLogPath: `.saple/agents/logs/${createId('log')}.ansi`,
        status: 'starting',
        startedAt: now,
        updatedAt: now,
        artifacts: [],
      };

      set((state) => ({
        sessions: [...state.sessions, session],
      }));

      await get().saveSessions(opts.projectPath);
      return session;
    },

    updateSession: (sessionId, updates) => {
      set((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === sessionId ? { ...s, ...updates, updatedAt: nowIso() } : s
        ),
      }));
    },

    setSessionStatus: (sessionId, status, exitCode) => {
      const now = nowIso();
      set((state) => ({
        sessions: state.sessions.map((s) => {
          if (s.id !== sessionId) return s;
          const completed = ['done', 'failed', 'stopped'].includes(status);
          return {
            ...s,
            status,
            exitCode: exitCode ?? s.exitCode,
            updatedAt: now,
            completedAt: completed ? (s.completedAt || now) : s.completedAt,
          };
        }),
      }));
    },

    getRecoverableSessions: () => {
      return get().sessions.filter((s) => s.status === 'stopped' || s.status === 'failed');
    },

    getSessionByTerminalId: (terminalId) => {
      return get().sessions.find((s) => s.terminalId === terminalId);
    },

    persistAndUpdate: async (projectPath, sessionId, updates) => {
      get().updateSession(sessionId, updates);
      await get().saveSessions(projectPath);
    },
  })
);

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { createId } from '../lib/id';
import { useProjectStore } from './projectStore';

// --- Provider model (a different axis from providerStore's CLI agents) --------------------------

export type AmberProviderId = 'anthropic' | 'claude-code' | 'openai' | 'groq' | 'custom';

export const AMBER_PROVIDERS: { id: AmberProviderId; label: string }[] = [
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'claude-code', label: 'Claude Code (Max subscription)' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'groq', label: 'Groq' },
  { id: 'custom', label: 'Custom (OpenAI-compatible)' },
];

const DEFAULT_MODELS: Record<AmberProviderId, string> = {
  anthropic: 'claude-opus-4-8',
  // Empty → let the CLI use the subscription's default model (alias `opus`/`sonnet` or a full id ok).
  'claude-code': '',
  openai: 'gpt-4o',
  groq: 'llama-3.3-70b-versatile',
  custom: '',
};

/** Keychain service slot per provider. Read in Rust; the secret never returns to the renderer. */
export const keyService = (provider: AmberProviderId) => `saple_amber_${provider}_api_key`;

// --- Provider-neutral message log (mirrors the Rust serde shapes) -------------------------------

export type AmberContentPart =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown };

export interface AmberToolResult {
  toolUseId: string;
  name: string;
  content: string;
  isError: boolean;
}

export type AmberMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: AmberContentPart[] }
  | { role: 'tool_results'; results: AmberToolResult[] };

export interface AmberConversation {
  id: string;
  title: string;
  provider: string;
  model: string;
  messages: AmberMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface AmberConversationSummary {
  id: string;
  title: string;
  provider: string;
  model: string;
  updatedAt: string;
}

/** Live state of a tool call during a run (full input isn't streamed; we show name + result). */
export interface LiveToolCall {
  toolUseId: string;
  name: string;
  status: 'running' | 'done' | 'error';
  content?: string;
}

/** Local `claude` CLI status for the "Claude Code" (subscription) provider — no key, uses login. */
export interface ClaudeCodeStatus {
  available: boolean;
  loggedIn: boolean;
  version?: string | null;
  authMethod?: string | null;
  detail?: string | null;
}

// --- Event payloads (from Rust `amber://event` / `amber://run`) ---------------------------------

interface AmberEvent {
  type: 'text_delta' | 'tool_use_start' | 'tool_running' | 'tool_result' | 'usage' | 'turn_done' | 'error';
  conversationId: string;
  text?: string;
  toolUseId?: string;
  name?: string;
  content?: string;
  isError?: boolean;
  message?: string;
}

interface AmberRunEvent {
  conversationId: string;
  status: 'started' | 'done' | 'cancelled' | 'error';
  message?: string | null;
}

// --- rAF-batched delta buffer (anti-thrash: never set() per token) ------------------------------

let pendingDelta = '';
let rafScheduled = false;
let listenersStarted = false;
let unlistenEvent: UnlistenFn | null = null;
let unlistenRun: UnlistenFn | null = null;

function scheduleFlush(apply: (chunk: string) => void) {
  if (rafScheduled) return;
  rafScheduled = true;
  const flush = () => {
    rafScheduled = false;
    if (!pendingDelta) return;
    const chunk = pendingDelta;
    pendingDelta = '';
    apply(chunk);
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
  else setTimeout(flush, 16);
}

// --- Store --------------------------------------------------------------------------------------

interface AmberState {
  // Persisted prefs (NEVER secrets).
  provider: AmberProviderId;
  model: string;
  baseUrl: string;

  // Ephemeral session state.
  activeId: string;
  messages: AmberMessage[];
  streamingText: string;
  liveToolCalls: LiveToolCall[];
  isRunning: boolean;
  runError: string | null;
  conversations: AmberConversationSummary[];
  keyPresence: Record<string, boolean>;
  claudeCodeStatus: ClaudeCodeStatus | null;

  init: () => Promise<void>;
  send: (text: string) => Promise<void>;
  stop: () => Promise<void>;
  newConversation: () => void;
  loadConversation: (id: string) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  refreshConversations: () => Promise<void>;
  setProvider: (p: AmberProviderId) => void;
  setModel: (m: string) => void;
  setBaseUrl: (b: string) => void;
  saveKey: (provider: AmberProviderId, key: string) => Promise<void>;
  refreshKeyPresence: () => Promise<void>;
  checkClaudeCodeStatus: () => Promise<void>;
}

const projectPath = () => useProjectStore.getState().currentProjectPath ?? undefined;

export const useAmberStore = create<AmberState>()(
  persist(
    (set, get) => ({
      provider: 'anthropic',
      model: DEFAULT_MODELS.anthropic,
      baseUrl: '',

      activeId: createId('amber'),
      messages: [],
      streamingText: '',
      liveToolCalls: [],
      isRunning: false,
      runError: null,
      conversations: [],
      keyPresence: {},
      claudeCodeStatus: null,

      init: async () => {
        if (!listenersStarted) {
          listenersStarted = true;
          unlistenEvent = await listen<AmberEvent>('amber://event', (e) => reduceEvent(set, get, e.payload));
          unlistenRun = await listen<AmberRunEvent>('amber://run', (e) => reduceRun(set, get, e.payload));
        }
        await get().refreshConversations();
        await get().refreshKeyPresence();
      },

      send: async (text) => {
        const trimmed = text.trim();
        if (!trimmed || get().isRunning) return;
        const userMsg: AmberMessage = { role: 'user', content: trimmed };
        const messages = [...get().messages, userMsg];
        set({ messages, isRunning: true, streamingText: '', liveToolCalls: [], runError: null });
        pendingDelta = '';
        const { activeId, provider, model, baseUrl } = get();
        try {
          await invoke('amber_send_message', {
            conversationId: activeId,
            projectPath: projectPath(),
            provider,
            model,
            baseUrl: baseUrl || undefined,
            messages,
          });
        } catch (err) {
          set({ isRunning: false, runError: String(err) });
        }
      },

      stop: async () => {
        try {
          await invoke('amber_cancel', { conversationId: get().activeId });
        } catch {
          /* best-effort */
        }
      },

      newConversation: () => {
        set({
          activeId: createId('amber'),
          messages: [],
          streamingText: '',
          liveToolCalls: [],
          isRunning: false,
          runError: null,
        });
      },

      loadConversation: async (id) => {
        try {
          const convo = await invoke<AmberConversation>('amber_load_conversation', {
            projectPath: projectPath(),
            conversationId: id,
          });
          set({
            activeId: convo.id,
            messages: convo.messages,
            streamingText: '',
            liveToolCalls: [],
            isRunning: false,
            runError: null,
          });
        } catch (err) {
          set({ runError: String(err) });
        }
      },

      deleteConversation: async (id) => {
        try {
          await invoke('amber_delete_conversation', { projectPath: projectPath(), conversationId: id });
        } catch {
          /* ignore */
        }
        await get().refreshConversations();
        if (get().activeId === id) get().newConversation();
      },

      refreshConversations: async () => {
        try {
          const list = await invoke<AmberConversationSummary[]>('amber_list_conversations', {
            projectPath: projectPath(),
          });
          set({ conversations: list });
        } catch {
          set({ conversations: [] });
        }
      },

      setProvider: (p) => set({ provider: p, model: DEFAULT_MODELS[p] }),
      setModel: (m) => set({ model: m }),
      setBaseUrl: (b) => set({ baseUrl: b }),

      saveKey: async (provider, key) => {
        await invoke('set_api_key', { service: keyService(provider), key });
        await get().refreshKeyPresence();
      },

      refreshKeyPresence: async () => {
        const entries = await Promise.all(
          AMBER_PROVIDERS.map(async ({ id }) => {
            try {
              const has = await invoke<boolean>('has_api_key', { service: keyService(id) });
              return [id, has] as const;
            } catch {
              return [id, false] as const;
            }
          })
        );
        set({ keyPresence: Object.fromEntries(entries) });
      },

      checkClaudeCodeStatus: async () => {
        try {
          const status = await invoke<ClaudeCodeStatus>('amber_claude_code_status');
          set({ claudeCodeStatus: status });
        } catch (err) {
          set({ claudeCodeStatus: { available: false, loggedIn: false, detail: String(err) } });
        }
      },
    }),
    {
      name: 'saple-bridge-amber-store',
      // Persist ONLY non-secret prefs — never messages, never keys.
      partialize: (state) => ({ provider: state.provider, model: state.model, baseUrl: state.baseUrl }),
    }
  )
);

// --- Reducers (kept outside the store body so they can use the batched flush) -------------------

type SetState = (partial: Partial<AmberState> | ((s: AmberState) => Partial<AmberState>)) => void;
type GetState = () => AmberState;

function reduceEvent(set: SetState, get: GetState, ev: AmberEvent) {
  if (ev.conversationId !== get().activeId) return;
  switch (ev.type) {
    case 'text_delta':
      pendingDelta += ev.text ?? '';
      scheduleFlush((chunk) => set((s) => ({ streamingText: s.streamingText + chunk })));
      break;
    case 'tool_use_start':
      set((s) => ({
        liveToolCalls: upsertToolCall(s.liveToolCalls, ev.toolUseId!, ev.name ?? '', 'running'),
      }));
      break;
    case 'tool_running':
      set((s) => ({
        liveToolCalls: upsertToolCall(s.liveToolCalls, ev.toolUseId!, ev.name ?? '', 'running'),
      }));
      break;
    case 'tool_result':
      set((s) => ({
        liveToolCalls: s.liveToolCalls.map((t) =>
          t.toolUseId === ev.toolUseId
            ? { ...t, status: ev.isError ? 'error' : 'done', content: ev.content }
            : t
        ),
      }));
      break;
    case 'turn_done':
      // Flush any buffered text immediately so it isn't lost on a fast finish.
      if (pendingDelta) {
        const chunk = pendingDelta;
        pendingDelta = '';
        set((s) => ({ streamingText: s.streamingText + chunk }));
      }
      break;
    case 'error':
      set({ runError: ev.message ?? 'Unknown error' });
      break;
    default:
      break;
  }
}

function reduceRun(set: SetState, get: GetState, ev: AmberRunEvent) {
  if (ev.conversationId !== get().activeId) return;
  if (ev.status === 'started') {
    set({ isRunning: true });
    return;
  }
  // done | cancelled | error → reload the canonical log Rust persisted (it has the exact tool
  // inputs the streamed events don't carry), then clear the transient stream state.
  void (async () => {
    try {
      const convo = await invoke<AmberConversation>('amber_load_conversation', {
        projectPath: projectPath(),
        conversationId: ev.conversationId,
      });
      if (get().activeId === ev.conversationId) {
        set({ messages: convo.messages });
      }
    } catch {
      /* keep optimistic messages if reload fails */
    } finally {
      set({
        isRunning: false,
        streamingText: '',
        liveToolCalls: [],
        runError: ev.status === 'error' ? get().runError ?? ev.message ?? 'Run failed' : get().runError,
      });
      void get().refreshConversations();
    }
  })();
}

function upsertToolCall(
  list: LiveToolCall[],
  toolUseId: string,
  name: string,
  status: LiveToolCall['status']
): LiveToolCall[] {
  if (list.some((t) => t.toolUseId === toolUseId)) return list;
  return [...list, { toolUseId, name, status }];
}

/** Test/HMR cleanup. */
export function disposeAmberListeners() {
  if (unlistenEvent) unlistenEvent();
  if (unlistenRun) unlistenRun();
  unlistenEvent = null;
  unlistenRun = null;
  listenersStarted = false;
}

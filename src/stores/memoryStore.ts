import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { useConfirmStore } from './confirmStore';
import { hasIpcErrorCode, parseIpcError } from '../lib/errors';

export interface MemoryNode {
  id: string;
  title: string;
  category: string;
  tags: string[];
  aliases: string[];
  filePath: string;
}

export interface MemoryEdge {
  source: string;
  target: string;
}

export interface MemoryGraph {
  nodes: MemoryNode[];
  edges: MemoryEdge[];
}

export interface UnlinkedMention {
  sourceId: string;
  sourceTitle: string;
  snippet: string;
}

export type MemoryMatchReason = 'title' | 'heading' | 'body' | 'backlinks';

export interface RankedMemoryHit {
  id: string;
  score: number;
  matchReason: MemoryMatchReason;
}

interface MemoryState {
  nodes: MemoryNode[];
  edges: MemoryEdge[];
  loadedProjectPath: string | null;
  snapshots: string[];
  activeNote: MemoryNode | null;
  activeNoteContent: string;
  unlinkedMentions: UnlinkedMention[];
  searchQuery: string;
  // Ranked content hits from the Rust full-text pass (title > heading > body frequency >
  // backlinks); the list view unions these with its instant title/tag filter and shows
  // them in rank order.
  contentHits: RankedMemoryHit[];
  selectedCategory: string;
  loading: boolean;
  error: string | null;

  loadGraph: (projectPath: string) => Promise<void>;
  loadNote: (projectPath: string, node: MemoryNode) => Promise<void>;
  saveNote: (projectPath: string, id: string, title: string, category: string, tags: string[], aliases: string[], content: string) => Promise<void>;
  deleteNote: (projectPath: string, node: MemoryNode) => Promise<void>;
  loadUnlinkedMentions: (projectPath: string, id: string) => Promise<void>;
  addLink: (projectPath: string, source: string, target: string) => Promise<void>;
  takeSnapshot: (projectPath: string, name: string, overwrite?: boolean) => Promise<void>;
  restoreSnapshot: (projectPath: string, name: string) => Promise<void>;
  loadSnapshots: (projectPath: string) => Promise<void>;
  searchContent: (projectPath: string, query: string) => Promise<void>;

  setActiveNote: (note: MemoryNode | null) => void;
  setSearchQuery: (query: string) => void;
  setSelectedCategory: (category: string) => void;
}

// Currency token for loadNote: rapid note clicks fire overlapping reads, and without this an
// older (slower) response could land after a newer one and overwrite the editor with stale
// content. Only the latest request may commit its result.
let loadNoteSeq = 0;

// Same token pattern for loadGraph (Phase 2: replaces the old boolean `loading` guard, which
// silently swallowed legitimate reloads and let stale responses win after project switches).
let loadGraphSeq = 0;

export const useMemoryStore = create<MemoryState>((set, get) => ({
  nodes: [],
  edges: [],
  loadedProjectPath: null,
  snapshots: [],
  activeNote: null,
  activeNoteContent: '',
  unlinkedMentions: [],
  searchQuery: '',
  contentHits: [],
  selectedCategory: 'all',
  loading: false,
  error: null,

  loadGraph: async (projectPath) => {
    const token = ++loadGraphSeq;
    set({ loading: true, error: null });
    try {
      const graph = await invoke<MemoryGraph>('get_memory_graph', { projectPath });
      if (token !== loadGraphSeq) return; // superseded by a newer load
      set({
        nodes: graph.nodes,
        edges: graph.edges,
        loadedProjectPath: projectPath,
        loading: false
      });
    } catch (err) {
      if (token !== loadGraphSeq) return;
      set({ error: `Failed to load graph: ${String(err)}`, loading: false });
    }
  },

  loadNote: async (projectPath, node) => {
    const requestId = ++loadNoteSeq;
    set({ loading: true, error: null });
    try {
      const content = await invoke<string>('read_memory_file', {
        projectPath,
        filePath: node.filePath,
      });
      if (requestId !== loadNoteSeq) return; // a newer loadNote superseded this one

      // Strip off YAML frontmatter to get clean editing content
      let cleanContent = content;
      if (content.startsWith('---')) {
        const parts = content.split('---');
        if (parts.length >= 3) {
          cleanContent = parts.slice(2).join('---').trim();
        }
      }
      
      // Strip out the first H1 header so it doesn't double-render in editor
      if (cleanContent.startsWith('# ')) {
        const lines = cleanContent.split('\n');
        cleanContent = lines.slice(1).join('\n').trim();
      }

      set({
        activeNote: node,
        activeNoteContent: cleanContent,
        unlinkedMentions: [],
        loading: false
      });

      // Unlinked mentions only apply to saved notes (those with an id).
      if (node.id) {
        get().loadUnlinkedMentions(projectPath, node.id);
      }
    } catch (err) {
      if (requestId !== loadNoteSeq) return;
      set({ error: `Failed to load note: ${String(err)}`, loading: false });
    }
  },

  loadUnlinkedMentions: async (projectPath, id) => {
    try {
      const mentions = await invoke<UnlinkedMention[]>('get_unlinked_mentions', { projectPath, id });
      // Guard against a race where the user navigated away before this resolved.
      if (get().activeNote?.id === id) {
        set({ unlinkedMentions: mentions });
      }
    } catch {
      set({ unlinkedMentions: [] });
    }
  },

  addLink: async (projectPath, source, target) => {
    try {
      await invoke('add_memory_link', { projectPath, source, target });
      const graph = await invoke<MemoryGraph>('get_memory_graph', { projectPath });
      set({ nodes: graph.nodes, edges: graph.edges });
      // Refresh unlinked mentions for the note currently in view.
      const active = get().activeNote;
      if (active?.id) {
        get().loadUnlinkedMentions(projectPath, active.id);
      }
    } catch (err) {
      set({ error: `Failed to add link: ${String(err)}` });
    }
  },

  saveNote: async (projectPath, id, title, category, tags, aliases, content) => {
    set({ loading: true, error: null });
    try {
      const updatedNode = await invoke<MemoryNode>('save_memory_node', {
        projectPath,
        id,
        title,
        category,
        tags,
        aliases,
        content,
      });
      
      // Reload graph and update selected active node
      const graph = await invoke<MemoryGraph>('get_memory_graph', { projectPath });
      
      set({ 
        nodes: graph.nodes, 
        edges: graph.edges, 
        loadedProjectPath: projectPath,
        activeNote: updatedNode,
        activeNoteContent: content,
        loading: false 
      });
    } catch (err) {
      set({ error: `Failed to save note: ${String(err)}`, loading: false });
    }
  },

  deleteNote: async (projectPath, node) => {
    set({ loading: true, error: null });
    try {
      await invoke('delete_memory_file', {
        projectPath,
        filePath: node.filePath,
      });
      
      const graph = await invoke<MemoryGraph>('get_memory_graph', { projectPath });
      set({ 
        nodes: graph.nodes, 
        edges: graph.edges, 
        loadedProjectPath: projectPath,
        activeNote: null,
        activeNoteContent: '',
        loading: false 
      });
    } catch (err) {
      set({ error: `Failed to delete note: ${String(err)}`, loading: false });
    }
  },

  takeSnapshot: async (projectPath, name, overwrite = false) => {
    set({ loading: true, error: null });
    try {
      // Phase 2: snapshots stage + verify in Rust before swapping; overwriting an existing
      // snapshot requires an explicitly confirmed overwrite flag.
      await invoke('create_memory_snapshot', { projectPath, name, overwrite });
    } catch (err) {
      const info = parseIpcError(err);
      if (!overwrite && hasIpcErrorCode(err, 'already_exists')) {
        // Refuse-to-clobber surfaced by Rust - ask before replacing the old snapshot.
        set({ loading: false });
        useConfirmStore.getState().confirm({
          title: 'Overwrite snapshot?',
          message: `A snapshot named "${name}" already exists. Replace it with a new snapshot of the current memory?`,
          confirmLabel: 'Overwrite',
          onConfirm: () => {
            void get().takeSnapshot(projectPath, name, true);
          },
        });
        return;
      }
      set({ error: `Failed to create snapshot: ${info.message}`, loading: false });
      return;
    }
    const snapshots = await invoke<string[]>('list_memory_snapshots', { projectPath });
    set({ snapshots, loading: false });
  },

  restoreSnapshot: async (projectPath, name) => {
    set({ loading: true, error: null });
    try {
      await invoke('restore_memory_snapshot', { projectPath, name });
      const graph = await invoke<MemoryGraph>('get_memory_graph', { projectPath });
      set({ 
        nodes: graph.nodes, 
        edges: graph.edges, 
        loadedProjectPath: projectPath,
        activeNote: null,
        activeNoteContent: '',
        loading: false 
      });
    } catch (err) {
      set({ error: `Failed to restore snapshot: ${String(err)}`, loading: false });
    }
  },

  loadSnapshots: async (projectPath) => {
    try {
      const snapshots = await invoke<string[]>('list_memory_snapshots', { projectPath });
      set({ snapshots });
    } catch {
      // ignore
    }
  },

  searchContent: async (projectPath, query) => {
    const q = query.trim();
    if (q.length < 2) {
      set({ contentHits: [] });
      return;
    }
    try {
      const hits = await invoke<RankedMemoryHit[]>('search_memory_content', { projectPath, query: q });
      // Only commit if the user hasn't typed a different query since this request started.
      if (get().searchQuery.trim() === q) {
        set({ contentHits: hits });
      }
    } catch {
      set({ contentHits: [] });
    }
  },

  // Keep the loaded body only when selecting an existing, saved note. For a blank
  // new note (no filePath/id) or a cleared selection, reset the editor so it doesn't
  // pre-fill with the previously open note's content.
  setActiveNote: (note) =>
    set({
      activeNote: note,
      activeNoteContent: note && (note.filePath || note.id) ? get().activeNoteContent : '',
    }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setSelectedCategory: (category) => set({ selectedCategory: category }),
}));

// Stable ordering for the list view: notes with a ranked content hit come first in hit
// order (already score-desc, id-asc from Rust); everything else keeps its original order.
export function orderNodesByRank(nodes: MemoryNode[], hits: RankedMemoryHit[]): MemoryNode[] {
  if (hits.length === 0) return nodes;
  const rank = new Map(hits.map((hit, index) => [hit.id, index]));
  return [...nodes].sort((a, b) => {
    const ra = rank.get(a.id);
    const rb = rank.get(b.id);
    if (ra === undefined && rb === undefined) return 0;
    if (ra === undefined) return 1;
    if (rb === undefined) return -1;
    return ra - rb;
  });
}

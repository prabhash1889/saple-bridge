import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';

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

interface MemoryState {
  nodes: MemoryNode[];
  edges: MemoryEdge[];
  loadedProjectPath: string | null;
  snapshots: string[];
  activeNote: MemoryNode | null;
  activeNoteContent: string;
  unlinkedMentions: UnlinkedMention[];
  searchQuery: string;
  selectedCategory: string;
  loading: boolean;
  error: string | null;

  loadGraph: (projectPath: string) => Promise<void>;
  loadNote: (projectPath: string, node: MemoryNode) => Promise<void>;
  saveNote: (projectPath: string, id: string, title: string, category: string, tags: string[], aliases: string[], content: string) => Promise<void>;
  deleteNote: (projectPath: string, node: MemoryNode) => Promise<void>;
  loadUnlinkedMentions: (projectPath: string, id: string) => Promise<void>;
  addLink: (projectPath: string, source: string, target: string) => Promise<void>;
  takeSnapshot: (projectPath: string, name: string) => Promise<void>;
  restoreSnapshot: (projectPath: string, name: string) => Promise<void>;
  loadSnapshots: (projectPath: string) => Promise<void>;
  
  setActiveNote: (note: MemoryNode | null) => void;
  setSearchQuery: (query: string) => void;
  setSelectedCategory: (category: string) => void;
}

export const useMemoryStore = create<MemoryState>((set, get) => ({
  nodes: [],
  edges: [],
  loadedProjectPath: null,
  snapshots: [],
  activeNote: null,
  activeNoteContent: '',
  unlinkedMentions: [],
  searchQuery: '',
  selectedCategory: 'all',
  loading: false,
  error: null,

  loadGraph: async (projectPath) => {
    if (get().loading || get().loadedProjectPath === projectPath) return;
    set({ loading: true, error: null });
    try {
      const graph = await invoke<MemoryGraph>('get_memory_graph', { projectPath });
      set({ 
        nodes: graph.nodes, 
        edges: graph.edges, 
        loadedProjectPath: projectPath,
        loading: false 
      });
    } catch (err: any) {
      set({ error: `Failed to load graph: ${err.toString()}`, loading: false });
    }
  },

  loadNote: async (projectPath, node) => {
    set({ loading: true, error: null });
    try {
      const content = await invoke<string>('read_memory_file', {
        projectPath,
        filePath: node.filePath,
      });
      
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
    } catch (err: any) {
      set({ error: `Failed to load note: ${err.toString()}`, loading: false });
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
    } catch (err: any) {
      set({ error: `Failed to add link: ${err.toString()}` });
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
    } catch (err: any) {
      set({ error: `Failed to save note: ${err.toString()}`, loading: false });
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
    } catch (err: any) {
      set({ error: `Failed to delete note: ${err.toString()}`, loading: false });
    }
  },

  takeSnapshot: async (projectPath, name) => {
    set({ loading: true, error: null });
    try {
      await invoke('create_memory_snapshot', { projectPath, name });
      const snapshots = await invoke<string[]>('list_memory_snapshots', { projectPath });
      set({ snapshots, loading: false });
    } catch (err: any) {
      set({ error: `Failed to create snapshot: ${err.toString()}`, loading: false });
    }
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
    } catch (err: any) {
      set({ error: `Failed to restore snapshot: ${err.toString()}`, loading: false });
    }
  },

  loadSnapshots: async (projectPath) => {
    try {
      const snapshots = await invoke<string[]>('list_memory_snapshots', { projectPath });
      set({ snapshots });
    } catch (err) {
      // ignore
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

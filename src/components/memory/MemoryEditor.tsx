import React, { useState, useEffect, useRef } from 'react';
import { Save, Trash2, ArrowLeft, Link2, Eye, Pencil, Plus } from 'lucide-react';
import { useMemoryStore } from '../../stores/memoryStore';
import { useProjectStore } from '../../stores/projectStore';
import { useFileStore } from '../../stores/fileStore';
import { useConfirmStore } from '../../stores/confirmStore';
import { useNotificationStore } from '../../stores/notificationStore';
import { MemoryMarkdown } from './markdown/MemoryMarkdown';

export const MemoryEditor: React.FC = () => {
  const { currentProjectPath, workspaceConfig } = useProjectStore();
  // The on-disk memory dir depends on the workspace's memory mode (see get_memory_dir in
  // memory.rs): bridge-compatible stores under `.bridgememory/`, otherwise `.saple/memory/`.
  const memoryPathPrefix = workspaceConfig?.memoryMode === 'bridge-compatible' ? '.bridgememory/' : '.saple/memory/';
  const { files, loadFiles } = useFileStore();
  const {
    activeNote,
    activeNoteContent,
    saveNote,
    deleteNote,
    setActiveNote,
    nodes,
    edges,
    loadNote,
    unlinkedMentions,
    addLink,
  } = useMemoryStore();

  useEffect(() => {
    if (currentProjectPath && files.length === 0) {
      loadFiles(currentProjectPath);
    }
  }, [currentProjectPath, files.length, loadFiles]);

  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('general');
  const [tags, setTags] = useState('');
  const [aliases, setAliases] = useState('');
  const [content, setContent] = useState('');

  const outgoing = activeNote?.id ? edges.filter(e => e.source === activeNote.id).map(e => e.target) : [];
  const backlinks = activeNote?.id ? edges.filter(e => e.target === activeNote.id).map(e => e.source) : [];

  // Wikilink autocomplete state
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [cursorPos, setCursorPos] = useState(0);

  // Edit / Preview view mode (Obsidian-style, toggled with Ctrl/Cmd+E).
  const [viewMode, setViewMode] = useState<'edit' | 'preview'>('edit');

  useEffect(() => {
    if (activeNote) {
      setTitle(activeNote.id ? activeNote.title : '');
      setCategory(activeNote.category);
      setTags(activeNote.tags.join(', '));
      setAliases((activeNote.aliases || []).join(', '));
      setContent(activeNoteContent);
      // A freshly created (unsaved) note opens in edit mode; existing notes too.
      setViewMode('edit');
    }
  }, [activeNote, activeNoteContent]);

  // Ctrl/Cmd+E toggles edit/preview, matching Obsidian.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        setViewMode((m) => (m === 'edit' ? 'preview' : 'edit'));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Scan content changes for wikilink triggers "[[..."
  const handleContentChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value;
    const pos = e.target.selectionStart;
    setContent(text);
    setCursorPos(pos);

    // Look backward from cursor to see if we're typing a wikilink
    const lastOpenBrackets = text.lastIndexOf('[[', pos - 1);
    const lastCloseBrackets = text.lastIndexOf(']]', pos - 1);

    if (lastOpenBrackets !== -1 && lastOpenBrackets > lastCloseBrackets) {
      // User is inside [[ ...
      const query = text.substring(lastOpenBrackets + 2, pos).toLowerCase();

      let matches: string[] = [];
      if (query.startsWith('file:')) {
        const fileQuery = query.substring(5).toLowerCase();
        matches = files
          .filter(f => !f.isDir && f.path.toLowerCase().includes(fileQuery))
          .map(f => `file:${f.path}`);
      } else {
        // Filter existing note titles/IDs/aliases matching query
        const noteMatches = nodes
          .filter(node =>
            (node.title.toLowerCase().includes(query) ||
             node.id.toLowerCase().includes(query) ||
             (node.aliases || []).some(a => a.toLowerCase().includes(query))) &&
            node.id !== activeNote?.id
          )
          .map(node => node.id);

        // Also suggest "file:" keyword option
        const fileOptions: string[] = [];
        if ('file:'.startsWith(query) && query.length > 0) {
          fileOptions.push('file:');
        } else if (query.length === 0) {
          fileOptions.push('file:');
        }

        matches = [...noteMatches, ...fileOptions];
      }

      setSuggestions(matches);
      setShowSuggestions(matches.length > 0);
    } else {
      setShowSuggestions(false);
    }
  };

  const handleSelectSuggestion = (noteId: string) => {
    if (!textareaRef.current) return;

    const text = content;
    const pos = cursorPos;
    const lastOpenBrackets = text.lastIndexOf('[[', pos - 1);

    // Replace typing query with completed [[note-id]] link tag
    const before = text.substring(0, lastOpenBrackets);
    const after = text.substring(pos);
    const completedLink = `[[${noteId}]]`;
    const newContent = before + completedLink + after;

    setContent(newContent);
    setShowSuggestions(false);

    // Reset focus and cursor position after link insertion
    const nextCursorPos = lastOpenBrackets + completedLink.length;
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(nextCursorPos, nextCursorPos);
      }
    }, 50);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentProjectPath || !title.trim()) return;

    const parsedTags = tags
      .split(',')
      .map(t => t.trim())
      .filter(t => t.length > 0);

    const parsedAliases = aliases
      .split(',')
      .map(a => a.trim())
      .filter(a => a.length > 0);

    // Fallback/derive note id from title
    const id = activeNote?.id || title.toLowerCase().trim().replace(/\s+/g, '-');

    await saveNote(currentProjectPath, id, title, category, parsedTags, parsedAliases, content);
  };

  const handleDelete = () => {
    if (!activeNote || !currentProjectPath) return;
    useConfirmStore.getState().confirm({
      title: 'Delete Memory Note',
      message: `Are you sure you want to delete "${activeNote.title}"?`,
      onConfirm: async () => {
        try {
          await deleteNote(currentProjectPath, activeNote);
          useNotificationStore.getState().success(`Deleted note "${activeNote.title}"`);
        } catch (err: any) {
          useNotificationStore.getState().error(`Failed to delete: ${err.toString()}`);
        }
      }
    });
  };

  if (!activeNote) return null;

  return (
    <div style={editorContainerStyle}>
      {/* Editor Toolbar */}
      <div style={toolbarStyle}>
        <button onClick={() => setActiveNote(null)} style={backBtnStyle}>
          <ArrowLeft size={16} />
          <span>Back to Graph</span>
        </button>

        <div style={actionsStyle}>
          <div style={viewToggleStyle}>
            <button
              type="button"
              onClick={() => setViewMode('edit')}
              style={viewMode === 'edit' ? viewToggleActiveStyle : viewToggleBtnStyle}
              title="Edit (Ctrl+E)"
            >
              <Pencil size={13} />
              <span>Edit</span>
            </button>
            <button
              type="button"
              onClick={() => setViewMode('preview')}
              style={viewMode === 'preview' ? viewToggleActiveStyle : viewToggleBtnStyle}
              title="Preview (Ctrl+E)"
            >
              <Eye size={13} />
              <span>Preview</span>
            </button>
          </div>
          {activeNote.id && (
            <button onClick={handleDelete} style={deleteBtnStyle}>
              <Trash2 size={14} />
              <span>Delete</span>
            </button>
          )}
          <button onClick={handleSave} className="primary" style={saveBtnStyle}>
            <Save size={14} />
            <span>Save Note</span>
          </button>
        </div>
      </div>

      {/* Split layout: Form on left, note details on right */}
      <div className="memory-editor-body">
        {/* Editor Form */}
        <form onSubmit={handleSave} style={formStyle}>
          <div style={fieldsGridStyle}>
            <div style={fieldGroupStyle}>
              <label style={labelStyle}>Memory Note Title</label>
              <input
                required
                value={title}
                onChange={e => setTitle(e.target.value)}
                placeholder="e.g. Database Choice, API Design Pattern"
                style={inputStyle}
              />
            </div>

            <div style={fieldRowStyle}>
              <div style={halfFieldStyle}>
                <label style={labelStyle}>Category</label>
                <select
                  value={category}
                  onChange={e => setCategory(e.target.value)}
                  style={selectStyle}
                >
                  <option value="general">General</option>
                  <option value="decision">Decision (Purple)</option>
                  <option value="architecture">Architecture (Green)</option>
                  <option value="pattern">Pattern (Blue)</option>
                  <option value="bug">Bug (Red)</option>
                  <option value="handoff">Handoff (Orange)</option>
                  <option value="review">Review (Teal)</option>
                </select>
              </div>

              <div style={halfFieldStyle}>
                <label style={labelStyle}>Tags (comma separated)</label>
                <input
                  value={tags}
                  onChange={e => setTags(e.target.value)}
                  placeholder="e.g. database, auth, tauri"
                  style={inputStyle}
                />
              </div>
            </div>

            <div style={fieldGroupStyle}>
              <label style={labelStyle}>Aliases (comma separated)</label>
              <input
                value={aliases}
                onChange={e => setAliases(e.target.value)}
                placeholder="Alternate names — [[alias]] links resolve here"
                style={inputStyle}
              />
            </div>
          </div>

          {/* Content markdown editor area */}
          <div style={textareaWrapperStyle}>
            {viewMode === 'preview' ? (
              <div style={previewWrapperStyle}>
                <MemoryMarkdown content={`# ${title || 'Untitled'}\n\n${content}`} />
              </div>
            ) : (
              <textarea
                ref={textareaRef}
                required
                value={content}
                onChange={handleContentChange}
                placeholder="Write memory note contents (Markdown supported). Type '[[ ' to autocomplete link references..."
                style={contentAreaStyle}
              />
            )}

            {/* Autocomplete Suggestions Box */}
            {viewMode === 'edit' && showSuggestions && (
              <div style={suggestionsBoxStyle}>
                <div style={suggestionsHeaderStyle}>
                  <Link2 size={12} />
                  <span>Link Memory Reference</span>
                </div>
                <div style={suggestionsListStyle}>
                  {suggestions.map(id => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => handleSelectSuggestion(id)}
                      style={suggestionItemStyle}
                    >
                      [[ {id} ]]
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </form>

        {/* Note Sidebar Details */}
        <div style={sidebarDetailsStyle}>
          <div>
            <label style={sidebarLabelStyle}>File Path</label>
            <div style={filePathBoxStyle}>
              {activeNote.filePath ? `${memoryPathPrefix}${activeNote.filePath}` : 'Not saved yet'}
            </div>
          </div>

          <div>
            <label style={sidebarLabelStyle}>Outgoing Links</label>
            <div style={linksListStyle}>
              {outgoing.length > 0 ? (
                outgoing.map(id => {
                  const targetNode = nodes.find(n => n.id === id);
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => targetNode && loadNote(currentProjectPath!, targetNode)}
                      style={linkItemStyle}
                    >
                      [[ {targetNode?.title || id} ]]
                    </button>
                  );
                })
              ) : (
                <span style={emptyLinksStyle}>No outgoing references.</span>
              )}
            </div>
          </div>

          <div>
            <label style={sidebarLabelStyle}>Backlinks</label>
            <div style={linksListStyle}>
              {backlinks.length > 0 ? (
                backlinks.map(id => {
                  const sourceNode = nodes.find(n => n.id === id);
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => sourceNode && loadNote(currentProjectPath!, sourceNode)}
                      style={linkItemStyle}
                    >
                      [[ {sourceNode?.title || id} ]]
                    </button>
                  );
                })
              ) : (
                <span style={emptyLinksStyle}>No backlinks found.</span>
              )}
            </div>
          </div>

          {activeNote.id && (
            <div>
              <label style={sidebarLabelStyle}>Unlinked Mentions</label>
              <div style={linksListStyle}>
                {unlinkedMentions.length > 0 ? (
                  unlinkedMentions.map(m => (
                    <div key={m.sourceId} style={mentionItemStyle}>
                      <button
                        type="button"
                        onClick={() => {
                          const src = nodes.find(n => n.id === m.sourceId);
                          if (src) loadNote(currentProjectPath!, src);
                        }}
                        style={mentionTitleStyle}
                        title={`Open ${m.sourceTitle}`}
                      >
                        {m.sourceTitle}
                      </button>
                      <div style={mentionSnippetStyle}>{m.snippet}</div>
                      <button
                        type="button"
                        onClick={() => addLink(currentProjectPath!, m.sourceId, activeNote.id)}
                        style={mentionLinkBtnStyle}
                        title={`Add [[${activeNote.id}]] to ${m.sourceTitle}`}
                      >
                        <Plus size={11} />
                        <span>Link</span>
                      </button>
                    </div>
                  ))
                ) : (
                  <span style={emptyLinksStyle}>No unlinked mentions.</span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

/* --- Inline CSS Styles --- */

const editorContainerStyle: React.CSSProperties = {
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  backgroundColor: 'var(--bg-app)',
};

const toolbarStyle: React.CSSProperties = {
  height: '48px',
  borderBottom: '1px solid var(--border)',
  backgroundColor: 'var(--bg-surface)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '0 16px',
  flexShrink: 0,
};

const backBtnStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  padding: '6px 12px',
  fontSize: '13px',
  color: 'var(--text-secondary)',
};

const actionsStyle: React.CSSProperties = {
  display: 'flex',
  gap: '8px',
  alignItems: 'center',
};

const viewToggleStyle: React.CSSProperties = {
  display: 'flex',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  overflow: 'hidden',
  marginRight: '4px',
};

const viewToggleBtnStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
  height: '28px',
  fontSize: '12px',
  padding: '4px 10px',
  background: 'transparent',
  border: 'none',
  borderRadius: 0,
  color: 'var(--text-secondary)',
};

const viewToggleActiveStyle: React.CSSProperties = {
  ...viewToggleBtnStyle,
  background: 'var(--bg-surface-active)',
  color: 'var(--text-primary)',
};

const previewWrapperStyle: React.CSSProperties = {
  flex: 1,
  height: '100%',
  width: '100%',
  padding: '16px',
  backgroundColor: 'var(--bg-surface)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  overflow: 'auto',
};

const saveBtnStyle: React.CSSProperties = {
  height: '28px',
  fontSize: '12px',
  padding: '4px 12px',
};

const deleteBtnStyle: React.CSSProperties = {
  height: '28px',
  fontSize: '12px',
  padding: '4px 12px',
  color: 'var(--color-danger)',
  backgroundColor: 'transparent',
  border: '1px solid transparent',
};

const formStyle: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  padding: '24px',
  gap: '20px',
  overflow: 'hidden',
};

const fieldsGridStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '16px',
  flexShrink: 0,
};

const fieldGroupStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
};

const fieldRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: '16px',
};

const halfFieldStyle: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
};

const labelStyle: React.CSSProperties = {
  fontSize: '12px',
  fontWeight: 500,
  color: 'var(--text-secondary)',
};

const inputStyle: React.CSSProperties = {
  height: '32px',
};

const selectStyle: React.CSSProperties = {
  height: '32px',
  color: 'var(--text-primary)',
};

const textareaWrapperStyle: React.CSSProperties = {
  flex: 1,
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
};

const contentAreaStyle: React.CSSProperties = {
  flex: 1,
  height: '100%',
  width: '100%',
  padding: '16px',
  backgroundColor: 'var(--bg-surface)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  fontFamily: 'var(--font-sans)',
  fontSize: '14px',
  lineHeight: '1.6',
  color: 'var(--text-primary)',
  resize: 'none',
  outline: 'none',
};

const suggestionsBoxStyle: React.CSSProperties = {
  position: 'absolute',
  top: '40px',
  left: '40px',
  backgroundColor: 'var(--bg-surface-light)',
  border: '1px solid var(--accent)',
  borderRadius: 'var(--radius-md)',
  width: '200px',
  maxHeight: '180px',
  boxShadow: 'var(--shadow-lg)',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  zIndex: 10,
};

const suggestionsHeaderStyle: React.CSSProperties = {
  fontSize: '10px',
  fontWeight: 600,
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
  padding: '6px 10px',
  borderBottom: '1px solid var(--border)',
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
  backgroundColor: 'var(--bg-surface)',
};

const suggestionsListStyle: React.CSSProperties = {
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
};

const suggestionItemStyle: React.CSSProperties = {
  padding: '8px 12px',
  fontSize: '12px',
  textAlign: 'left',
  border: 'none',
  backgroundColor: 'transparent',
  color: 'var(--text-primary)',
  cursor: 'pointer',
  transition: 'background-color 0.1s',
};

const sidebarDetailsStyle: React.CSSProperties = {
  width: '280px',
  borderLeft: '1px solid var(--border)',
  backgroundColor: 'var(--bg-surface-light)',
  padding: '20px',
  display: 'flex',
  flexDirection: 'column',
  gap: '20px',
  overflowY: 'auto',
};

const sidebarLabelStyle: React.CSSProperties = {
  fontSize: '11px',
  fontWeight: 600,
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
  display: 'block',
  marginBottom: '8px',
};

const filePathBoxStyle: React.CSSProperties = {
  fontSize: '12px',
  fontFamily: 'var(--font-mono)',
  color: 'var(--text-secondary)',
  padding: '8px 12px',
  backgroundColor: 'var(--bg-app)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  wordBreak: 'break-all',
};

const linksListStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
};

const linkItemStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '6px 10px',
  fontSize: '12px',
  backgroundColor: 'var(--bg-app)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--accent)',
  cursor: 'pointer',
  transition: 'all 0.15s',
};

const emptyLinksStyle: React.CSSProperties = {
  fontSize: '12px',
  color: 'var(--text-muted)',
  fontStyle: 'italic',
};

const mentionItemStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
  padding: '8px 10px',
  backgroundColor: 'var(--bg-app)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
};

const mentionTitleStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: 0,
  fontSize: '12px',
  fontWeight: 600,
  background: 'transparent',
  border: 'none',
  color: 'var(--accent)',
  cursor: 'pointer',
};

const mentionSnippetStyle: React.CSSProperties = {
  fontSize: '11px',
  lineHeight: 1.4,
  color: 'var(--text-muted)',
};

const mentionLinkBtnStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '3px',
  alignSelf: 'flex-start',
  height: '22px',
  fontSize: '11px',
  padding: '2px 8px',
};

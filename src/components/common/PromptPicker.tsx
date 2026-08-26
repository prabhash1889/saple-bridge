import React, { useRef, useState } from 'react';
import { BookMarked, Pencil, Plus, Trash2, X } from 'lucide-react';
import { usePromptLibraryStore, type LibraryPrompt } from '../../stores/promptLibraryStore';
import { useFocusTrap } from '../../lib/useFocusTrap';

interface PromptPickerProps {
  title?: string;
  // Receives the selected prompt text; the caller decides how to insert it.
  onSelect: (text: string) => void;
  onClose: () => void;
}

type EditingState = { mode: 'new' } | { mode: 'edit'; prompt: LibraryPrompt } | null;

// Prompt library picker (P8.5): pick, add, rename, edit, or delete saved prompts.
// Mounted by the terminal pane titlebar, the Kanban task dialog, and the swarm composer;
// insertion behavior is owned by the caller via onSelect.
export const PromptPicker: React.FC<PromptPickerProps> = ({ title = 'Prompt Library', onSelect, onClose }) => {
  const prompts = usePromptLibraryStore((s) => s.prompts);
  const addPrompt = usePromptLibraryStore((s) => s.addPrompt);
  const updatePrompt = usePromptLibraryStore((s) => s.updatePrompt);
  const removePrompt = usePromptLibraryStore((s) => s.removePrompt);

  const [editing, setEditing] = useState<EditingState>(null);
  const [draftName, setDraftName] = useState('');
  const [draftText, setDraftText] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, true, onClose);

  const openNew = () => {
    setDraftName('');
    setDraftText('');
    setEditing({ mode: 'new' });
  };

  const openEdit = (prompt: LibraryPrompt) => {
    setDraftName(prompt.name);
    setDraftText(prompt.text);
    setEditing({ mode: 'edit', prompt });
  };

  const closeEditor = () => setEditing(null);

  const canSaveDraft = draftName.trim() !== '' && draftText.trim() !== '';

  const handleSaveDraft = () => {
    if (!canSaveDraft) return;
    const payload = { name: draftName.trim(), text: draftText };
    if (editing?.mode === 'edit') updatePrompt(editing.prompt.id, payload);
    else addPrompt(payload);
    setEditing(null);
  };

  const handleSelect = (prompt: LibraryPrompt) => {
    onSelect(prompt.text);
    onClose();
  };

  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={dialogRef}
        className="modal-container"
        style={containerStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby="prompt-picker-title"
        tabIndex={-1}
      >
        <div style={headerStyle}>
          <span id="prompt-picker-title" style={titleStyle}>
            <BookMarked size={14} /> {title}
          </span>
          <button onClick={onClose} style={iconBtnStyle} title="Close" aria-label="Close prompt library">
            <X size={15} />
          </button>
        </div>

        <div style={bodyStyle}>
          {prompts.length === 0 && editing === null && (
            <div style={emptyStyle}>No saved prompts yet.</div>
          )}
          {prompts.map((prompt) => (
            <div key={prompt.id} style={rowStyle}>
              <button
                onClick={() => handleSelect(prompt)}
                style={rowMainStyle}
                title={`Insert "${prompt.name}"`}
              >
                <span style={nameStyle}>{prompt.name}</span>
                <span style={previewStyle}>{prompt.text}</span>
              </button>
              <div style={rowActionsStyle}>
                <button onClick={() => openEdit(prompt)} style={iconBtnStyle} aria-label={`Edit ${prompt.name}`} title="Edit">
                  <Pencil size={13} />
                </button>
                <button onClick={() => removePrompt(prompt.id)} style={{ ...iconBtnStyle, color: 'var(--text-muted)' }} aria-label={`Delete ${prompt.name}`} title="Delete">
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}

          {editing !== null ? (
            <div style={formStyle}>
              <input
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                placeholder="Prompt name"
                style={nameInputStyle}
                aria-label="Prompt name"
              />
              <textarea
                value={draftText}
                onChange={(e) => setDraftText(e.target.value)}
                placeholder="Prompt text"
                rows={4}
                style={textInputStyle}
                aria-label="Prompt text"
              />
              <div style={formActionsStyle}>
                <button onClick={closeEditor} style={ghostBtnStyle}>Cancel</button>
                <button onClick={handleSaveDraft} className="primary" disabled={!canSaveDraft} style={primaryBtnStyle}>
                  Save Prompt
                </button>
              </div>
            </div>
          ) : (
            <button onClick={openNew} style={addBtnStyle}>
              <Plus size={14} /> New Prompt
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

/* --- styles --- */

const containerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  width: '92%',
  maxWidth: '480px',
  maxHeight: '80vh',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '12px 16px',
  borderBottom: '1px solid var(--border)',
};

const titleStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  fontSize: '13px',
  fontWeight: 700,
  color: 'var(--text-primary)',
};

const iconBtnStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--text-secondary)',
  cursor: 'pointer',
  display: 'inline-flex',
  padding: '4px',
  borderRadius: 'var(--radius-sm)',
};

const bodyStyle: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: '12px 16px',
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
};

const emptyStyle: React.CSSProperties = {
  fontSize: '12px',
  color: 'var(--text-muted)',
  fontStyle: 'italic',
  padding: '8px 0',
};

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'stretch',
  gap: '4px',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  overflow: 'hidden',
};

const rowMainStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: 'transparent',
  border: 'none',
  textAlign: 'left',
  cursor: 'pointer',
  padding: '8px 10px',
  display: 'flex',
  flexDirection: 'column',
  gap: '3px',
  color: 'inherit',
};

const nameStyle: React.CSSProperties = {
  fontSize: '12.5px',
  fontWeight: 600,
  color: 'var(--text-primary)',
};

const previewStyle: React.CSSProperties = {
  fontSize: '11px',
  color: 'var(--text-muted)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const rowActionsStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '2px',
  padding: '4px 6px 4px 0',
};

const formStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  padding: '10px',
};

const inputBaseStyle: React.CSSProperties = {
  background: 'var(--bg-deep)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  padding: '8px 10px',
  color: 'var(--text-primary)',
  fontSize: '12.5px',
  fontFamily: 'inherit',
  outline: 'none',
  width: '100%',
};

const nameInputStyle: React.CSSProperties = {
  ...inputBaseStyle,
  height: '34px',
};

const textInputStyle: React.CSSProperties = {
  ...inputBaseStyle,
  resize: 'vertical',
};

const formActionsStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: '8px',
};

const ghostBtnStyle: React.CSSProperties = {
  height: '30px',
  padding: '0 12px',
  fontSize: '12px',
  background: 'transparent',
  border: '1px solid var(--border)',
  color: 'var(--text-secondary)',
  borderRadius: 'var(--radius-sm)',
  cursor: 'pointer',
};

const primaryBtnStyle: React.CSSProperties = {
  height: '30px',
  padding: '0 12px',
  fontSize: '12px',
  fontWeight: 600,
};

const addBtnStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  justifyContent: 'center',
  height: '32px',
  fontSize: '12px',
  background: 'transparent',
  border: '1px dashed var(--border)',
  color: 'var(--text-secondary)',
  borderRadius: 'var(--radius-sm)',
  cursor: 'pointer',
};

import React, { useState } from 'react';
import { Plus, Play, Pencil, Trash2, Server, X } from 'lucide-react';
import { useProjectStore } from '../../../stores/projectStore';
import { useTerminalStore } from '../../../stores/terminalStore';
import { useSshPresetStore, SshPreset } from '../../../stores/sshPresetStore';
import { useConfirmStore } from '../../../stores/confirmStore';
import { useNotificationStore } from '../../../stores/notificationStore';
import { buildSshCommand, sshPresetIssue } from '../../../lib/sshPreset';

type DraftKey = 'name' | 'hostAlias' | 'remoteDir' | 'providerCommand';
type Draft = Record<DraftKey, string>;

const EMPTY_DRAFT: Draft = { name: '', hostAlias: '', remoteDir: '', providerCommand: '' };

// P7 SSH terminal presets. Manage reusable remote-terminal launches and start one through the
// existing custom-command PTY path. No passwords/keys are stored — auth is the user's SSH agent.
export const SshPresetsSection: React.FC = () => {
  const currentProjectPath = useProjectStore((s) => s.currentProjectPath);
  const presets = useSshPresetStore((s) => s.presets);
  const addPreset = useSshPresetStore((s) => s.addPreset);
  const updatePreset = useSshPresetStore((s) => s.updatePreset);
  const removePreset = useSshPresetStore((s) => s.removePreset);

  // `editingId` is the preset being edited; 'new' means the add form; null means closed.
  const [editingId, setEditingId] = useState<string | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);

  const openNew = () => {
    setDraft(EMPTY_DRAFT);
    setEditingId('new');
  };

  const openEdit = (preset: SshPreset) => {
    setDraft({
      name: preset.name,
      hostAlias: preset.hostAlias,
      remoteDir: preset.remoteDir ?? '',
      providerCommand: preset.providerCommand ?? '',
    });
    setEditingId(preset.id);
  };

  // Block saving fields the quoting in buildSshCommand cannot carry (quotes, $, backticks) - the
  // local shell would silently rewrite the command before it reaches the remote host.
  const draftIssue = sshPresetIssue(draft);
  const canSave = draft.name.trim() !== '' && draft.hostAlias.trim() !== '' && !draftIssue;

  const handleSave = () => {
    if (!canSave) return;
    const payload = {
      name: draft.name.trim(),
      hostAlias: draft.hostAlias.trim(),
      remoteDir: draft.remoteDir.trim() || undefined,
      providerCommand: draft.providerCommand.trim() || undefined,
    };
    if (editingId === 'new') addPreset(payload);
    else if (editingId) updatePreset(editingId, payload);
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
  };

  const handleLaunch = (preset: SshPreset) => {
    const command = buildSshCommand(preset);
    const notify = useNotificationStore.getState();
    // Presets saved before validation existed can still carry shell-active characters.
    const issue = sshPresetIssue(preset);
    if (issue) {
      notify.error(`Edit this preset before launching: ${issue}`);
      return;
    }
    if (!currentProjectPath) {
      notify.error('Open a workspace before launching a terminal.');
      return;
    }
    if (!useTerminalStore.getState().canAddPane()) {
      notify.error('Terminal pane limit reached. Close a pane and try again.');
      return;
    }
    // Show the exact command before it runs (it goes through the same custom-command launch and
    // validation as a hand-typed one). If auth fails, the pane drops to a live shell for manual SSH.
    useConfirmStore.getState().confirm({
      title: `Launch "${preset.name}"`,
      message: `Runs this command in a new terminal pane:  ${command}`,
      confirmLabel: 'Launch terminal',
      onConfirm: () => {
        void useTerminalStore
          .getState()
          .addPane(currentProjectPath, 'custom', undefined, undefined, command)
          .then(() => useProjectStore.getState().setActiveView('terminals'))
          .catch((err) => notify.error(`Failed to launch terminal: ${String(err)}`));
      },
    });
  };

  return (
    <section className="surface ssh-presets">
      <div className="section-header">
        <Server size={18} className="section-icon" />
        <span className="section-title">SSH Terminal Presets</span>
      </div>
      <p className="section-desc">
        Saved remote-terminal launches. Authentication uses your SSH agent and <code>~/.ssh/config</code> -
        no passwords or private keys are stored. This is a remote <strong>terminal</strong>, not a remote
        workspace: files, Git, memory, Kanban, and Review stay local.
      </p>

      {presets.length === 0 && editingId === null && (
        <div className="compact-empty">No SSH presets yet.</div>
      )}

      {presets.length > 0 && (
        <div className="ssh-preset-list">
          {presets.map((preset) => (
            <div key={preset.id} className="ssh-preset-row">
              <div className="ssh-preset-main">
                <span className="ssh-preset-name">{preset.name}</span>
                <code className="ssh-preset-command">{buildSshCommand(preset)}</code>
              </div>
              <div className="ssh-preset-actions">
                <button className="ssh-preset-btn primary" onClick={() => handleLaunch(preset)} title="Launch in a terminal">
                  <Play size={13} />
                  <span>Launch</span>
                </button>
                <button className="ssh-preset-icon" onClick={() => openEdit(preset)} aria-label={`Edit ${preset.name}`} title="Edit">
                  <Pencil size={13} />
                </button>
                <button className="ssh-preset-icon danger" onClick={() => removePreset(preset.id)} aria-label={`Delete ${preset.name}`} title="Delete">
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editingId !== null ? (
        <div className="ssh-preset-form">
          <div className="input-group">
            <label className="input-label">Display Name</label>
            <input className="settings-input" value={draft.name} placeholder="Prod box" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </div>
          <div className="input-group">
            <label className="input-label">SSH Host Alias</label>
            <input className="settings-input" value={draft.hostAlias} placeholder="devbox or user@host" spellCheck={false} onChange={(e) => setDraft({ ...draft, hostAlias: e.target.value })} />
            <span className="input-hint">Must resolve in your <code>~/.ssh/config</code> / known hosts.</span>
          </div>
          <div className="input-group">
            <label className="input-label">Remote Working Directory (optional)</label>
            <input className="settings-input" value={draft.remoteDir} placeholder="/srv/app" spellCheck={false} onChange={(e) => setDraft({ ...draft, remoteDir: e.target.value })} />
          </div>
          <div className="input-group">
            <label className="input-label">Remote Provider Command (optional)</label>
            <input className="settings-input" value={draft.providerCommand} placeholder="claude / codex / npm run dev" spellCheck={false} onChange={(e) => setDraft({ ...draft, providerCommand: e.target.value })} />
          </div>
          {draftIssue && (
            <span className="input-hint" style={{ color: 'var(--color-danger)' }}>{draftIssue}</span>
          )}
          {draft.hostAlias.trim() && !draftIssue && (
            <div className="input-group">
              <label className="input-label">Command Preview</label>
              <code className="ssh-preset-command">{buildSshCommand(draft)}</code>
            </div>
          )}
          <div className="form-actions">
            <button className="primary" onClick={handleSave} disabled={!canSave}>
              Save Preset
            </button>
            <button className="ssh-preset-btn" onClick={() => { setEditingId(null); setDraft(EMPTY_DRAFT); }}>
              <X size={13} />
              <span>Cancel</span>
            </button>
          </div>
        </div>
      ) : (
        <button className="ssh-preset-add" onClick={openNew}>
          <Plus size={14} />
          <span>Add SSH Preset</span>
        </button>
      )}
    </section>
  );
};

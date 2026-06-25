import React, { useEffect, useState } from 'react';
import { FolderOpen, GitBranch, Check, AlertTriangle } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import type { WizardStepProps } from '../../../../types/wizard';
import { heroWrapStyle, heroIconWrapStyle, heroTitleStyle, heroSubtitleStyle, sectionLabelStyle } from '../wizardStyles';

interface WorkspaceSummary {
  path: string;
  name: string;
  writable: boolean;
  isGitRepo: boolean;
  branch?: string | null;
}

export const DirectoryStep: React.FC<WizardStepProps> = ({ state, update }) => {
  const { directory } = state;
  const [summary, setSummary] = useState<WorkspaceSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!directory) { setSummary(null); return; }
    invoke<WorkspaceSummary>('get_workspace_summary', { projectPath: directory })
      .then((s) => { if (!cancelled) setSummary(s); })
      .catch(() => { if (!cancelled) setSummary(null); });
    return () => { cancelled = true; };
  }, [directory]);

  const chooseFolder = async () => {
    try {
      const folder = await invoke<string | null>('select_directory');
      if (folder) update({ directory: folder });
    } catch (err) {
      console.error('Failed to choose directory:', err);
    }
  };

  return (
    <div>
      <div style={heroWrapStyle}>
        <div style={heroIconWrapStyle}><FolderOpen size={24} /></div>
        <h2 style={heroTitleStyle}>Working <span style={{ color: 'var(--accent)' }}>directory</span></h2>
        <p style={heroSubtitleStyle}>The folder this swarm operates on. Agents spawn their terminals here and read/write files inside it.</p>
      </div>

      <div style={sectionLabelStyle}>Directory</div>
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: '12px', padding: '14px 16px',
          borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--bg-surface-light)',
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '13px', fontWeight: 600, color: directory ? 'var(--text-primary)' : 'var(--text-muted)', wordBreak: 'break-all' }}>
            {directory || 'No directory selected'}
          </div>
          {summary && (
            <div style={{ display: 'flex', gap: '12px', marginTop: '6px', fontSize: '11px', color: 'var(--text-muted)', flexWrap: 'wrap' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                {summary.writable ? <Check size={12} style={{ color: 'var(--color-success)' }} /> : <AlertTriangle size={12} style={{ color: 'var(--color-warning)' }} />}
                {summary.writable ? 'Writable' : 'Read-only'}
              </span>
              {summary.isGitRepo && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                  <GitBranch size={12} /> {summary.branch || 'git'}
                </span>
              )}
            </div>
          )}
        </div>
        <button
          onClick={chooseFolder}
          className="primary"
          style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', height: '34px', padding: '0 14px', fontSize: '12px', whiteSpace: 'nowrap' }}
        >
          <FolderOpen size={13} /> Choose folder
        </button>
      </div>
    </div>
  );
};

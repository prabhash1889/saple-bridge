import React, { useRef, useState } from 'react';
import { UploadCloud, FileText, X, AlertTriangle } from 'lucide-react';
import type { WizardStepProps, ContextFileDraft } from '../../../../types/wizard';
import { heroWrapStyle, heroIconWrapStyle, heroTitleStyle, heroSubtitleStyle } from '../wizardStyles';

const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;
const ALLOWED_EXT = new Set([
  'md', 'txt', 'json', 'ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'java', 'rb',
  'yaml', 'yml', 'toml', 'csv', 'html', 'css', 'sh', 'sql', 'env', 'log', 'xml',
]);

const ext = (name: string) => name.split('.').pop()?.toLowerCase() || '';

export const ContextStep: React.FC<WizardStepProps> = ({ state, update }) => {
  const { contextFiles } = state;
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [rejected, setRejected] = useState<string[]>([]);

  const totalBytes = contextFiles.reduce((sum, f) => sum + f.size, 0);

  const handleFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const accepted: ContextFileDraft[] = [];
    const rejects: string[] = [];
    let runningTotal = totalBytes;

    for (const file of Array.from(fileList)) {
      if (!ALLOWED_EXT.has(ext(file.name))) { rejects.push(`${file.name} (unsupported type)`); continue; }
      if (file.size > MAX_FILE_BYTES) { rejects.push(`${file.name} (over 256 KB)`); continue; }
      if (runningTotal + file.size > MAX_TOTAL_BYTES) { rejects.push(`${file.name} (total limit reached)`); continue; }
      if (contextFiles.some((f) => f.name === file.name)) { rejects.push(`${file.name} (already added)`); continue; }
      try {
        const content = await file.text();
        accepted.push({ name: file.name, size: file.size, content });
        runningTotal += file.size;
      } catch {
        rejects.push(`${file.name} (read failed)`);
      }
    }

    if (accepted.length) update({ contextFiles: [...contextFiles, ...accepted] });
    setRejected(rejects);
  };

  const removeFile = (name: string) => update({ contextFiles: contextFiles.filter((f) => f.name !== name) });

  return (
    <div>
      <div style={heroWrapStyle}>
        <div style={heroIconWrapStyle}><FileText size={24} /></div>
        <h2 style={heroTitleStyle}>Supporting <span style={{ color: 'var(--accent)' }}>context</span></h2>
        <p style={heroSubtitleStyle}>Optionally attach files to give your swarm extra context — specs, logs, code, etc. Text files only.</p>
      </div>

      <input
        ref={inputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => { void handleFiles(e.target.files); e.target.value = ''; }}
      />

      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); void handleFiles(e.dataTransfer.files); }}
        style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', padding: '32px',
          borderRadius: 'var(--radius-lg)', cursor: 'pointer', textAlign: 'center',
          border: `1.5px dashed ${dragging ? 'var(--accent)' : 'var(--border-hover)'}`,
          background: dragging ? 'var(--accent-light)' : 'var(--bg-surface-light)',
        }}
      >
        <UploadCloud size={28} style={{ color: 'var(--accent)' }} />
        <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)' }}>Add context files</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Drag &amp; drop or click to attach text files (specs, logs, code).</div>
      </div>

      {rejected.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', marginTop: '12px', fontSize: '11.5px', color: 'var(--color-warning)' }}>
          <AlertTriangle size={13} style={{ marginTop: '1px', flexShrink: 0 }} />
          <span>Skipped: {rejected.join(', ')}</span>
        </div>
      )}

      {contextFiles.length > 0 && (
        <div style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {contextFiles.map((f) => (
            <div
              key={f.name}
              style={{
                display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 12px',
                borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--bg-surface-light)',
              }}
            >
              <FileText size={14} style={{ color: 'var(--text-muted)' }} />
              <span style={{ flex: 1, fontSize: '12.5px', color: 'var(--text-primary)' }}>{f.name}</span>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{(f.size / 1024).toFixed(1)} KB</span>
              <button onClick={() => removeFile(f.name)} style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'inline-flex' }}>
                <X size={14} />
              </button>
            </div>
          ))}
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', textAlign: 'right' }}>
            {(totalBytes / 1024).toFixed(1)} KB of {(MAX_TOTAL_BYTES / 1024).toFixed(0)} KB used
          </div>
        </div>
      )}
    </div>
  );
};

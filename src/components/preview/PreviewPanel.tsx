import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, ExternalLink, X, Paperclip, Globe, AlertTriangle } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { parseLoopbackUrl } from '../../lib/loopback';
import { createId } from '../../lib/id';
import { useFocusTrap } from '../../lib/useFocusTrap';
import { useProjectStore } from '../../stores/projectStore';
import { useSwarmStore } from '../../stores/swarmStore';
import { useKanbanStore } from '../../stores/kanbanStore';
import { useMemoryStore } from '../../stores/memoryStore';
import { useNotificationStore } from '../../stores/notificationStore';

interface PreviewPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

type LoadStatus = 'idle' | 'checking' | 'ok' | 'unreachable' | 'invalid';

// Where an attached preview URL goes. Reuses existing store writes — no new persistence.
type AttachTarget =
  | { id: string; label: string; kind: 'memory' }
  | { id: string; label: string; kind: 'agent'; agentId: string }
  | { id: string; label: string; kind: 'task'; taskId: string };

// P5 Local Preview. A loopback-only embedded browser so an agent's local dev server can be seen
// (and its URL attached to a task / swarm agent / project memory) without leaving Bridge. Mounted
// as a global overlay drawer — deliberately not a nav room. Screenshot capture is a separate
// follow-up (needs native per-OS webview capture); this ships the preview + attach path only.
export const PreviewPanel: React.FC<PreviewPanelProps> = ({ isOpen, onClose }) => {
  const projectPath = useProjectStore((s) => s.currentProjectPath);
  const activeAgents = useSwarmStore((s) => s.activeAgents);
  const tasks = useKanbanStore((s) => s.tasks);

  const [input, setInput] = useState('http://localhost:3000');
  const [loaded, setLoaded] = useState<URL | null>(null);
  const [status, setStatus] = useState<LoadStatus>('idle');
  const [frameKey, setFrameKey] = useState(0);
  const [attachId, setAttachId] = useState('memory');

  const drawerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useFocusTrap(drawerRef, isOpen, onClose);
  // Focus the URL field on open (runs after the focus trap's initial focus, so it wins).
  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  const load = useCallback(async (raw: string) => {
    const url = parseLoopbackUrl(raw);
    if (!url) {
      setStatus('invalid');
      setLoaded(null);
      return;
    }
    setStatus('checking');
    // Preflight the origin so we can tell "server down" from "server up but refuses embedding":
    // a rejected no-cors fetch means unreachable; a resolved (opaque) one means it responded and a
    // blank frame afterwards is an embedding block (X-Frame-Options / frame-ancestors).
    try {
      await fetch(url.href, { mode: 'no-cors' });
      setLoaded(url);
      setStatus('ok');
      setFrameKey((k) => k + 1);
    } catch {
      setLoaded(null);
      setStatus('unreachable');
    }
  }, []);

  const targets = useMemo<AttachTarget[]>(() => {
    const list: AttachTarget[] = [{ id: 'memory', label: 'Project memory', kind: 'memory' }];
    for (const a of activeAgents) {
      list.push({ id: `agent:${a.id}`, label: `Agent: ${a.name} (mailbox)`, kind: 'agent', agentId: a.id });
    }
    for (const t of tasks) {
      list.push({ id: `task:${t.id}`, label: `Task: ${t.title}`, kind: 'task', taskId: t.id });
    }
    return list;
  }, [activeAgents, tasks]);

  const attach = useCallback(async () => {
    if (!projectPath || !loaded) return;
    const target = targets.find((t) => t.id === attachId) ?? targets[0];
    const href = loaded.href;
    try {
      if (target.kind === 'memory') {
        await useMemoryStore
          .getState()
          .saveNote(projectPath, createId('note'), `Preview: ${loaded.host}`, 'general', ['preview'], [], `Local preview URL:\n\n${href}`);
      } else if (target.kind === 'agent') {
        await useSwarmStore.getState().postToMailbox(projectPath, target.agentId, `Preview URL to check: ${href}`);
      } else {
        const task = tasks.find((t) => t.id === target.taskId);
        const description = task?.description ? `${task.description}\n\nPreview: ${href}` : `Preview: ${href}`;
        await useKanbanStore.getState().updateTask(projectPath, target.taskId, { description });
      }
      useNotificationStore.getState().success(`Attached ${href} to ${target.label}.`);
    } catch (err) {
      useNotificationStore.getState().error(`Failed to attach preview URL: ${String(err)}`);
    }
  }, [projectPath, loaded, targets, attachId, tasks]);

  if (!isOpen) return null;

  return (
    <div className="preview-overlay" onClick={onClose}>
      <div
        className="preview-drawer"
        ref={drawerRef}
        role="dialog"
        aria-label="Local preview"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="preview-header">
          <div className="preview-title">
            <Globe size={15} className="fg-accent" />
            <span>Local Preview</span>
          </div>
          <button className="preview-icon-btn" onClick={onClose} aria-label="Close preview" title="Close">
            <X size={16} />
          </button>
        </div>

        <form
          className="preview-urlbar"
          onSubmit={(e) => {
            e.preventDefault();
            void load(input);
          }}
        >
          <input
            ref={inputRef}
            className="preview-url-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="http://localhost:3000"
            aria-label="Loopback URL"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
          <button type="submit" className="preview-btn primary">Load</button>
          <button
            type="button"
            className="preview-icon-btn"
            onClick={() => loaded && void load(loaded.href)}
            disabled={!loaded}
            aria-label="Refresh preview"
            title="Refresh"
          >
            <RefreshCw size={15} />
          </button>
          <button
            type="button"
            className="preview-icon-btn"
            onClick={() => loaded && void openUrl(loaded.href)}
            disabled={!loaded}
            aria-label="Open in system browser"
            title="Open externally"
          >
            <ExternalLink size={15} />
          </button>
        </form>

        {status === 'invalid' && (
          <div className="preview-message error">
            <AlertTriangle size={14} />
            <span>Only loopback URLs are allowed: localhost, 127.0.0.1, or [::1].</span>
          </div>
        )}
        {status === 'unreachable' && (
          <div className="preview-message error">
            <AlertTriangle size={14} />
            <span>Server unavailable at {input.trim()}. Is the local dev server running?</span>
          </div>
        )}

        <div className="preview-frame-wrap">
          {status === 'ok' && loaded ? (
            <iframe
              key={frameKey}
              className="preview-frame"
              src={loaded.href}
              title="Local preview"
              // Loopback dev server only; sandbox keeps it from reaching back into the app shell.
              sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
            />
          ) : (
            <div className="preview-empty">
              <Globe size={30} className="fg-border" />
              <p>{status === 'checking' ? 'Connecting…' : 'Enter a loopback URL and press Load.'}</p>
            </div>
          )}
        </div>

        {status === 'ok' && (
          <p className="preview-hint">
            Server reachable. If the panel stays blank, this server blocks embedding
            (X-Frame-Options / CSP frame-ancestors) — use "Open externally".
          </p>
        )}

        <div className="preview-attach">
          <Paperclip size={14} className="fg-muted" />
          <select
            className="preview-attach-select"
            value={attachId}
            onChange={(e) => setAttachId(e.target.value)}
            aria-label="Attach destination"
            disabled={!loaded || !projectPath}
          >
            {targets.map((t) => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>
          <button
            type="button"
            className="preview-btn"
            onClick={() => void attach()}
            disabled={!loaded || !projectPath}
            title={!loaded ? 'Load a URL first' : 'Attach this URL to the selected destination'}
          >
            Attach URL
          </button>
        </div>
      </div>
    </div>
  );
};

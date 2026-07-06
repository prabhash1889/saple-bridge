import React, { useState, useEffect, useMemo, useRef, useCallback, lazy, Suspense } from 'react';
import {
  Save, Edit3, X, ExternalLink, AlertTriangle, FileCode,
  Search, Copy, Check, WrapText, Eye, Code2, ChevronUp, ChevronDown,
} from 'lucide-react';
import { useFileStore } from '../../stores/fileStore';
import { useProjectStore } from '../../stores/projectStore';
import { useThemeStore, resolveTheme } from '../../stores/themeStore';
import {
  detectLang, langLabel, isMarkdown, canHighlight, tokenizeCode,
  tokenStyle, shikiThemeFor,
  type ThemedToken,
} from '../../lib/highlighter';
import { writeTextToClipboard } from '../../lib/clipboard';
import { CodeMirrorEditor } from './CodeMirrorEditor';

const MarkdownPreview = lazy(() => import('./MarkdownPreview'));

/** A single highlighted-search hit, in line-relative columns. */
interface LineMatch {
  start: number;
  end: number;
  index: number; // global match index (for next/prev + active styling)
}

export const CodeViewer: React.FC = () => {
  const { currentProjectPath, workspaceConfig } = useProjectStore();
  const { activeFile, fileContent, saveFileContent, openExternal, loading, error, clearError, dirty, setDirty } = useFileStore();
  const themeMode = useThemeStore(s => s.mode);
  const shikiTheme = shikiThemeFor(resolveTheme(themeMode));
  // CodeMirror only needs a light/dark split; reuse the same classification as Shiki.
  const editorTheme: 'light' | 'dark' = shikiTheme === 'light-plus' ? 'light' : 'dark';

  const [editMode, setEditMode] = useState(false);
  const [editedContent, setEditedContent] = useState('');
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [copied, setCopied] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [activeLine, setActiveLine] = useState<number | null>(null);
  const [mdView, setMdView] = useState<'code' | 'preview'>('code');
  const [tokens, setTokens] = useState<ThemedToken[][] | null>(null);

  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeMatch, setActiveMatch] = useState(0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);

  const lang = activeFile ? detectLang(activeFile) : undefined;
  const markdown = activeFile ? isMarkdown(activeFile) : false;
  const previewing = markdown && mdView === 'preview' && !editMode;
  const showingCode = !editMode && !previewing;

  // Reset per-file UI state whenever the open file (or its content) changes.
  useEffect(() => {
    setEditedContent(fileContent);
    setEditMode(false);
    setSaveSuccess(false);
    setActiveLine(null);
    setFindOpen(false);
    setQuery('');
    setMdView('code');
    setDirty(false);
    clearError();
  }, [fileContent, activeFile, clearError, setDirty]);

  // Highlight on a background pass: render plain text first, swap in Shiki tokens
  // when ready. Re-runs on theme change so colors follow light/dark.
  useEffect(() => {
    setTokens(null);
    if (!showingCode || !lang || !canHighlight(fileContent)) return;
    let cancelled = false;
    tokenizeCode(fileContent, lang, shikiTheme)
      .then(t => { if (!cancelled) setTokens(t); })
      .catch(() => { if (!cancelled) setTokens(null); });
    return () => { cancelled = true; };
  }, [fileContent, lang, shikiTheme, showingCode]);

  const rawLines = useMemo(() => fileContent.split('\n'), [fileContent]);

  // All search hits across the file, computed on the raw text.
  const matches = useMemo(() => {
    if (!findOpen || !query) return [] as { line: number; start: number; end: number }[];
    const out: { line: number; start: number; end: number }[] = [];
    const q = query.toLowerCase();
    for (let i = 0; i < rawLines.length; i++) {
      const hay = rawLines[i].toLowerCase();
      let from = 0;
      for (;;) {
        const idx = hay.indexOf(q, from);
        if (idx === -1) break;
        out.push({ line: i, start: idx, end: idx + q.length });
        from = idx + q.length;
      }
    }
    return out;
  }, [findOpen, query, rawLines]);

  const matchesByLine = useMemo(() => {
    const map = new Map<number, LineMatch[]>();
    matches.forEach((m, index) => {
      const arr = map.get(m.line) ?? [];
      arr.push({ start: m.start, end: m.end, index });
      map.set(m.line, arr);
    });
    return map;
  }, [matches]);

  // Keep the active match in range, jump to it, and reveal it.
  useEffect(() => {
    if (activeMatch >= matches.length) { setActiveMatch(0); return; }
    if (!matches.length) return;
    const m = matches[activeMatch];
    if (m) setActiveLine(m.line);
    scrollRef.current?.querySelector('.find-current')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [activeMatch, matches]);

  const gotoNext = useCallback(() => {
    setActiveMatch(i => (matches.length ? (i + 1) % matches.length : 0));
  }, [matches.length]);
  const gotoPrev = useCallback(() => {
    setActiveMatch(i => (matches.length ? (i - 1 + matches.length) % matches.length : 0));
  }, [matches.length]);

  const openFind = useCallback(() => {
    setFindOpen(true);
    setActiveMatch(0);
    setTimeout(() => findInputRef.current?.select(), 0);
  }, []);
  const closeFind = useCallback(() => { setFindOpen(false); setQuery(''); }, []);

  // Ctrl/Cmd+F opens find while viewing code (and not typing in another field).
  useEffect(() => {
    if (!showingCode) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        const t = e.target;
        if (t !== findInputRef.current && (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement)) return;
        e.preventDefault();
        openFind();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showingCode, openFind]);

  const onFindKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) gotoPrev(); else gotoNext(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
  };

  // Render one line's content: either Shiki tokens (colored) or plain text,
  // wrapping any search hits in <mark> while preserving token colors.
  const renderLine = useCallback((lineIndex: number): React.ReactNode => {
    const lineMatches = matchesByLine.get(lineIndex);

    const renderChunk = (text: string, colStart: number, style: React.CSSProperties | undefined, keyBase: string) => {
      if (!lineMatches || lineMatches.length === 0) {
        return <span style={style} key={keyBase}>{text}</span>;
      }
      const nodes: React.ReactNode[] = [];
      const end = colStart + text.length;
      let cursor = colStart;
      for (const m of lineMatches) {
        if (m.end <= colStart || m.start >= end) continue;
        const s = Math.max(m.start, colStart);
        const e = Math.min(m.end, end);
        if (s > cursor) {
          nodes.push(<span style={style} key={`${keyBase}-a${cursor}`}>{text.slice(cursor - colStart, s - colStart)}</span>);
        }
        nodes.push(
          <mark
            key={`${keyBase}-m${m.index}`}
            style={style}
            className={m.index === activeMatch ? 'find-match find-current' : 'find-match'}
          >
            {text.slice(s - colStart, e - colStart)}
          </mark>,
        );
        cursor = e;
      }
      if (cursor < end) {
        nodes.push(<span style={style} key={`${keyBase}-z${cursor}`}>{text.slice(cursor - colStart)}</span>);
      }
      return <React.Fragment key={keyBase}>{nodes}</React.Fragment>;
    };

    const lineToks = tokens?.[lineIndex];
    if (lineToks && lineToks.length) {
      let col = 0;
      return lineToks.map((tok, ti) => {
        const node = renderChunk(tok.content, col, tokenStyle(tok), `t${lineIndex}-${ti}`);
        col += tok.content.length;
        return node;
      });
    }
    return renderChunk(rawLines[lineIndex] ?? '', 0, undefined, `p${lineIndex}`);
  }, [tokens, matchesByLine, activeMatch, rawLines]);

  if (!activeFile) {
    return (
      <div className="code-viewer-empty">
        <FileCode size={36} className="code-viewer-empty-icon" />
        <h3>No File Selected</h3>
        <p>Choose a file from the file explorer to view or edit its contents.</p>
      </div>
    );
  }

  const handleSave = async () => {
    if (!currentProjectPath) return;
    try {
      await saveFileContent(currentProjectPath, activeFile, editedContent);
      setEditMode(false);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch {
      // Error handled by store
    }
  };

  const handleExternalOpen = () => {
    if (currentProjectPath && activeFile) openExternal(currentProjectPath, activeFile);
  };

  const handleCopy = async () => {
    try {
      // Shared helper: Tauri plugin with retry (bare navigator.clipboard is unreliable in
      // WebView2 - see lib/clipboard.ts), so the "Copied" feedback only shows on success.
      await writeTextToClipboard(fileContent);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error('Failed to copy file content:', err);
    }
  };

  const canEdit = workspaceConfig?.enableEditMode ?? true;
  const lineCount = tokens ? tokens.length : rawLines.length;
  const tooLarge = !!lang && !canHighlight(fileContent);

  return (
    <div className="code-viewer-container">
      {/* File Header */}
      <div className="code-viewer-header">
        <div className="file-info">
          <span className="file-icon-badge">
            <FileCode size={13} />
          </span>
          <span className="file-path-text">{activeFile}</span>
          {dirty && <span className="dirty-dot" title="Unsaved changes" aria-label="Unsaved changes" />}
          <span className="lang-badge">{langLabel(lang)}</span>
          {tooLarge && <span className="lang-note" title="File too large to highlight">no highlight</span>}
        </div>

        <div className="code-viewer-actions">
          {error && (
            <div className="error-banner-inline" title={error}>
              <AlertTriangle size={12} />
              <span>Write failed</span>
            </div>
          )}

          {saveSuccess && <span className="save-success-badge">Saved successfully</span>}

          {markdown && !editMode && (
            <div className="seg-toggle" role="tablist" aria-label="Markdown view">
              <button
                role="tab"
                aria-selected={mdView === 'code'}
                className={mdView === 'code' ? 'active' : ''}
                onClick={() => setMdView('code')}
              >
                <Code2 size={13} /><span>Code</span>
              </button>
              <button
                role="tab"
                aria-selected={mdView === 'preview'}
                className={mdView === 'preview' ? 'active' : ''}
                onClick={() => setMdView('preview')}
              >
                <Eye size={13} /><span>Preview</span>
              </button>
            </div>
          )}

          {showingCode && (
            <>
              <button
                className={findOpen ? 'icon-btn active' : 'icon-btn'}
                title="Find (Ctrl+F)"
                onClick={() => (findOpen ? closeFind() : openFind())}
              >
                <Search size={14} />
              </button>
              <button
                className={wrap ? 'icon-btn active' : 'icon-btn'}
                title="Toggle word wrap"
                onClick={() => setWrap(w => !w)}
              >
                <WrapText size={14} />
              </button>
              <button className="icon-btn" title="Copy file contents" onClick={handleCopy}>
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </>
          )}

          <button
            onClick={handleExternalOpen}
            className="secondary icon-text-btn"
            title="Open in default OS application"
          >
            <ExternalLink size={13} />
            <span>Open Externally</span>
          </button>

          {canEdit ? (
            editMode ? (
              <>
                <button
                  onClick={() => { setEditMode(false); setEditedContent(fileContent); setDirty(false); clearError(); }}
                  className="secondary icon-text-btn"
                  disabled={loading}
                >
                  <X size={13} />
                  <span>Cancel</span>
                </button>
                <button onClick={handleSave} className="primary icon-text-btn" disabled={loading || !dirty}>
                  <Save size={13} />
                  <span>{loading ? 'Saving...' : 'Save'}</span>
                </button>
              </>
            ) : (
              <button onClick={() => setEditMode(true)} className="primary icon-text-btn">
                <Edit3 size={13} />
                <span>Edit File</span>
              </button>
            )
          ) : (
            <div className="readonly-badge" title="Enable editing in Workspace Settings">
              Read-Only Mode
            </div>
          )}
        </div>
      </div>

      {/* Editor Surface */}
      <div className="code-viewer-body">
        {previewing ? (
          <Suspense fallback={<div className="md-preview-loading">Rendering preview…</div>}>
            <MarkdownPreview content={fileContent} />
          </Suspense>
        ) : editMode ? (
          <CodeMirrorEditor
            value={fileContent}
            filePath={activeFile}
            theme={editorTheme}
            wrap={wrap}
            onChange={(doc) => {
              setEditedContent(doc);
              setDirty(doc !== fileContent);
            }}
            onSave={handleSave}
          />
        ) : (
          <>
            {findOpen && (
              <div className="find-bar">
                <Search size={13} className="find-bar-icon" />
                <input
                  ref={findInputRef}
                  value={query}
                  onChange={e => { setQuery(e.target.value); setActiveMatch(0); }}
                  onKeyDown={onFindKey}
                  placeholder="Find"
                  spellCheck={false}
                  aria-label="Find in file"
                />
                <span className="find-count">
                  {matches.length ? `${activeMatch + 1}/${matches.length}` : (query ? 'No results' : '')}
                </span>
                <button className="icon-btn" title="Previous match (Shift+Enter)" onClick={gotoPrev} disabled={!matches.length}>
                  <ChevronUp size={14} />
                </button>
                <button className="icon-btn" title="Next match (Enter)" onClick={gotoNext} disabled={!matches.length}>
                  <ChevronDown size={14} />
                </button>
                <button className="icon-btn" title="Close (Esc)" onClick={closeFind}>
                  <X size={14} />
                </button>
              </div>
            )}
            <div className="code-scroll" ref={scrollRef}>
              <div className={wrap ? 'code-grid wrap' : 'code-grid'}>
                {Array.from({ length: lineCount }, (_, i) => (
                  <div
                    key={i}
                    className={activeLine === i ? 'code-row active' : 'code-row'}
                    onClick={() => setActiveLine(i)}
                  >
                    <span className="code-ln">{i + 1}</span>
                    <span className="code-content">{renderLine(i)}</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

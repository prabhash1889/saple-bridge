import React, { useState } from 'react';
import { Search, Loader2 } from 'lucide-react';
import { useFileStore, SearchHit } from '../../stores/fileStore';
import { useProjectStore } from '../../stores/projectStore';

// Group hits by file so results read like a per-file summary.
const groupByFile = (hits: SearchHit[]): [string, SearchHit[]][] => {
  const map = new Map<string, SearchHit[]>();
  for (const h of hits) {
    const arr = map.get(h.path) ?? [];
    arr.push(h);
    map.set(h.path, arr);
  }
  return [...map.entries()];
};

export const FileSearchPanel: React.FC = () => {
  const { currentProjectPath } = useProjectStore();
  const { searchInFiles, openFile } = useFileStore();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [searching, setSearching] = useState(false);
  const [ran, setRan] = useState(false);

  const runSearch = async () => {
    if (!currentProjectPath || !query.trim()) return;
    setSearching(true);
    setRan(true);
    try {
      const res = await searchInFiles(currentProjectPath, query.trim());
      setHits(res.hits);
      setTruncated(res.truncated);
    } catch {
      setHits([]);
      setTruncated(false);
    } finally {
      setSearching(false);
    }
  };

  const grouped = groupByFile(hits);

  return (
    <div className="file-search-panel">
      <div className="file-tree-search-row">
        <div className="search-input-wrapper">
          <Search size={13} className="search-icon" />
          <input
            type="text"
            placeholder="Search in files..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') runSearch();
            }}
            autoFocus
          />
        </div>
        <button className="refresh-btn icon-button" title="Search" onClick={runSearch} disabled={searching}>
          {searching ? <Loader2 size={13} className="spinning" /> : <Search size={13} />}
        </button>
      </div>

      <div className="file-search-results">
        {searching ? (
          <div className="compact-empty">Searching…</div>
        ) : !ran ? (
          <div className="compact-empty">Type a query and press Enter to search the workspace.</div>
        ) : hits.length === 0 ? (
          <div className="compact-empty">No matches found.</div>
        ) : (
          <>
            <div className="file-search-summary">
              {hits.length} match{hits.length === 1 ? '' : 'es'} in {grouped.length} file
              {grouped.length === 1 ? '' : 's'}
              {truncated && ' (truncated)'}
            </div>
            {grouped.map(([path, fileHits]) => (
              <div key={path} className="file-search-group">
                <div className="file-search-group-path" title={path}>
                  {path}
                </div>
                {fileHits.map((h, i) => (
                  <button
                    key={`${path}-${h.line}-${i}`}
                    className="file-search-hit"
                    onClick={() => currentProjectPath && openFile(currentProjectPath, path)}
                    title={`Open ${path}`}
                  >
                    <span className="file-search-hit-line">{h.line}</span>
                    <span className="file-search-hit-text">{h.lineText.trim()}</span>
                  </button>
                ))}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
};

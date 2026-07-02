import React, { useState, useEffect } from 'react';
import { Search, RefreshCw, Camera } from 'lucide-react';
import { useMemoryStore, MemoryNode } from '../../stores/memoryStore';
import { useProjectStore } from '../../stores/projectStore';
import { useConfirmStore } from '../../stores/confirmStore';
import { useNotificationStore } from '../../stores/notificationStore';

const CATEGORY_CHIPS = [
  { value: 'all', label: 'All', color: '#9CA3AF' },
  { value: 'decision', label: 'Decisions', color: 'var(--mem-decision)' },
  { value: 'architecture', label: 'Architecture', color: 'var(--mem-architecture)' },
  { value: 'pattern', label: 'Patterns', color: 'var(--mem-pattern)' },
  { value: 'bug', label: 'Bugs', color: 'var(--mem-bug)' },
  { value: 'handoff', label: 'Handoffs', color: 'var(--mem-handoff)' },
  { value: 'review', label: 'Reviews', color: 'var(--mem-review)' },
  { value: 'general', label: 'General', color: '#9CA3AF' },
];

export const MemoryList: React.FC = () => {
  const { currentProjectPath } = useProjectStore();
  const {
    nodes,
    loadNote,
    searchQuery,
    setSearchQuery,
    selectedCategory,
    setSelectedCategory,
    snapshots,
    loadSnapshots,
    takeSnapshot,
    restoreSnapshot,
    contentMatchIds,
    searchContent
  } = useMemoryStore();

  const [snapshotName, setSnapshotName] = useState('');
  const [snapshotLoading, setSnapshotLoading] = useState(false);

  useEffect(() => {
    if (currentProjectPath) {
      loadSnapshots(currentProjectPath);
    }
  }, [currentProjectPath, loadSnapshots]);

  // Full-text pass (Rust, note bodies) behind a debounce; results widen the instant
  // title/tag filter below via contentMatchIds.
  useEffect(() => {
    if (!currentProjectPath) return;
    const timer = window.setTimeout(() => {
      void searchContent(currentProjectPath, searchQuery);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [searchQuery, currentProjectPath, searchContent]);

  const handleNodeClick = (node: MemoryNode) => {
    if (currentProjectPath) {
      loadNote(currentProjectPath, node);
    }
  };

  const handleTakeSnapshot = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentProjectPath || !snapshotName.trim()) return;

    setSnapshotLoading(true);
    try {
      await takeSnapshot(currentProjectPath, snapshotName.trim());
      setSnapshotName('');
      useNotificationStore.getState().success('Snapshot created successfully!');
    } catch (err: any) {
      useNotificationStore.getState().error(`Failed to create snapshot: ${err.toString()}`);
    } finally {
      setSnapshotLoading(false);
    }
  };

  const handleRestoreSnapshot = (name: string) => {
    if (!currentProjectPath) return;
    useConfirmStore.getState().confirm({
      title: 'Restore Snapshot',
      message: `Are you sure you want to restore snapshot "${name}"? This will overwrite current memories.`,
      onConfirm: async () => {
        setSnapshotLoading(true);
        try {
          await restoreSnapshot(currentProjectPath, name);
          useNotificationStore.getState().success('Snapshot restored successfully!');
        } catch (err: any) {
          useNotificationStore.getState().error(`Failed to restore snapshot: ${err.toString()}`);
        } finally {
          setSnapshotLoading(false);
        }
      }
    });
  };

  // Filter nodes by search query and category. Title/id/category/tag matching is instant;
  // contentMatchIds adds notes whose *body* matches (async full-text pass).
  const filteredNodes = nodes.filter(node => {
    const matchesSearch =
      node.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      node.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
      node.category.toLowerCase().includes(searchQuery.toLowerCase()) ||
      node.tags.some(t => t.toLowerCase().includes(searchQuery.toLowerCase())) ||
      contentMatchIds.includes(node.id);
      
    const matchesCategory = 
      selectedCategory === 'all' || 
      node.category === selectedCategory;

    return matchesSearch && matchesCategory;
  });

  return (
    <div style={listContainerStyle}>
      {/* Search Input */}
      <div style={searchWrapperStyle}>
        <Search size={14} style={searchIconStyle} />
        <input
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="Search memories or tags..."
          style={searchInputStyle}
        />
      </div>

      {/* Category Filter Chips */}
      <div style={chipsContainerStyle}>
        {CATEGORY_CHIPS.map(chip => (
          <button
            key={chip.value}
            onClick={() => setSelectedCategory(chip.value)}
            style={chipStyle(selectedCategory === chip.value, chip.color)}
          >
            {chip.label}
          </button>
        ))}
      </div>

      {/* Notes List */}
      <div style={listStyle}>
        {filteredNodes.length > 0 ? (
          filteredNodes.map(node => (
            <div
              key={node.id}
              onClick={() => handleNodeClick(node)}
              style={itemStyle(node.category)}
            >
              <div style={itemHeaderStyle}>
                <span style={itemTitleStyle}>{node.title}</span>
                <span style={itemCategoryStyle(node.category)}>{node.category}</span>
              </div>
              {node.tags.length > 0 && (
                <div style={tagsContainerStyle}>
                  {node.tags.map(t => (
                    <span key={t} style={tagStyle}>#{t}</span>
                  ))}
                </div>
              )}
            </div>
          ))
        ) : (
          <div style={emptyTextStyle}>No matching memory notes.</div>
        )}
      </div>

      {/* Snapshots Panel */}
      <div style={snapshotsPanelStyle}>
        <div style={sectionHeaderStyle}>
          <Camera size={14} />
          <span>Memory Snapshots</span>
        </div>

        <form onSubmit={handleTakeSnapshot} style={snapshotFormStyle}>
          <input
            required
            value={snapshotName}
            onChange={e => setSnapshotName(e.target.value)}
            placeholder="e.g. pre-refactor, v1-stable"
            style={snapshotInputStyle}
            disabled={snapshotLoading}
          />
          <button 
            type="submit" 
            style={snapshotBtnStyle}
            disabled={snapshotLoading || !snapshotName.trim()}
          >
            Backup
          </button>
        </form>

        <div style={snapshotsListStyle}>
          {snapshots.length > 0 ? (
            snapshots.map(name => (
              <div key={name} style={snapshotItemStyle}>
                <span style={snapshotNameStyle}>{name}</span>
                <button 
                  onClick={() => handleRestoreSnapshot(name)}
                  style={restoreBtnStyle}
                  disabled={snapshotLoading}
                  title="Restore this backup"
                >
                  <RefreshCw size={11} />
                  <span>Restore</span>
                </button>
              </div>
            ))
          ) : (
            <div style={emptySnapshotsStyle}>No backups created yet.</div>
          )}
        </div>
      </div>
    </div>
  );
};

/* --- Inline CSS Styles --- */

const listContainerStyle: React.CSSProperties = {
  width: '320px',
  borderRight: '1px solid var(--border)',
  backgroundColor: 'var(--bg-surface)',
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  flexShrink: 0,
};

const searchWrapperStyle: React.CSSProperties = {
  padding: '16px',
  position: 'relative',
  borderBottom: '1px solid var(--border)',
};

const searchIconStyle: React.CSSProperties = {
  position: 'absolute',
  left: '26px',
  top: '27px',
  color: 'var(--text-muted)',
};

const searchInputStyle: React.CSSProperties = {
  width: '100%',
  height: '32px',
  paddingLeft: '32px',
};

const chipsContainerStyle: React.CSSProperties = {
  padding: '12px 16px',
  display: 'flex',
  gap: '6px',
  flexWrap: 'wrap',
  borderBottom: '1px solid var(--border)',
  backgroundColor: 'var(--bg-surface-light)',
};

const chipStyle = (active: boolean, color: string): React.CSSProperties => ({
  fontSize: '11px',
  fontWeight: 600,
  padding: '4px 10px',
  borderRadius: 'var(--radius-full)',
  border: active ? `1.5px solid ${color}` : '1.5px solid var(--border)',
  backgroundColor: active ? 'var(--bg-surface-active)' : 'transparent',
  color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
  cursor: 'pointer',
  transition: 'all 0.15s',
});

const listStyle: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: '16px',
  display: 'flex',
  flexDirection: 'column',
  gap: '10px',
};

const itemStyle = (category: string): React.CSSProperties => {
  let color = 'var(--border)';
  if (category === 'decision') color = 'var(--mem-decision)';
  else if (category === 'architecture') color = 'var(--mem-architecture)';
  else if (category === 'pattern') color = 'var(--mem-pattern)';
  else if (category === 'bug') color = 'var(--mem-bug)';
  else if (category === 'handoff') color = 'var(--mem-handoff)';
  else if (category === 'review') color = 'var(--mem-review)';
  else if (category === 'general') color = '#9CA3AF';

  return {
    padding: '12px 16px',
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'var(--bg-surface-light)',
    border: '1px solid var(--border)',
    borderLeft: `3px solid ${color}`,
    cursor: 'pointer',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    transition: 'border-color 0.15s, background-color 0.15s',
  };
};

const itemHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '8px',
};

const itemTitleStyle: React.CSSProperties = {
  fontSize: '13px',
  fontWeight: 600,
  color: 'var(--text-primary)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const itemCategoryStyle = (category: string): React.CSSProperties => {
  let color = 'var(--text-muted)';
  if (category === 'decision') color = 'var(--mem-decision)';
  else if (category === 'architecture') color = 'var(--mem-architecture)';
  else if (category === 'pattern') color = 'var(--mem-pattern)';
  else if (category === 'bug') color = 'var(--mem-bug)';
  else if (category === 'handoff') color = 'var(--mem-handoff)';
  else if (category === 'review') color = 'var(--mem-review)';
  else if (category === 'general') color = 'var(--text-muted)';

  return {
    fontSize: '9px',
    fontWeight: 600,
    textTransform: 'uppercase',
    color,
  };
};

const tagsContainerStyle: React.CSSProperties = {
  display: 'flex',
  gap: '6px',
  flexWrap: 'wrap',
};

const tagStyle: React.CSSProperties = {
  fontSize: '10px',
  color: 'var(--text-muted)',
};

const emptyTextStyle: React.CSSProperties = {
  fontSize: '12.5px',
  color: 'var(--text-muted)',
  textAlign: 'center',
  padding: '24px 0',
};

const snapshotsPanelStyle: React.CSSProperties = {
  borderTop: '1px solid var(--border)',
  padding: '16px',
  backgroundColor: 'var(--bg-surface-light)',
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
};

const sectionHeaderStyle: React.CSSProperties = {
  fontSize: '11px',
  fontWeight: 600,
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
};

const snapshotFormStyle: React.CSSProperties = {
  display: 'flex',
  gap: '8px',
};

const snapshotInputStyle: React.CSSProperties = {
  flex: 1,
  height: '28px',
  fontSize: '12px',
};

const snapshotBtnStyle: React.CSSProperties = {
  height: '28px',
  fontSize: '12px',
  padding: '0 12px',
};

const snapshotsListStyle: React.CSSProperties = {
  maxHeight: '120px',
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
};

const snapshotItemStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '6px 8px',
  borderRadius: 'var(--radius-sm)',
  backgroundColor: 'var(--bg-surface)',
  border: '1px solid var(--border)',
};

const snapshotNameStyle: React.CSSProperties = {
  fontSize: '12px',
  color: 'var(--text-primary)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  maxWidth: '160px',
};

const restoreBtnStyle: React.CSSProperties = {
  height: '20px',
  fontSize: '10px',
  padding: '0 6px',
  backgroundColor: 'transparent',
  border: '1px solid var(--border)',
  color: 'var(--text-secondary)',
};

const emptySnapshotsStyle: React.CSSProperties = {
  fontSize: '11px',
  color: 'var(--text-muted)',
  textAlign: 'center',
  padding: '8px 0',
};

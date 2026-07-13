import React, { useEffect, useState, useMemo, useCallback } from 'react';
import {
  Folder, FolderOpen, File, ChevronDown, ChevronRight, Search, RefreshCw,
  FileCode, Terminal, Settings, BookOpen, ExternalLink, FilePlus, FolderPlus,
  Pencil, Trash2
} from 'lucide-react';
import { useFileStore, FileEntry } from '../../stores/fileStore';
import { useProjectStore } from '../../stores/projectStore';
import { useConfirmStore } from '../../stores/confirmStore';
import { useNotificationStore } from '../../stores/notificationStore';

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
}

// git status -> single-letter badge + color token.
const STATUS_BADGE: Record<string, { letter: string; color: string }> = {
  modified: { letter: 'M', color: 'var(--warning, #f59e0b)' },
  added: { letter: 'A', color: 'var(--success, #22c55e)' },
  untracked: { letter: 'U', color: 'var(--accent, #38bdf8)' },
  deleted: { letter: 'D', color: 'var(--danger, #ef4444)' },
};

const getFileIcon = (fileName: string) => {
  const ext = fileName.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'js':
    case 'jsx':
    case 'ts':
    case 'tsx':
      return { icon: FileCode, color: '#38bdf8' }; // JS/TS Sky Blue
    case 'json':
    case 'toml':
    case 'yaml':
    case 'yml':
      return { icon: Settings, color: '#34d399' }; // Config Emerald Green
    case 'css':
    case 'scss':
      return { icon: FileCode, color: '#f472b6' }; // CSS Pink
    case 'html':
      return { icon: FileCode, color: '#fb923c' }; // HTML Orange
    case 'md':
      return { icon: BookOpen, color: '#a78bfa' }; // Markdown Violet
    case 'rs':
      return { icon: Terminal, color: '#f97316' }; // Rust Orange/Red
    case 'sh':
    case 'bat':
    case 'cmd':
    case 'ps1':
      return { icon: Terminal, color: '#22c55e' }; // Shell scripts
    default:
      return { icon: File, color: 'var(--text-muted)' };
  }
};

const buildTree = (files: FileEntry[]): TreeNode[] => {
  const rootNodes: TreeNode[] = [];
  const nodeMap = new Map<string, TreeNode>();

  // Create nodes
  for (const file of files) {
    nodeMap.set(file.path, {
      name: file.name,
      path: file.path,
      isDir: file.isDir,
      children: [],
    });
  }

  // Populate children
  for (const file of files) {
    const node = nodeMap.get(file.path)!;
    const parts = file.path.split('/');
    if (parts.length === 1) {
      rootNodes.push(node);
    } else {
      const parentPath = parts.slice(0, -1).join('/');
      let parentNode = nodeMap.get(parentPath);

      if (!parentNode) {
        parentNode = {
          name: parts[parts.length - 2],
          path: parentPath,
          isDir: true,
          children: [],
        };
        nodeMap.set(parentPath, parentNode);

        const grandparentParts = parentPath.split('/');
        if (grandparentParts.length === 1) {
          rootNodes.push(parentNode);
        } else {
          const grandparentPath = grandparentParts.slice(0, -1).join('/');
          const grandparentNode = nodeMap.get(grandparentPath);
          if (grandparentNode) {
            grandparentNode.children.push(parentNode);
          } else {
            rootNodes.push(parentNode);
          }
        }
      }
      parentNode.children.push(node);
    }
  }

  // Sort recursively
  const sortTreeNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.isDir !== b.isDir) {
        return a.isDir ? -1 : 1;
      }
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
    for (const node of nodes) {
      if (node.isDir) {
        sortTreeNodes(node.children);
      }
    }
  };

  sortTreeNodes(rootNodes);
  return rootNodes;
};

interface FileTreeNodeProps {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  toggleFolder: (path: string) => void;
  handleFileClick: (path: string) => void;
  handleOpenExternal: (path: string, e: React.MouseEvent) => void;
  handleContextMenu: (node: TreeNode, e: React.MouseEvent) => void;
  gitStatus: Record<string, string>;
  activeFile: string | null;
}

const FileTreeNodeItem: React.FC<FileTreeNodeProps> = ({
  node,
  depth,
  expanded,
  toggleFolder,
  handleFileClick,
  handleOpenExternal,
  handleContextMenu,
  gitStatus,
  activeFile,
}) => {
  const isFolderExpanded = expanded.has(node.path);
  const isActive = activeFile === node.path;
  const badge = !node.isDir ? STATUS_BADGE[gitStatus[node.path]] : undefined;

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (node.isDir) {
      toggleFolder(node.path);
    } else {
      handleFileClick(node.path);
    }
  };

  const { icon: FileIcon, color: iconColor } = node.isDir
    ? { icon: isFolderExpanded ? FolderOpen : Folder, color: '#fbbf24' }
    : getFileIcon(node.name);

  return (
    <div className="file-tree-node-wrapper">
      <div
        className={`file-tree-node ${isActive ? 'active' : ''} ${node.isDir ? 'directory' : 'file'} ${badge ? 'has-git' : ''}`}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={handleClick}
        onContextMenu={(e) => handleContextMenu(node, e)}
        role="treeitem"
        aria-selected={isActive}
      >
        {/* Render vertical indentation guidelines */}
        {Array.from({ length: depth }).map((_, i) => (
          <div
            key={i}
            className="file-tree-indent-guide"
            style={{ left: `${i * 12 + 14}px` }}
          />
        ))}

        <span className="folder-chevron">
          {node.isDir ? (
            isFolderExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />
          ) : (
            <span className="folder-chevron-spacer" />
          )}
        </span>

        <span className="node-icon" style={{ color: iconColor }}>
          <FileIcon size={14} />
        </span>

        <span className="node-name" title={node.path} style={badge ? { color: badge.color } : undefined}>
          {node.name}
        </span>

        {badge && (
          <span className="git-badge" style={{ color: badge.color }} title={gitStatus[node.path]}>
            {badge.letter}
          </span>
        )}

        {!node.isDir && (
          <button
            className="node-action-btn"
            title="Open in external editor"
            onClick={(e) => handleOpenExternal(node.path, e)}
          >
            <ExternalLink size={12} />
          </button>
        )}
      </div>

      {node.isDir && isFolderExpanded && node.children.length > 0 && (
        <div className="file-tree-children">
          {node.children.map(child => (
            <FileTreeNodeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              toggleFolder={toggleFolder}
              handleFileClick={handleFileClick}
              handleOpenExternal={handleOpenExternal}
              handleContextMenu={handleContextMenu}
              gitStatus={gitStatus}
              activeFile={activeFile}
            />
          ))}
        </div>
      )}
    </div>
  );
};

// State for the inline name prompt (new file / new folder / rename).
type PromptState =
  | { mode: 'newFile' | 'newFolder'; baseDir: string; value: string }
  | { mode: 'rename'; targetPath: string; value: string }
  | null;

// State for the right-click menu.
type MenuState = { x: number; y: number; node: TreeNode | null } | null;

const parentDir = (path: string) => {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
};

export const FileTree: React.FC = () => {
  const { currentProjectPath } = useProjectStore();
  const {
    files, activeFile, gitStatus, expanded, toggleExpanded, setExpandedPaths,
    loadFiles, loadGitStatus, openFile, openExternal,
    createFile, createDirectory, renamePath, deletePath, loading, error,
  } = useFileStore();
  const [search, setSearch] = useState('');
  const [menu, setMenu] = useState<MenuState>(null);
  const [prompt, setPrompt] = useState<PromptState>(null);

  const notifyError = (msg: string) => useNotificationStore.getState().error(msg);

  const refresh = useCallback(() => {
    if (!currentProjectPath) return;
    loadFiles(currentProjectPath);
    loadGitStatus(currentProjectPath);
  }, [currentProjectPath, loadFiles, loadGitStatus]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Automatically expand parent directories when activeFile changes
  useEffect(() => {
    if (!activeFile) return;
    const parts = activeFile.split('/');
    if (parts.length <= 1) return;
    const chain: string[] = [];
    let currentPath = '';
    for (let i = 0; i < parts.length - 1; i++) {
      currentPath = currentPath ? `${currentPath}/${parts[i]}` : parts[i];
      chain.push(currentPath);
    }
    setExpandedPaths(chain);
  }, [activeFile, setExpandedPaths]);

  // Close the context menu on any outside click or Escape.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const handleFileClick = (path: string) => {
    if (currentProjectPath) {
      openFile(currentProjectPath, path);
    }
  };

  const handleOpenExternal = (path: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (currentProjectPath) {
      openExternal(currentProjectPath, path);
    }
  };

  const handleContextMenu = (node: TreeNode, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, node });
  };

  // Base directory for a new file/folder given the clicked node (folder itself, or a file's parent).
  const baseDirFor = (node: TreeNode | null) =>
    node ? (node.isDir ? node.path : parentDir(node.path)) : '';

  const submitPrompt = async () => {
    if (!prompt || !currentProjectPath) return;
    const name = prompt.value.trim();
    if (!name) { setPrompt(null); return; }
    try {
      if (prompt.mode === 'rename') {
        const dir = parentDir(prompt.targetPath);
        const dest = dir ? `${dir}/${name}` : name;
        await renamePath(currentProjectPath, prompt.targetPath, dest);
      } else {
        const p = prompt.baseDir ? `${prompt.baseDir}/${name}` : name;
        if (prompt.mode === 'newFile') {
          await createFile(currentProjectPath, p);
          openFile(currentProjectPath, p);
        } else {
          await createDirectory(currentProjectPath, p);
          setExpandedPaths([p]);
        }
      }
    } catch (err) {
      notifyError(String(err));
    } finally {
      setPrompt(null);
    }
  };

  const handleDelete = (node: TreeNode) => {
    if (!currentProjectPath) return;
    useConfirmStore.getState().confirm({
      title: `Delete ${node.isDir ? 'folder' : 'file'}?`,
      message: `"${node.path}" will be moved to the recycle bin.`,
      confirmLabel: 'Move to Recycle Bin',
      onConfirm: () => {
        deletePath(currentProjectPath, node.path).catch((err) => notifyError(String(err)));
      },
    });
  };

  // Build the hierarchical tree from files when not searching
  const fileTree = useMemo(() => {
    if (search.trim() !== '') return [];
    return buildTree(files);
  }, [files, search]);

  // Filter flat list for search queries
  const searchedFiles = useMemo(() => {
    if (search.trim() === '') return [];
    const query = search.toLowerCase();
    return files
      .filter(file => file.name.toLowerCase().includes(query))
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });
  }, [files, search]);

  return (
    <div className="file-tree-sidebar">
      <div className="file-tree-search-row">
        <div className="search-input-wrapper">
          <Search size={13} className="search-icon" />
          <input
            type="text"
            placeholder="Filter files..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <button
          onClick={() => setPrompt({ mode: 'newFile', baseDir: '', value: '' })}
          className="refresh-btn icon-button"
          title="New file in workspace root"
          disabled={!currentProjectPath}
        >
          <FilePlus size={13} />
        </button>
        <button
          onClick={() => setPrompt({ mode: 'newFolder', baseDir: '', value: '' })}
          className="refresh-btn icon-button"
          title="New folder in workspace root"
          disabled={!currentProjectPath}
        >
          <FolderPlus size={13} />
        </button>
        <button
          onClick={refresh}
          className="refresh-btn icon-button"
          title="Refresh file tree"
          disabled={loading}
        >
          <RefreshCw size={13} className={loading ? 'spinning' : ''} />
        </button>
      </div>

      {prompt && (
        <div className="file-tree-prompt">
          <input
            autoFocus
            value={prompt.value}
            placeholder={
              prompt.mode === 'rename'
                ? 'New name'
                : prompt.mode === 'newFolder'
                  ? 'New folder name'
                  : 'New file name'
            }
            onChange={(e) => setPrompt({ ...prompt, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitPrompt();
              else if (e.key === 'Escape') setPrompt(null);
            }}
            onBlur={() => setPrompt(null)}
          />
        </div>
      )}

      <div className="file-tree-list" role="tree">
        {error ? (
          <div className="file-tree-empty-error compact-empty">
            {error}
          </div>
        ) : loading && files.length === 0 ? (
          <div className="compact-empty">Loading file list...</div>
        ) : search.trim() !== '' ? (
          /* Flat list for search matches */
          searchedFiles.length === 0 ? (
            <div className="compact-empty">No matching files.</div>
          ) : (
            searchedFiles.map(file => {
              const { icon: FileIcon, color: iconColor } = file.isDir
                ? { icon: Folder, color: '#fbbf24' }
                : getFileIcon(file.name);
              const isActive = activeFile === file.path;

              return (
                <div
                  key={file.path}
                  className={`file-tree-node flat-match ${isActive ? 'active' : ''}`}
                  onClick={() => file.isDir ? toggleExpanded(file.path) : handleFileClick(file.path)}
                >
                  <span className="node-icon" style={{ color: iconColor }}>
                    <FileIcon size={14} />
                  </span>
                  <div className="node-search-details">
                    <span className="node-name">{file.name}</span>
                    <span className="node-path">{file.path}</span>
                  </div>
                  {!file.isDir && (
                    <button
                      className="node-action-btn"
                      title="Open in external editor"
                      onClick={(e) => handleOpenExternal(file.path, e)}
                    >
                      <ExternalLink size={12} />
                    </button>
                  )}
                </div>
              );
            })
          )
        ) : (
          /* Hierarchical tree list */
          fileTree.length === 0 ? (
            <div className="compact-empty">No files found in workspace.</div>
          ) : (
            fileTree.map(node => (
              <FileTreeNodeItem
                key={node.path}
                node={node}
                depth={0}
                expanded={expanded}
                toggleFolder={toggleExpanded}
                handleFileClick={handleFileClick}
                handleOpenExternal={handleOpenExternal}
                handleContextMenu={handleContextMenu}
                gitStatus={gitStatus}
                activeFile={activeFile}
              />
            ))
          )
        )}
      </div>

      {menu && (
        <div
          className="tree-context-menu"
          style={{ top: menu.y, left: menu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <button onClick={() => { setPrompt({ mode: 'newFile', baseDir: baseDirFor(menu.node), value: '' }); setMenu(null); }}>
            <FilePlus size={13} /> New File
          </button>
          <button onClick={() => { setPrompt({ mode: 'newFolder', baseDir: baseDirFor(menu.node), value: '' }); setMenu(null); }}>
            <FolderPlus size={13} /> New Folder
          </button>
          {menu.node && (
            <>
              <div className="tree-context-sep" />
              <button onClick={() => { setPrompt({ mode: 'rename', targetPath: menu.node!.path, value: menu.node!.name }); setMenu(null); }}>
                <Pencil size={13} /> Rename
              </button>
              <button className="danger" onClick={() => { const n = menu.node!; setMenu(null); handleDelete(n); }}>
                <Trash2 size={13} /> Delete
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
};

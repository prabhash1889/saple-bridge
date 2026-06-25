import React, { useEffect, useState, useMemo } from 'react';
import { 
  Folder, FolderOpen, File, ChevronDown, ChevronRight, Search, RefreshCw,
  FileCode, Terminal, Settings, BookOpen, ExternalLink
} from 'lucide-react';
import { useFileStore, FileEntry } from '../../stores/fileStore';
import { useProjectStore } from '../../stores/projectStore';

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
}

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
  activeFile: string | null;
}

const FileTreeNodeItem: React.FC<FileTreeNodeProps> = ({
  node,
  depth,
  expanded,
  toggleFolder,
  handleFileClick,
  handleOpenExternal,
  activeFile,
}) => {
  const isFolderExpanded = expanded.has(node.path);
  const isActive = activeFile === node.path;

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
        className={`file-tree-node ${isActive ? 'active' : ''} ${node.isDir ? 'directory' : 'file'}`}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={handleClick}
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

        <span className="node-name" title={node.path}>
          {node.name}
        </span>

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
              activeFile={activeFile}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export const FileTree: React.FC = () => {
  const { currentProjectPath } = useProjectStore();
  const { files, activeFile, loadFiles, loadFileContent, openExternal, loading, error } = useFileStore();
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (currentProjectPath) {
      loadFiles(currentProjectPath);
    }
  }, [currentProjectPath, loadFiles]);

  // Automatically expand parent directories when activeFile changes
  useEffect(() => {
    if (activeFile) {
      const parts = activeFile.split('/');
      if (parts.length > 1) {
        setExpanded(prev => {
          const next = new Set(prev);
          let currentPath = '';
          for (let i = 0; i < parts.length - 1; i++) {
            currentPath = currentPath ? `${currentPath}/${parts[i]}` : parts[i];
            next.add(currentPath);
          }
          return next;
        });
      }
    }
  }, [activeFile]);

  const toggleFolder = (path: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const handleFileClick = (path: string) => {
    if (currentProjectPath) {
      loadFileContent(currentProjectPath, path);
    }
  };

  const handleOpenExternal = (path: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (currentProjectPath) {
      openExternal(currentProjectPath, path);
    }
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
            placeholder="Search files..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <button 
          onClick={() => currentProjectPath && loadFiles(currentProjectPath)} 
          className="refresh-btn icon-button"
          title="Refresh file tree"
          disabled={loading}
        >
          <RefreshCw size={13} className={loading ? 'spinning' : ''} />
        </button>
      </div>

      <div className="file-tree-list" role="tree">
        {error ? (
          <div className="compact-empty" style={{ color: 'var(--color-danger)', padding: '8px 12px', fontSize: '12px' }}>
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
                  style={{ paddingLeft: '8px' }}
                  onClick={() => file.isDir ? toggleFolder(file.path) : handleFileClick(file.path)}
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
                toggleFolder={toggleFolder}
                handleFileClick={handleFileClick}
                handleOpenExternal={handleOpenExternal}
                activeFile={activeFile}
              />
            ))
          )
        )}
      </div>
    </div>
  );
};

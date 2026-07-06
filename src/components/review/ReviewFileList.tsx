import React from 'react';
import { Check } from 'lucide-react';
import { GitFileStatus } from '../../stores/reviewStore';

interface ReviewFileListProps {
  changedFiles: GitFileStatus[];
  selectedFile: string | null;
  onSelectFile: (path: string) => void;
  onToggleStaged: (path: string, staged: boolean) => void;
  stagedCount: number;
  commitMessage: string;
  onCommitMessageChange: (value: string) => void;
  committing: boolean;
  onCommit: () => void;
}

// The changed-files list + stage checkboxes and the commit bar underneath (C3).
export const ReviewFileList: React.FC<ReviewFileListProps> = ({
  changedFiles,
  selectedFile,
  onSelectFile,
  onToggleStaged,
  stagedCount,
  commitMessage,
  onCommitMessageChange,
  committing,
  onCommit,
}) => (
  <>
    <div className="file-list-container">
      {changedFiles.length === 0 ? (
        <div className="extracted-style-108 compact-empty">No files changed.</div>
      ) : (
        changedFiles.map((file) => {
          const fileClass = file.path === selectedFile ? 'active' : '';
          return (
            <div
              key={file.path}
              className={`file-item ${fileClass}`}
              onClick={() => onSelectFile(file.path)}
            >
              <input
                type="checkbox"
                className="file-stage-checkbox"
                checked={!!file.staged}
                onClick={(e) => e.stopPropagation()}
                onChange={() => onToggleStaged(file.path, !file.staged)}
                title={file.staged ? 'Unstage file' : 'Stage file for commit'}
                aria-label={`Stage ${file.path} for commit`}
              />
              <span className="file-path" title={file.path}>{file.path}</span>
              <div className="file-badges">
                <span className="extracted-style-109 eyebrow">{file.status}</span>
                {file.insertions !== undefined && (
                  <span className="badge-ins">+{file.insertions}</span>
                )}
                {file.deletions !== undefined && (
                  <span className="badge-del">-{file.deletions}</span>
                )}
              </div>
            </div>
          );
        })
      )}
    </div>

    {changedFiles.length > 0 && (
      <div className="review-commit-bar">
        <input
          className="review-commit-input"
          value={commitMessage}
          placeholder={stagedCount > 0 ? 'Commit message (e.g. "fix: ...")' : 'Stage files above to commit'}
          spellCheck={false}
          onChange={(e) => onCommitMessageChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onCommit();
            }
          }}
        />
        <button
          className="review-commit-btn"
          disabled={committing || stagedCount === 0 || !commitMessage.trim()}
          onClick={onCommit}
          title="git commit the staged files"
        >
          <Check size={13} />
          <span>{committing ? 'Committing...' : `Commit${stagedCount > 0 ? ` (${stagedCount})` : ''}`}</span>
        </button>
      </div>
    )}
  </>
);

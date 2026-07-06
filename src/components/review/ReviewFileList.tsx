import React from 'react';
import { Check, Eye } from 'lucide-react';
import { GitFileStatus } from '../../stores/reviewStore';

const COMMIT_PREFIXES = ['feat', 'fix', 'docs', 'refactor', 'test', 'chore'];

interface ReviewFileListProps {
  changedFiles: GitFileStatus[];
  viewedFiles: string[];
  selectedFile: string | null;
  onSelectFile: (path: string) => void;
  onToggleStaged: (path: string, staged: boolean) => void;
  onToggleViewed: (path: string, viewed: boolean) => void;
  stagedCount: number;
  commitMessage: string;
  onCommitMessageChange: (value: string) => void;
  committing: boolean;
  onCommit: () => void;
}

// The changed-files list + stage checkboxes and the commit bar underneath (C3).
export const ReviewFileList: React.FC<ReviewFileListProps> = ({
  changedFiles,
  viewedFiles,
  selectedFile,
  onSelectFile,
  onToggleStaged,
  onToggleViewed,
  stagedCount,
  commitMessage,
  onCommitMessageChange,
  committing,
  onCommit,
}) => {
  const stagedFiles = changedFiles.filter((f) => f.staged);
  const stagedInsertions = stagedFiles.reduce((sum, f) => sum + (f.insertions ?? 0), 0);
  const stagedDeletions = stagedFiles.reduce((sum, f) => sum + (f.deletions ?? 0), 0);
  const viewedCount = changedFiles.filter((f) => viewedFiles.includes(f.path)).length;

  // Prepend (or replace) a conventional-commit prefix on the message.
  const applyPrefix = (prefix: string) => {
    const stripped = commitMessage.replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, '');
    onCommitMessageChange(`${prefix}: ${stripped}`);
  };

  return (
    <>
      <div className="file-list-container">
        {changedFiles.length === 0 ? (
          <div className="review-file-list-empty compact-empty">No files changed.</div>
        ) : (
          changedFiles.map((file) => {
            const viewed = viewedFiles.includes(file.path);
            const fileClass = `${file.path === selectedFile ? 'active' : ''} ${viewed ? 'viewed' : ''}`;
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
                  <span className="review-file-status eyebrow">{file.status}</span>
                  {file.insertions !== undefined && (
                    <span className="badge-ins">+{file.insertions}</span>
                  )}
                  {file.deletions !== undefined && (
                    <span className="badge-del">-{file.deletions}</span>
                  )}
                  <button
                    className={`file-viewed-btn ${viewed ? 'viewed' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleViewed(file.path, !viewed);
                    }}
                    title={viewed ? 'Mark as not viewed' : 'Mark as viewed'}
                    aria-label={`Mark ${file.path} as ${viewed ? 'not viewed' : 'viewed'}`}
                  >
                    {viewed ? <Check size={13} /> : <Eye size={13} />}
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {changedFiles.length > 0 && (
        <div className="review-commit-bar">
          <span
            className="review-staged-summary"
            title={`${viewedCount}/${changedFiles.length} files viewed`}
          >
            {stagedCount > 0
              ? `${stagedCount} staged · +${stagedInsertions} −${stagedDeletions}`
              : `${viewedCount}/${changedFiles.length} viewed`}
          </span>
          <select
            className="review-commit-prefix"
            value=""
            onChange={(e) => {
              if (e.target.value) applyPrefix(e.target.value);
            }}
            title="Insert conventional-commit prefix"
            aria-label="Insert conventional-commit prefix"
          >
            <option value="">prefix</option>
            {COMMIT_PREFIXES.map((p) => (
              <option key={p} value={p}>{p}:</option>
            ))}
          </select>
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
};

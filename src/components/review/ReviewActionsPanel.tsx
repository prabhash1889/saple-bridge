import React from 'react';
import { Award, Check, CheckCircle2, FileText, ShieldAlert, Terminal, XCircle } from 'lucide-react';
import { Task } from '../../stores/kanbanStore';
import { ReviewRecord } from '../../stores/reviewStore';

interface ReviewActionsPanelProps {
  activeTask: Task | undefined;
  activeRecord: ReviewRecord | null;
  rejecting: boolean;
  notes: string;
  onNotesChange: (value: string) => void;
  submittingDecision: boolean;
  runningVerification: boolean;
  memoryCreated: boolean;
  onApprove: () => void;
  onReject: () => void;
  onCancelReject: () => void;
  onCreateMemory: () => void;
}

// The right-hand "Actions & Context" column: task brief, target files, acceptance
// checklist, agent metadata, and the approve/reject + memory-note actions.
export const ReviewActionsPanel: React.FC<ReviewActionsPanelProps> = ({
  activeTask,
  activeRecord,
  rejecting,
  notes,
  onNotesChange,
  submittingDecision,
  runningVerification,
  memoryCreated,
  onApprove,
  onReject,
  onCancelReject,
  onCreateMemory,
}) => (
  <section className="surface review-side">
    <div className="panel-heading">
      <Terminal size={16} />
      <span>Actions & Context</span>
    </div>

    {activeTask ? (
      <div className="side-panel-content">
        <div>
          <h4 className="review-section-heading">Task Brief</h4>
          <p className="review-brief-text">
            {activeTask.description || 'No description provided.'}
          </p>
        </div>

        {activeTask.targetFiles && activeTask.targetFiles.length > 0 && (
          <div>
            <h4 className="review-section-heading">Expected Target Files</h4>
            <div className="review-target-files">
              {activeTask.targetFiles.map(f => (
                <span key={f} className="review-target-file-pill status-pill command">
                  {f}
                </span>
              ))}
            </div>
          </div>
        )}

        {activeTask.acceptanceCriteria && activeTask.acceptanceCriteria.length > 0 && (
          <div>
            <h4 className="review-section-heading">Acceptance Checklist</h4>
            <div className="review-criteria-list">
              {activeTask.acceptanceCriteria.map((c, i) => (
                <div key={i} className="review-criteria-item">
                  <CheckCircle2 size={13} aria-hidden className="criteria-marker" />
                  <span>{c}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeRecord && (
          <div>
            <h4 className="review-section-heading">Agent Metadata</h4>
            <div className="review-metadata">
              <div><strong>Provider:</strong> {activeRecord.provider}</div>
              <div><strong>Model:</strong> {activeRecord.model}</div>
              <div><strong>Role:</strong> {activeRecord.role}</div>
            </div>
          </div>
        )}

        {/* Actions Section */}
        {activeRecord && activeRecord.status === 'pending' && (
          <div className="review-action-buttons review-side-footer">
            {rejecting && (
              <div className="rejection-notes-box">
                <span className="review-rejection-label eyebrow">Rejection Feedback</span>
                <textarea
                  value={notes}
                  onChange={(e) => onNotesChange(e.target.value)}
                  placeholder="Explain what needs to be fixed. The agent will read these notes..."
                  disabled={submittingDecision}
                />
              </div>
            )}

            <div className="review-decision-actions">
              <button
                className={`review-decision-btn danger ${rejecting ? 'primary' : ''}`}
                onClick={onReject}
                disabled={submittingDecision || runningVerification}
              >
                <XCircle size={14} />
                <span>{rejecting ? 'Submit Rejection' : 'Reject'}</span>
              </button>
              {!rejecting && (
                <button
                  className="review-decision-btn primary"
                  onClick={onApprove}
                  disabled={submittingDecision || runningVerification}
                >
                  <Check size={14} />
                  <span>Approve</span>
                </button>
              )}
            </div>

            {rejecting && (
              <button
                className="secondary-action"
                onClick={onCancelReject}
                disabled={submittingDecision}
              >
                Cancel
              </button>
            )}
          </div>
        )}

        {activeRecord && activeRecord.status !== 'pending' && (
          <div className="review-outcome-panel review-side-footer">
            <div className="review-outcome-status">
              {activeRecord.status === 'approved' ? (
                <>
                  <Award className="success-icon" size={16} />
                  <span className="review-outcome-label">Review Approved</span>
                </>
              ) : (
                <>
                  <ShieldAlert className="warning-icon" size={16} />
                  <span className="review-outcome-label">Review Rejected</span>
                </>
              )}
            </div>
            {activeRecord.notes && (
              <div className="review-notes-box">
                <strong>Rejection Notes:</strong>
                <p className="review-notes-text">{activeRecord.notes}</p>
              </div>
            )}

            {/* Create Memory Note */}
            <button
              className="review-reopen-btn secondary-action"
              onClick={onCreateMemory}
              disabled={memoryCreated}
            >
              <FileText size={14} />
              <span>{memoryCreated ? 'Memory Created' : 'Create Memory Note'}</span>
            </button>
          </div>
        )}
      </div>
    ) : (
      <div className="compact-empty">Select a task to review context.</div>
    )}
  </section>
);

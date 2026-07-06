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
          <h4 className="extracted-style-090">Task Brief</h4>
          <p className="extracted-style-091">
            {activeTask.description || 'No description provided.'}
          </p>
        </div>

        {activeTask.targetFiles && activeTask.targetFiles.length > 0 && (
          <div>
            <h4 className="extracted-style-092">Expected Target Files</h4>
            <div className="extracted-style-093">
              {activeTask.targetFiles.map(f => (
                <span key={f} className="extracted-style-094 status-pill command">
                  {f}
                </span>
              ))}
            </div>
          </div>
        )}

        {activeTask.acceptanceCriteria && activeTask.acceptanceCriteria.length > 0 && (
          <div>
            <h4 className="extracted-style-095">Acceptance Checklist</h4>
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
            <h4 className="extracted-style-096">Agent Metadata</h4>
            <div className="extracted-style-097">
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
                <span className="extracted-style-098 eyebrow">Rejection Feedback</span>
                <textarea
                  value={notes}
                  onChange={(e) => onNotesChange(e.target.value)}
                  placeholder="Explain what needs to be fixed. The agent will read these notes..."
                  disabled={submittingDecision}
                />
              </div>
            )}

            <div className="extracted-style-099">
              <button
                className={[`danger ${rejecting ? 'primary' : ''}`, 'extracted-style-282'].filter(Boolean).join(' ')}
                onClick={onReject}
                disabled={submittingDecision || runningVerification}
              >
                <XCircle size={14} />
                <span>{rejecting ? 'Submit Rejection' : 'Reject'}</span>
              </button>
              {!rejecting && (
                <button
                  className="extracted-style-100 primary"
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
          <div className="extracted-style-101 review-side-footer">
            <div className="extracted-style-102">
              {activeRecord.status === 'approved' ? (
                <>
                  <Award className="success-icon" size={16} />
                  <span className="extracted-style-103">Review Approved</span>
                </>
              ) : (
                <>
                  <ShieldAlert className="warning-icon" size={16} />
                  <span className="extracted-style-104">Review Rejected</span>
                </>
              )}
            </div>
            {activeRecord.notes && (
              <div className="extracted-style-105">
                <strong>Rejection Notes:</strong>
                <p className="extracted-style-106">{activeRecord.notes}</p>
              </div>
            )}

            {/* Create Memory Note */}
            <button
              className="extracted-style-107 secondary-action"
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

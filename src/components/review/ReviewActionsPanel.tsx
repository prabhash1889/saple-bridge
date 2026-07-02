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
          <h4 style={{ margin: '0 0 6px 0', fontSize: '13px' }}>Task Brief</h4>
          <p style={{ margin: 0, fontSize: '12px', color: 'var(--text-secondary)' }}>
            {activeTask.description || 'No description provided.'}
          </p>
        </div>

        {activeTask.targetFiles && activeTask.targetFiles.length > 0 && (
          <div>
            <h4 style={{ margin: '0 0 6px 0', fontSize: '13px' }}>Expected Target Files</h4>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
              {activeTask.targetFiles.map(f => (
                <span key={f} className="status-pill command" style={{ fontSize: '10px', fontFamily: 'monospace' }}>
                  {f}
                </span>
              ))}
            </div>
          </div>
        )}

        {activeTask.acceptanceCriteria && activeTask.acceptanceCriteria.length > 0 && (
          <div>
            <h4 style={{ margin: '0 0 6px 0', fontSize: '13px' }}>Acceptance Checklist</h4>
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
            <h4 style={{ margin: '0 0 6px 0', fontSize: '13px' }}>Agent Metadata</h4>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
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
                <span className="eyebrow" style={{ fontSize: '10px', color: 'var(--color-danger)' }}>Rejection Feedback</span>
                <textarea
                  value={notes}
                  onChange={(e) => onNotesChange(e.target.value)}
                  placeholder="Explain what needs to be fixed. The agent will read these notes..."
                  disabled={submittingDecision}
                />
              </div>
            )}

            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                className={`danger ${rejecting ? 'primary' : ''}`}
                onClick={onReject}
                disabled={submittingDecision || runningVerification}
                style={{ flex: 1, padding: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
              >
                <XCircle size={14} />
                <span>{rejecting ? 'Submit Rejection' : 'Reject'}</span>
              </button>
              {!rejecting && (
                <button
                  className="primary"
                  onClick={onApprove}
                  disabled={submittingDecision || runningVerification}
                  style={{ flex: 1, padding: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
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
          <div className="review-side-footer" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px' }}>
              {activeRecord.status === 'approved' ? (
                <>
                  <Award className="success-icon" size={16} />
                  <span style={{ fontWeight: 'bold' }}>Review Approved</span>
                </>
              ) : (
                <>
                  <ShieldAlert className="warning-icon" size={16} />
                  <span style={{ fontWeight: 'bold' }}>Review Rejected</span>
                </>
              )}
            </div>
            {activeRecord.notes && (
              <div style={{ background: 'var(--bg-card)', padding: '10px', borderRadius: '4px', fontSize: '12px', border: '1px solid var(--border)' }}>
                <strong>Rejection Notes:</strong>
                <p style={{ margin: '4px 0 0 0', whiteSpace: 'pre-wrap', color: 'var(--text-secondary)' }}>{activeRecord.notes}</p>
              </div>
            )}

            {/* Create Memory Note */}
            <button
              className="secondary-action"
              onClick={onCreateMemory}
              disabled={memoryCreated}
              style={{ display: 'flex', alignItems: 'center', gap: '6px', width: '100%', justifyContent: 'center', padding: '8px' }}
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

export type ReviewDecision = 'pending' | 'approved' | 'rejected';

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'unknown';
  insertions?: number;
  deletions?: number;
}

export interface ReviewRecord {
  taskId: string;
  sessionId?: string;
  decision: ReviewDecision;
  summary?: string;
  notes?: string;
  changedFiles: ChangedFile[];
  testOutput?: string;
  createdAt: string;
  updatedAt: string;
  decidedAt?: string;
}

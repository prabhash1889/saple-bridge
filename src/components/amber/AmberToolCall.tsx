import { useState } from 'react';
import { ChevronDown, ChevronRight, Wrench } from 'lucide-react';
import type { AmberToolResult } from '../../stores/amberStore';

interface Props {
  name: string;
  /** Tool input (only known from the persisted/canonical log, not from live events). */
  input?: unknown;
  /** Result, once available. */
  result?: AmberToolResult;
  /** Live status while a run is in flight. */
  liveStatus?: 'running' | 'done' | 'error';
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Collapsible card for a single tool call (name, status, args, result). No disclosure primitive
 * exists in the codebase, so this is a small useState toggle modeled on SwarmAgentCard's structure.
 */
export function AmberToolCall({ name, input, result, liveStatus }: Props) {
  const [open, setOpen] = useState(false);
  const status: 'running' | 'done' | 'error' =
    liveStatus ?? (result ? (result.isError ? 'error' : 'done') : 'done');
  const statusLabel = status === 'running' ? 'running…' : status === 'error' ? 'error' : 'done';

  return (
    <div className={`amber-tool amber-tool-${status}`}>
      <button className="amber-tool-header" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Wrench size={14} />
        <span className="amber-tool-name">{name}</span>
        <span className="amber-tool-status">{statusLabel}</span>
      </button>
      {open && (
        <div className="amber-tool-body">
          {input !== undefined && (
            <>
              <div className="amber-tool-label">Arguments</div>
              <pre className="amber-tool-pre">{prettyJson(input)}</pre>
            </>
          )}
          {result && (
            <>
              <div className="amber-tool-label">Result</div>
              <pre className="amber-tool-pre">{result.content}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

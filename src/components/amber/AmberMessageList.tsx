import { Fragment, useEffect, useMemo, useRef } from 'react';
import { Sparkles } from 'lucide-react';
import { useAmberStore, type AmberToolResult } from '../../stores/amberStore';
import { AmberMessage } from './AmberMessage';
import { AmberToolCall } from './AmberToolCall';

/**
 * Renders the committed conversation plus the in-flight turn. Tool results live in their own
 * `tool_results` message; we index them by id and attach each to its originating `tool_use` block
 * so a tool call and its output render as one card.
 */
export function AmberMessageList() {
  const messages = useAmberStore((s) => s.messages);
  const streamingText = useAmberStore((s) => s.streamingText);
  const liveToolCalls = useAmberStore((s) => s.liveToolCalls);
  const isRunning = useAmberStore((s) => s.isRunning);
  const runError = useAmberStore((s) => s.runError);

  const resultLookup = useMemo(() => {
    const map = new Map<string, AmberToolResult>();
    for (const m of messages) {
      if (m.role === 'tool_results') {
        for (const r of m.results) map.set(r.toolUseId, r);
      }
    }
    return map;
  }, [messages]);

  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, streamingText, liveToolCalls, isRunning]);

  const empty = messages.length === 0 && !isRunning && !runError;

  return (
    <div className="amber-messages">
      {empty && (
        <div className="amber-empty">
          <Sparkles size={28} />
          <h2>Amber</h2>
          <p>Chat with a model that can read & write project files, run commands, and use your Saple memory, tasks, and swarm tools.</p>
        </div>
      )}

      {messages.map((m, i) => {
        if (m.role === 'user') {
          return <AmberMessage key={i} role="user" text={m.content} />;
        }
        if (m.role === 'assistant') {
          return (
            <Fragment key={i}>
              {m.content.map((part, j) =>
                part.type === 'text' ? (
                  <AmberMessage key={j} role="assistant" text={part.text} />
                ) : (
                  <AmberToolCall
                    key={j}
                    name={part.name}
                    input={part.input}
                    result={resultLookup.get(part.id)}
                  />
                )
              )}
            </Fragment>
          );
        }
        return null; // tool_results are rendered inline with their tool_use block
      })}

      {/* In-flight turn (events don't carry tool inputs; we show name + live status + result). */}
      {isRunning && streamingText && <AmberMessage role="assistant" text={streamingText} streaming />}
      {isRunning &&
        liveToolCalls.map((t) => (
          <AmberToolCall
            key={t.toolUseId}
            name={t.name}
            liveStatus={t.status}
            result={
              t.content !== undefined
                ? { toolUseId: t.toolUseId, name: t.name, content: t.content, isError: t.status === 'error' }
                : undefined
            }
          />
        ))}
      {isRunning && !streamingText && liveToolCalls.length === 0 && (
        <div className="amber-thinking">
          <Sparkles size={14} /> Amber is thinking…
        </div>
      )}

      {runError && <div className="amber-error">{runError}</div>}
      <div ref={endRef} />
    </div>
  );
}

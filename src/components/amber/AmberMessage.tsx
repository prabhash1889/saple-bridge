import React from 'react';
import { Sparkles } from 'lucide-react';
import { MarkdownPreview } from '../editor/MarkdownPreview';

interface Props {
  role: 'user' | 'assistant';
  text: string;
  /** True while the assistant text is still streaming (shows a caret). */
  streaming?: boolean;
}

/**
 * One text turn. Assistant text renders as Markdown (reusing the Files viewer's GFM renderer);
 * user text renders verbatim. Memoized so growing the list / streaming a later turn doesn't
 * re-render settled messages.
 */
export const AmberMessage = React.memo(function AmberMessage({ role, text, streaming }: Props) {
  return (
    <div className={`amber-msg amber-msg-${role}`}>
      <div className="amber-msg-avatar" aria-hidden="true">
        {role === 'user' ? 'You' : <Sparkles size={14} />}
      </div>
      <div className="amber-msg-body">
        {role === 'assistant' ? (
          <MarkdownPreview content={text} />
        ) : (
          <div className="amber-msg-text">{text}</div>
        )}
        {streaming && <span className="amber-cursor" aria-hidden="true" />}
      </div>
    </div>
  );
});

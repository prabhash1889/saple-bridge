import { useRef, useState } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import { useAmberStore } from '../../stores/amberStore';

/** Input + send/stop. Enter sends, Shift+Enter inserts a newline (standard chat convention). */
export function AmberComposer() {
  const [text, setText] = useState('');
  const isRunning = useAmberStore((s) => s.isRunning);
  const send = useAmberStore((s) => s.send);
  const stop = useAmberStore((s) => s.stop);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const doSend = () => {
    const value = text.trim();
    if (!value || isRunning) return;
    void send(value);
    setText('');
    if (taRef.current) taRef.current.style.height = 'auto';
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
  };

  const onInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  return (
    <div className="amber-composer">
      <textarea
        ref={taRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onInput={onInput}
        placeholder="Message Amber…  (Enter to send, Shift+Enter for a newline)"
        rows={1}
      />
      {isRunning ? (
        <button className="amber-stop-btn" onClick={() => void stop()} title="Stop (cancel run)">
          <Square size={16} />
        </button>
      ) : (
        <button className="amber-send-btn" onClick={doSend} disabled={!text.trim()} title="Send">
          <ArrowUp size={16} />
        </button>
      )}
    </div>
  );
}

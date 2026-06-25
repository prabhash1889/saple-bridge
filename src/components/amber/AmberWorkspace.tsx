import { useEffect, useState } from 'react';
import { History, Plus, Settings as SettingsIcon, Sparkles, Trash2 } from 'lucide-react';
import { useAmberStore } from '../../stores/amberStore';
import { AmberMessageList } from './AmberMessageList';
import { AmberComposer } from './AmberComposer';
import { AmberSettings } from './AmberSettings';

/**
 * Amber room shell: header (model chip + actions), optional history rail, and either the settings
 * panel or the message list + composer. Mounted once (heavy view) so an in-flight stream survives
 * room switches.
 */
export function AmberWorkspace() {
  const init = useAmberStore((s) => s.init);
  const provider = useAmberStore((s) => s.provider);
  const model = useAmberStore((s) => s.model);
  const activeId = useAmberStore((s) => s.activeId);
  const conversations = useAmberStore((s) => s.conversations);
  const keyPresence = useAmberStore((s) => s.keyPresence);
  const newConversation = useAmberStore((s) => s.newConversation);
  const loadConversation = useAmberStore((s) => s.loadConversation);
  const deleteConversation = useAmberStore((s) => s.deleteConversation);

  const [showSettings, setShowSettings] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    void init();
  }, [init]);

  const hasKey = !!keyPresence[provider];

  return (
    <section className="amber-room">
      <header className="room-header amber-header">
        <div className="amber-title">
          <Sparkles size={18} />
          <span>Amber</span>
          <span className="amber-model-chip">
            {provider} · {model || 'default'}
          </span>
        </div>
        <div className="amber-header-actions">
          <button
            className={showHistory ? 'active' : ''}
            onClick={() => setShowHistory((v) => !v)}
            title="Conversation history"
            aria-label="Conversation history"
          >
            <History size={16} />
          </button>
          <button onClick={() => newConversation()} title="New chat" aria-label="New chat">
            <Plus size={16} />
          </button>
          <button
            className={showSettings ? 'active' : ''}
            onClick={() => setShowSettings((v) => !v)}
            title="Settings"
            aria-label="Amber settings"
          >
            <SettingsIcon size={16} />
          </button>
        </div>
      </header>

      <div className="amber-layout">
        {showHistory && (
          <aside className="amber-history">
            <div className="amber-history-title">History</div>
            {conversations.length === 0 && <div className="amber-history-empty">No saved chats yet.</div>}
            {conversations.map((c) => (
              <div key={c.id} className={`amber-history-item ${c.id === activeId ? 'active' : ''}`}>
                <button className="amber-history-open" onClick={() => void loadConversation(c.id)} title={c.title}>
                  <span className="amber-history-name">{c.title}</span>
                  <span className="amber-history-meta">{c.provider}</span>
                </button>
                <button
                  className="amber-history-del"
                  onClick={() => void deleteConversation(c.id)}
                  title="Delete chat"
                  aria-label="Delete chat"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </aside>
        )}

        <div className="amber-main">
          {showSettings ? (
            <AmberSettings onClose={() => setShowSettings(false)} />
          ) : (
            <>
              {!hasKey && (
                <div className="amber-keybanner">
                  No API key for <strong>{provider}</strong>.{' '}
                  <button onClick={() => setShowSettings(true)}>Add one in settings</button> to start chatting.
                </div>
              )}
              <AmberMessageList />
              <AmberComposer />
            </>
          )}
        </div>
      </div>
    </section>
  );
}

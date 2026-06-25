import { useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, Check, KeyRound, Terminal, X } from 'lucide-react';
import {
  AMBER_PROVIDERS,
  useAmberStore,
  type AmberProviderId,
  type ClaudeCodeStatus,
} from '../../stores/amberStore';

/**
 * Provider / model / base-URL selection + API-key entry. The key is written to the OS keychain via
 * `set_api_key` and its presence is checked via `has_api_key` — the secret itself is never read
 * back into the renderer.
 *
 * The "Claude Code" provider is the exception: it has no key. It delegates to the user's logged-in
 * `claude` CLI (Max/Pro subscription), so instead of a key field it shows a CLI detection/login
 * status probed via `amber_claude_code_status`.
 */
export function AmberSettings({ onClose }: { onClose: () => void }) {
  const provider = useAmberStore((s) => s.provider);
  const model = useAmberStore((s) => s.model);
  const baseUrl = useAmberStore((s) => s.baseUrl);
  const keyPresence = useAmberStore((s) => s.keyPresence);
  const claudeCodeStatus = useAmberStore((s) => s.claudeCodeStatus);
  const setProvider = useAmberStore((s) => s.setProvider);
  const setModel = useAmberStore((s) => s.setModel);
  const setBaseUrl = useAmberStore((s) => s.setBaseUrl);
  const saveKey = useAmberStore((s) => s.saveKey);
  const checkClaudeCodeStatus = useAmberStore((s) => s.checkClaudeCodeStatus);

  const [keyInput, setKeyInput] = useState('');
  const [saving, setSaving] = useState(false);
  const isClaudeCode = provider === 'claude-code';
  const hasKey = !!keyPresence[provider];
  const showBaseUrl = provider === 'custom' || provider === 'openai' || provider === 'groq';

  // Probe the local CLI whenever the Claude Code provider is selected.
  useEffect(() => {
    if (isClaudeCode) void checkClaudeCodeStatus();
  }, [isClaudeCode, checkClaudeCodeStatus]);

  const doSaveKey = async () => {
    const value = keyInput.trim();
    if (!value) return;
    setSaving(true);
    try {
      await saveKey(provider, value);
      setKeyInput('');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="amber-settings">
      <div className="amber-settings-head">
        <h3>Amber settings</h3>
        <button onClick={onClose} title="Close settings" aria-label="Close settings">
          <X size={16} />
        </button>
      </div>

      <label className="amber-field">
        <span>Provider</span>
        <select value={provider} onChange={(e) => setProvider(e.target.value as AmberProviderId)}>
          {AMBER_PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>

      <label className="amber-field">
        <span>Model</span>
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder={isClaudeCode ? 'subscription default (opus / sonnet / full id)' : 'model id'}
        />
      </label>

      {isClaudeCode ? (
        <ClaudeCodeStatusRow
          status={claudeCodeStatus}
          onRecheck={() => void checkClaudeCodeStatus()}
        />
      ) : (
        <>
          {showBaseUrl && (
            <label className="amber-field">
              <span>Base URL</span>
              <input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.openai.com/v1"
              />
            </label>
          )}

          <div className="amber-field">
            <span>
              API key{' '}
              {hasKey && (
                <span className="amber-key-ok">
                  <Check size={12} /> stored
                </span>
              )}
            </span>
            <div className="amber-key-row">
              <input
                type="password"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                placeholder={hasKey ? 'Replace stored key…' : `Paste your ${provider} key`}
              />
              <button className="primary" onClick={doSaveKey} disabled={saving || !keyInput.trim()}>
                <KeyRound size={14} /> Save
              </button>
            </div>
            <p className="amber-hint">Keys are stored in the OS keychain and read only in Rust — never exposed to the UI.</p>
          </div>

          {provider !== 'anthropic' && (
            <p className="amber-hint amber-warn">
              Only Anthropic is wired in this build; OpenAI-compatible providers are coming next.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** No-key status panel for the "Claude Code" (subscription) provider. */
function ClaudeCodeStatusRow({
  status,
  onRecheck,
}: {
  status: ClaudeCodeStatus | null;
  onRecheck: () => void;
}) {
  let body: ReactNode;
  if (!status) {
    body = <p className="amber-hint">Checking for the Claude Code CLI…</p>;
  } else if (!status.available) {
    body = (
      <p className="amber-hint amber-warn">
        <AlertTriangle size={12} /> Claude Code CLI not found. Install it from{' '}
        <code>claude.com/claude-code</code> and run <code>claude</code> once to log in.
      </p>
    );
  } else if (!status.loggedIn) {
    body = (
      <p className="amber-hint amber-warn">
        <AlertTriangle size={12} /> Claude Code {status.version ?? ''} found, but not signed in. Run{' '}
        <code>claude</code> once to log in with your subscription.
      </p>
    );
  } else {
    body = (
      <p className="amber-hint">
        <span className="amber-key-ok">
          <Check size={12} /> Claude Code {status.version ?? ''} · signed in
          {status.authMethod ? ` (${status.authMethod})` : ''}
        </span>
      </p>
    );
  }

  return (
    <div className="amber-field">
      <span>
        <Terminal size={12} /> Subscription login
      </span>
      {body}
      <p className="amber-hint">
        Uses your logged-in <code>claude</code> CLI on your Max/Pro subscription — no API key needed.
        It can read/write files and run commands in the open project.
        <button
          type="button"
          onClick={onRecheck}
          style={{
            marginLeft: 8,
            background: 'none',
            border: 'none',
            color: 'var(--accent-amber, #c084fc)',
            cursor: 'pointer',
            padding: 0,
            font: 'inherit',
            textDecoration: 'underline',
          }}
        >
          Re-check
        </button>
      </p>
    </div>
  );
}

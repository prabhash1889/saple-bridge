import React, { useState, useEffect } from 'react';
import { CheckCircle, Key, Save, Shield, Trash2 } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useProviderStore } from '../../../stores/providerStore';
import { CODEX_KEY_SERVICE, MASKED_KEY } from './constants';

export const KeychainTab: React.FC = () => {
  const { refreshReadiness } = useProviderStore();

  const [apiKey, setApiKey] = useState('');
  const [isKeySaved, setIsKeySaved] = useState(false);
  const [keyLoading, setKeyLoading] = useState(false);
  const [keySaveStatus, setKeySaveStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [keyErrorMessage, setKeyErrorMessage] = useState('');

  useEffect(() => { checkApiKeyPresence(); }, []);

  const checkApiKeyPresence = async () => {
    try {
      const saved = await invoke<boolean>('has_api_key', { service: CODEX_KEY_SERVICE });
      if (saved) {
        setIsKeySaved(true);
        setApiKey(MASKED_KEY);
      } else {
        setIsKeySaved(false);
        setApiKey('');
      }
    } catch {
      setIsKeySaved(false);
      setApiKey('');
    }
  };

  const handleKeySave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKey.trim()) return;
    if (apiKey === MASKED_KEY) return;
    setKeyLoading(true);
    setKeySaveStatus('idle');
    setKeyErrorMessage('');
    try {
      await invoke('set_api_key', { service: CODEX_KEY_SERVICE, key: apiKey });
      setKeySaveStatus('success');
      setIsKeySaved(true);
      setApiKey(MASKED_KEY);
      // Reflect the new key in the provider cards' readiness/"Key saved" badge immediately.
      refreshReadiness();
      setTimeout(() => setKeySaveStatus('idle'), 3000);
    } catch (err) {
      setKeySaveStatus('error');
      setKeyErrorMessage(String(err));
    } finally {
      setKeyLoading(false);
    }
  };

  const handleKeyDelete = async () => {
    setKeyLoading(true);
    try {
      await invoke('delete_api_key', { service: CODEX_KEY_SERVICE });
      setIsKeySaved(false);
      setApiKey('');
      refreshReadiness();
    } catch {
      // ignore
    } finally {
      setKeyLoading(false);
    }
  };

  return (
    <section className="surface">
      <div className="section-header">
        <Shield size={18} className="section-icon" />
        <span className="section-title">OS Keychain Storage</span>
      </div>
      <p className="section-desc">
        API keys are stored in your OS native credential manager (Windows Credential Manager / macOS Keychain). Never stored in plaintext files. This is the same key slot as the <strong>Codex</strong> card under the Providers tab — saving here updates both.
      </p>
      <form onSubmit={handleKeySave} className="settings-form">
        <div className="input-group">
          <label className="input-label">
            <Key size={14} />
            OpenAI API Key (for Codex)
          </label>
          <div className="input-wrapper">
            <input
              type="password"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder="sk-or-..."
              className="settings-input"
              disabled={keyLoading}
            />
            {isKeySaved && (
              <button type="button" onClick={handleKeyDelete} className="icon-button danger" title="Remove saved key" disabled={keyLoading}>
                <Trash2 size={15} />
              </button>
            )}
          </div>
        </div>
        <div className="form-actions">
          <button type="submit" className="primary" disabled={keyLoading || !apiKey.trim() || apiKey === MASKED_KEY}>
            <Save size={15} />
            <span>{keyLoading ? 'Saving...' : 'Save API Key'}</span>
          </button>
          {keySaveStatus === 'success' && <span className="status-ok"><CheckCircle size={14} /> Saved to OS Keychain</span>}
          {keySaveStatus === 'error' && <span className="status-error">Failed: {keyErrorMessage}</span>}
        </div>
      </form>
    </section>
  );
};

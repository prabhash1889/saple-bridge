import React, { useState, useEffect } from 'react';
import { AlertCircle, CheckCircle, Cpu, LogIn, RefreshCw, Save, Trash2, XCircle } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useProjectStore } from '../../../stores/projectStore';
import { useProviderStore } from '../../../stores/providerStore';
import { useNotificationStore } from '../../../stores/notificationStore';
import { useTerminalStore } from '../../../stores/terminalStore';
import { KEYCHAIN_SERVICE_PREFIX, MASKED_KEY, SIGN_IN_COMMANDS } from './constants';

export const ProvidersTab: React.FC = () => {
  const currentProjectPath = useProjectStore((state) => state.currentProjectPath);
  const { providers, refreshReadiness, setCustomModel, testRunning, testResults, testProvider } = useProviderStore();

  const [providerKeys, setProviderKeys] = useState<Record<string, { value: string; saved: boolean }>>({});
  const [providerKeySaving, setProviderKeySaving] = useState<Record<string, boolean>>({});
  const [providerKeyStatus, setProviderKeyStatus] = useState<Record<string, 'idle' | 'success' | 'error'>>({});

  const successNotification = (msg: string, desc?: string) => useNotificationStore.getState().success(msg, desc);
  const errorNotification = (msg: string, desc?: string) => useNotificationStore.getState().error(msg, desc);

  useEffect(() => { refreshReadiness(); }, [refreshReadiness]);

  useEffect(() => {
    providers.forEach(async (p) => {
      if (providerKeys[p.provider]) return;
      try {
        const saved = await invoke<boolean>('has_api_key', { service: `${KEYCHAIN_SERVICE_PREFIX}${p.provider}_api_key` });
        if (saved) {
          setProviderKeys(prev => ({ ...prev, [p.provider]: { value: MASKED_KEY, saved: true } }));
        } else {
          setProviderKeys(prev => ({ ...prev, [p.provider]: { value: '', saved: false } }));
        }
      } catch {
        setProviderKeys(prev => ({ ...prev, [p.provider]: { value: '', saved: false } }));
      }
    });
  }, [providers]);

  const handleProviderKeySave = async (provider: string) => {
    const key = providerKeys[provider]?.value;
    if (!key || key === MASKED_KEY) return;
    setProviderKeySaving(prev => ({ ...prev, [provider]: true }));
    setProviderKeyStatus(prev => ({ ...prev, [provider]: 'idle' }));
    try {
      await invoke('set_api_key', { service: `${KEYCHAIN_SERVICE_PREFIX}${provider}_api_key`, key });
      setProviderKeyStatus(prev => ({ ...prev, [provider]: 'success' }));
      setProviderKeys(prev => ({ ...prev, [provider]: { value: MASKED_KEY, saved: true } }));
      refreshReadiness();
      setTimeout(() => setProviderKeyStatus(prev => ({ ...prev, [provider]: 'idle' })), 3000);
    } catch {
      setProviderKeyStatus(prev => ({ ...prev, [provider]: 'error' }));
    } finally {
      setProviderKeySaving(prev => ({ ...prev, [provider]: false }));
    }
  };

  const handleProviderKeyDelete = async (provider: string) => {
    setProviderKeySaving(prev => ({ ...prev, [provider]: true }));
    try {
      await invoke('delete_api_key', { service: `${KEYCHAIN_SERVICE_PREFIX}${provider}_api_key` });
      setProviderKeys(prev => ({ ...prev, [provider]: { value: '', saved: false } }));
      setProviderKeyStatus(prev => ({ ...prev, [provider]: 'idle' }));
      refreshReadiness();
    } catch {
      // ignore
    } finally {
      setProviderKeySaving(prev => ({ ...prev, [provider]: false }));
    }
  };

  const handleProviderSignIn = async (provider: string) => {
    const command = SIGN_IN_COMMANDS[provider];
    if (!command) return;
    if (!currentProjectPath) {
      errorNotification('Open a workspace first', 'Sign-in runs in a terminal inside a workspace.');
      return;
    }
    try {
      // Launch the CLI's interactive login as a custom-command terminal, then jump to it so the
      // user can complete the subscription/OAuth flow. No API key is injected for this pane.
      await useTerminalStore.getState().addPane(currentProjectPath, 'custom', undefined, undefined, command);
      useProjectStore.getState().setActiveView('terminals');
      successNotification(`Launching ${provider} sign-in`, 'Complete the login in the new terminal.');
    } catch (err: any) {
      errorNotification('Failed to start sign-in', err?.toString?.());
    }
  };

  return (
    <section className="surface">
      <div className="section-header">
        <Cpu size={18} className="section-icon" />
        <span className="section-title">Provider Configuration</span>
      </div>
      <p className="section-desc">
        Manage AI provider CLIs and API keys. Provider CLIs must be installed separately. API keys are stored in the OS keychain.
      </p>
      <div className="provider-grid">
        {providers.map((p) => (
          <div key={p.provider} className={`provider-card ${p.authenticated === true || p.signedIn === true ? 'provider-ready' : ''}`}>
            <div className="provider-card-header">
              <div className="provider-card-title">
                <strong>{p.label}</strong>
                <code className="provider-cli">{p.cliCommand || 'No CLI command'}</code>
              </div>
              <span className={`provider-status-dot ${p.authenticated === true || p.signedIn === true ? 'ready' : p.authenticated === false ? 'missing' : 'pending'}`} />
            </div>

            <div className="provider-card-body">
              {SIGN_IN_COMMANDS[p.provider] && (
                <div className="provider-signin-note" style={{ fontSize: '11.5px', color: 'var(--text-secondary)', marginBottom: '8px', lineHeight: 1.4 }}>
                  On a paid {p.label} subscription? Use <strong>Sign In</strong> to log in with your plan — no API key required. An API key below is optional and only needed for pay-as-you-go billing.
                </div>
              )}
              <div className="provider-detail-row">
                <span className="provider-detail-label">Auth</span>
                {p.authenticated === true ? (
                  <span className="status-ok"><CheckCircle size={12} /> Key saved</span>
                ) : p.signedIn === true ? (
                  <span className="status-ok"><CheckCircle size={12} /> Signed in</span>
                ) : p.authenticated === false ? (
                  <span className="status-error"><XCircle size={12} /> No key</span>
                ) : (
                  <span className="provider-detail-pending">Checking...</span>
                )}
              </div>
              {p.cliCommand && (
                <div className="provider-detail-row">
                  <span className="provider-detail-label">Installed</span>
                  {p.installed === true ? (
                    <span className="status-ok" title={p.version || undefined}>
                      <CheckCircle size={12} /> Installed{p.version ? ` (${p.version})` : ''}
                    </span>
                  ) : p.installed === false ? (
                    <span className="status-error"><XCircle size={12} /> Not found</span>
                  ) : (
                    <span className="provider-detail-pending">Checking...</span>
                  )}
                </div>
              )}
              <div className="provider-detail-row">
                <span className="provider-detail-label">Default model</span>
                <span className="provider-detail-value">{p.defaultModel || '—'}</span>
              </div>
              {p.provider === 'custom' && (
                <div className="provider-detail-row">
                  <span className="provider-detail-label">Custom model</span>
                  <input
                    type="text"
                    value={p.customModel}
                    onChange={(e) => setCustomModel(p.provider, e.target.value)}
                    placeholder="e.g. gpt-4o-mini"
                    className="settings-input provider-model-input"
                  />
                </div>
              )}
            </div>

            <div className="provider-card-actions">
              <div className="input-wrapper">
                <input
                  type="password"
                  value={providerKeys[p.provider]?.value || ''}
                  onChange={(e) => setProviderKeys(prev => ({ ...prev, [p.provider]: { value: e.target.value, saved: false } }))}
                  placeholder="Enter API key..."
                  className="settings-input provider-key-input"
                  disabled={providerKeySaving[p.provider]}
                />
                {providerKeys[p.provider]?.saved && (
                  <button
                    type="button"
                    onClick={() => handleProviderKeyDelete(p.provider)}
                    className="icon-button danger"
                    title="Remove saved key"
                    disabled={providerKeySaving[p.provider]}
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
              <div className="provider-card-actions-row">
                <button
                  onClick={() => handleProviderKeySave(p.provider)}
                  className="primary provider-action-btn"
                  disabled={providerKeySaving[p.provider] || !providerKeys[p.provider]?.value || providerKeys[p.provider]?.value === MASKED_KEY}
                >
                  <Save size={13} />
                  <span>{providerKeySaving[p.provider] ? 'Saving...' : 'Save Key'}</span>
                </button>
                <button
                  onClick={() => testProvider(p.provider)}
                  className="provider-action-btn"
                  disabled={testRunning[p.provider]}
                >
                  <RefreshCw size={13} />
                  <span>{testRunning[p.provider] ? 'Testing...' : 'Test'}</span>
                </button>
                {SIGN_IN_COMMANDS[p.provider] && (
                  <button
                    onClick={() => handleProviderSignIn(p.provider)}
                    className="provider-action-btn"
                    title={`Sign in to ${p.label} with your subscription`}
                  >
                    <LogIn size={13} />
                    <span>Sign In</span>
                  </button>
                )}
              </div>
              {providerKeyStatus[p.provider] === 'success' && <span className="status-ok"><CheckCircle size={12} /> Key saved</span>}
              {testResults[p.provider] === 'success' && <span className="status-ok"><CheckCircle size={12} /> Connection OK</span>}
              {testResults[p.provider] === 'error' && <span className="status-error"><AlertCircle size={12} /> No API key or sign-in found</span>}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
};

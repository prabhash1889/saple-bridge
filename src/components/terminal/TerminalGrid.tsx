import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Check,
  FolderOpen,
  Grid2X2,
  History,
  Plus,
  Terminal as TerminalIcon,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { AiProvider, useTerminalStore } from '../../stores/terminalStore';
import { useTerminalLayoutStore } from '../../stores/terminalLayoutStore';
import { useProjectStore } from '../../stores/projectStore';
import { TerminalPane } from './TerminalPane';


const AI_PROVIDERS: { value: AiProvider; label: string; icon: string }[] = [
  { value: 'codex', label: 'Codex', icon: 'C' },
  { value: 'claude', label: 'Claude', icon: 'Cl' },
  { value: 'droid', label: 'Droid', icon: 'D' },
  { value: 'pi', label: 'Pi', icon: 'Pi' },
  { value: 'opencode', label: 'OpenCode', icon: 'O' },
  { value: 'custom', label: 'Custom', icon: 'Cu' },
];

type TerminalProviderOption = AiProvider;
type SetupStep = 'start' | 'layout' | 'agents';

const LAYOUT_OPTIONS = [1, 2, 4, 6, 8, 10, 12];
const SETUP_STEPS: Array<{ id: SetupStep; label: string }> = [
  { id: 'start', label: 'Start' },
  { id: 'layout', label: 'Layout' },
  { id: 'agents', label: 'Agents' },
];

const workspaceNameFromPath = (path: string) => {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
};

interface TerminalGridProps {}

const TerminalGridComponent: React.FC<TerminalGridProps> = () => {
  const [selectedProvider] = useState<TerminalProviderOption>('codex');
  const [setupStep, setSetupStep] = useState<SetupStep>('start');
  const [selectedLayoutCount, setSelectedLayoutCount] = useState(4);
  const [agentCounts, setAgentCounts] = useState<Record<string, number>>({});
  const [setupComplete, setSetupComplete] = useState(false);
  const [customCommand, setCustomCommand] = useState('');
  const [customCommandCount, setCustomCommandCount] = useState(0);

  const currentProjectPath = useProjectStore((state) => state.currentProjectPath);
  const currentProjectName = useProjectStore((state) => state.currentProjectName);
  const recentProjects = useProjectStore((state) => state.recentProjects);
  const openWorkspace = useProjectStore((state) => state.openWorkspace);
  const workspaceLoading = useProjectStore((state) => state.workspaceLoading);
  const panes = useTerminalStore((state) => state.panes);
  const maximizedPaneId = useTerminalStore((state) => state.maximizedPaneId);
  const initialize = useTerminalStore((state) => state.initialize);
  const addPane = useTerminalStore((state) => state.addPane);
  const canAddPane = useTerminalStore((state) => state.canAddPane);
  const getMaxPaneLimit = useTerminalStore((state) => state.getMaxPaneLimit);
  const restoreWorkspacePanes = useTerminalStore((state) => state.restoreWorkspacePanes);
  const savedLayout = useTerminalLayoutStore((state) =>
    currentProjectPath ? state.savedLayouts[currentProjectPath] : undefined,
  );
  const savedPaneCount = savedLayout?.panes.length ?? 0;


  useEffect(() => {
    initialize();
  }, [initialize]);

  useEffect(() => {
    if (panes.length === 0) {
      setSetupComplete(false);
      setSetupStep(currentProjectPath ? 'layout' : 'start');
    }
  }, [currentProjectPath, panes.length]);

  useEffect(() => {
    if (setupStep === 'layout') {
      setAgentCounts({});
      setCustomCommandCount(0);
      setCustomCommand('');
    }
  }, [setupStep]);

  const maxLimit = getMaxPaneLimit();
  const clampedLayoutCount = Math.min(selectedLayoutCount, maxLimit);

  const handleAddPane = useCallback(() => {
    if (currentProjectPath && canAddPane()) {
      addPane(currentProjectPath, selectedProvider, undefined, undefined, selectedProvider === 'custom' ? customCommand : undefined);
    }
  }, [currentProjectPath, selectedProvider, customCommand, addPane, canAddPane]);


  const handleOpenWorkspace = useCallback(async () => {
    try {
      const selectedPath = await invoke<string | null>('select_directory');
      if (selectedPath) {
        await openWorkspace(selectedPath);
        setSetupStep('layout');
      }
    } catch (error) {
      console.error('Failed to select directory:', error);
    }
  }, [openWorkspace]);

  const handleRecentWorkspace = useCallback(async (path: string) => {
    await openWorkspace(path);
    setSetupStep('layout');
  }, [openWorkspace]);

  const totalAssigned = useMemo(() => {
    return Object.values(agentCounts).reduce((a, b) => a + b, 0) + customCommandCount;
  }, [agentCounts, customCommandCount]);

  const handleAgentCountChange = useCallback((provider: string, delta: number) => {
    setAgentCounts(prev => {
      const current = prev[provider] || 0;
      const next = current + delta;
      if (next < 0) return prev;
      if (delta > 0 && totalAssigned >= clampedLayoutCount) return prev;
      const newCounts = { ...prev, [provider]: next };
      if (next === 0) delete newCounts[provider];
      return newCounts;
    });
  }, [totalAssigned, clampedLayoutCount]);

  const handleAgentToggle = useCallback((provider: string) => {
    setAgentCounts(prev => {
      const current = prev[provider] || 0;
      if (current > 0) {
        const newCounts = { ...prev };
        delete newCounts[provider];
        return newCounts;
      } else {
        if (totalAssigned < clampedLayoutCount) {
          return { ...prev, [provider]: 1 };
        }
        return prev;
      }
    });
  }, [totalAssigned, clampedLayoutCount]);

  const handleEnableAll = useCallback(() => {
    setAgentCounts({});
    setCustomCommandCount(0);
    const providersToEnable = AI_PROVIDERS.filter(p => p.value !== 'custom');
    let remaining = clampedLayoutCount;
    const newCounts: Record<string, number> = {};
    while (remaining > 0) {
      for (const p of providersToEnable) {
        if (remaining > 0) {
          newCounts[p.value] = (newCounts[p.value] || 0) + 1;
          remaining--;
        }
      }
    }
    setAgentCounts(newCounts);
  }, [clampedLayoutCount]);

  const handleOneOfEach = useCallback(() => {
    const providersToEnable = AI_PROVIDERS.filter(p => p.value !== 'custom');
    const newCounts: Record<string, number> = {};
    let assigned = 0;
    for (const p of providersToEnable) {
      if (assigned < clampedLayoutCount) {
        newCounts[p.value] = 1;
        assigned++;
      }
    }
    setAgentCounts(newCounts);
    setCustomCommandCount(0);
  }, [clampedLayoutCount]);

  const handleSplitEvenly = useCallback(() => {
    const currentProviders = Object.keys(agentCounts);
    if (currentProviders.length === 0) return;
    const base = Math.floor(clampedLayoutCount / currentProviders.length);
    let remainder = clampedLayoutCount % currentProviders.length;
    const newCounts: Record<string, number> = {};
    for (const p of currentProviders) {
      newCounts[p] = base + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder--;
    }
    setAgentCounts(newCounts);
    setCustomCommandCount(0);
  }, [agentCounts, clampedLayoutCount]);

  const launchPanes = useCallback(async (withAgents: boolean) => {
    if (!currentProjectPath) return;
    const availableSlots = Math.max(0, maxLimit - panes.length);
    const targetCount = Math.min(clampedLayoutCount, availableSlots);
    if (targetCount === 0) {
      setSetupComplete(true);
      return;
    }

    if (!withAgents) {
      for (let index = 0; index < targetCount; index += 1) {
        await addPane(currentProjectPath, undefined);
      }
    } else {
      const providersToLaunch: { provider: TerminalProviderOption; customCommand?: string }[] = [];
      Object.entries(agentCounts).forEach(([provider, count]) => {
        for (let i = 0; i < count; i++) {
          providersToLaunch.push({ provider: provider as TerminalProviderOption });
        }
      });
      for (let i = 0; i < customCommandCount; i++) {
        providersToLaunch.push({ provider: 'custom' as TerminalProviderOption, customCommand });
      }
      
      if (providersToLaunch.length === 0) {
         for (let index = 0; index < targetCount; index += 1) {
           await addPane(currentProjectPath, selectedProvider, undefined, undefined, selectedProvider === 'custom' ? customCommand : undefined);
         }
      } else {
        for (let index = 0; index < targetCount; index += 1) {
          const item = providersToLaunch[index];
          if (item) {
            await addPane(currentProjectPath, item.provider, undefined, undefined, item.customCommand);
          } else {
            await addPane(currentProjectPath, undefined);
          }
        }
      }
    }
    setSetupComplete(true);
  }, [addPane, agentCounts, customCommandCount, clampedLayoutCount, currentProjectPath, maxLimit, panes.length, selectedProvider, customCommand]);

  const gridClassName = useMemo(() => {
    if (maximizedPaneId) return 'terminal-grid terminal-grid-maximized';
    const count = panes.length;
    if (count <= 1) return 'terminal-grid terminal-grid-1';
    if (count === 2) return 'terminal-grid terminal-grid-2';
    if (count <= 4) return 'terminal-grid terminal-grid-4';
    if (count <= 6) return 'terminal-grid terminal-grid-6';
    if (count <= 9) return 'terminal-grid terminal-grid-9';
    if (count <= 12) return 'terminal-grid terminal-grid-12';
    return 'terminal-grid terminal-grid-16';
  }, [panes.length, maximizedPaneId]);

  if (!setupComplete && panes.length === 0) {
    const currentStepIndex = SETUP_STEPS.findIndex((item) => item.id === setupStep);

    return (
      <div className="command-setup">
        <div className="command-setup-shell" style={setupStep === 'agents' ? { padding: 0, background: 'transparent' } : undefined}>
          {setupStep !== 'agents' && savedPaneCount > 0 && (
            <div className="command-setup-restore">
              <div className="command-setup-restore-info">
                <History size={16} />
                <div>
                  <strong>Restore previous terminals</strong>
                  <span>You had {savedPaneCount} terminal{savedPaneCount === 1 ? '' : 's'} open here last time.</span>
                </div>
              </div>
              <button
                className="primary"
                onClick={() => currentProjectPath && restoreWorkspacePanes(currentProjectPath)}
                disabled={!currentProjectPath}
              >
                <History size={15} />
                Restore {savedPaneCount}
              </button>
            </div>
          )}
          {setupStep !== 'agents' && (
            <div className="command-setup-header">
              <div>
                <p className="command-kicker">Command Room</p>
                <h2>Set up your workspace.</h2>
                <span>{currentProjectPath ? currentProjectPath : 'Choose a local repo folder to begin.'}</span>
              </div>
              <div className="command-setup-stepper" aria-label="Command Room setup steps">
                {SETUP_STEPS.map((step, index) => (
                  <button
                    key={step.id}
                    className={setupStep === step.id ? 'active' : index < currentStepIndex ? 'complete' : ''}
                    onClick={() => {
                      if (step.id === 'start' || currentProjectPath) setSetupStep(step.id);
                    }}
                    disabled={step.id !== 'start' && !currentProjectPath}
                  >
                    <span>{index + 1}</span>
                    {step.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {setupStep === 'start' && (
            <div className="command-setup-panel">
              <div className="command-setup-section">
                <div className="command-setup-title">
                  <FolderOpen size={18} />
                  <div>
                    <h3>Start</h3>
                    <p>Select the workspace folder Saple Bridge should control.</p>
                  </div>
                </div>
                <button className="command-open-workspace" onClick={handleOpenWorkspace} disabled={workspaceLoading}>
                  <FolderOpen size={18} />
                  {currentProjectPath ? 'Switch workspace folder' : 'Open workspace folder'}
                </button>
              </div>

              <div className="command-recent-grid">
                {currentProjectPath && (
                  <button className="command-recent-card active" onClick={() => setSetupStep('layout')} title={currentProjectPath}>
                    <span>Current</span>
                    <strong>{currentProjectName}</strong>
                    <small>{currentProjectPath}</small>
                  </button>
                )}
                {recentProjects.slice(0, 6).map((path) => (
                  <button key={path} className="command-recent-card" onClick={() => handleRecentWorkspace(path)} title={path}>
                    <span>Recent</span>
                    <strong>{workspaceNameFromPath(path)}</strong>
                    <small>{path}</small>
                  </button>
                ))}
              </div>
            </div>
          )}

          {setupStep === 'layout' && (
            <div className="command-setup-panel">
              <div className="command-setup-section">
                <div className="command-setup-title">
                  <Grid2X2 size={18} />
                  <div>
                    <h3>Layout</h3>
                    <p>Choose how many terminal panes to open. Workspace limit: {maxLimit}.</p>
                  </div>
                </div>
                <div className="command-path-pill" title={currentProjectPath ?? undefined}>
                  {currentProjectPath ?? 'No workspace selected'}
                </div>
              </div>

              <div className="layout-picker" aria-label="Terminal count">
                {LAYOUT_OPTIONS.map((count) => {
                  const disabled = count > maxLimit;
                  return (
                    <button
                      key={count}
                      className={clampedLayoutCount === count ? 'active' : ''}
                      onClick={() => setSelectedLayoutCount(count)}
                      disabled={disabled}
                      title={disabled ? `Limit is ${maxLimit} panes` : `${count} terminal panes`}
                    >
                      <strong>{count}</strong>
                      <span>{count === 1 ? 'pane' : 'panes'}</span>
                    </button>
                  );
                })}
              </div>

              <div className="layout-presets">
                <button onClick={() => setSelectedLayoutCount(Math.min(2, maxLimit))}>Pair</button>
                <button onClick={() => setSelectedLayoutCount(Math.min(4, maxLimit))}>Quad</button>
                <button onClick={() => setSelectedLayoutCount(Math.min(8, maxLimit))}>Review wall</button>
                <button onClick={() => setSelectedLayoutCount(Math.min(12, maxLimit))}>Full room</button>
              </div>
            </div>
          )}

          {setupStep === 'agents' && (
            <div className="command-setup-panel agents-setup-panel" style={{ border: 'none', background: 'transparent', padding: '0 24px', maxWidth: '800px', margin: '0 auto', marginTop: '40px' }}>
              <div style={{ textAlign: 'center', marginBottom: '32px' }}>
                <h2 style={{ fontSize: '28px', fontWeight: 600, marginBottom: '12px', color: 'var(--text-primary)' }}>Add AI coding agents</h2>
                <p style={{ color: 'var(--text-secondary)', fontSize: '15px', lineHeight: '1.5' }}>
                  Pick which agents should launch in your {clampedLayoutCount} terminals. You can run them alongside your<br/>regular terminal — or skip this step entirely.
                </p>
              </div>

              <div className="agent-progress-section" style={{ marginBottom: '24px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px', color: 'var(--text-secondary)', fontSize: '13px' }}>
                  <span style={{ fontWeight: 600 }}>{totalAssigned}/{clampedLayoutCount}</span>
                  <span>{totalAssigned === 0 ? 'No agents yet' : `${totalAssigned} agents selected`}</span>
                </div>
                <div className="agent-progress-bar" style={{ height: '4px', background: 'var(--bg-tertiary)', borderRadius: '2px', overflow: 'hidden' }}>
                  <div style={{ width: `${(totalAssigned / clampedLayoutCount) * 100}%`, background: 'var(--text-primary)', height: '100%', transition: 'width 0.3s ease' }} />
                </div>
              </div>

              <div className="agent-quick-fill" style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px', fontSize: '13px' }}>
                <span style={{ color: 'var(--text-secondary)', marginRight: '8px' }}>Quick fill:</span>
                <button className="quick-fill-btn" style={{ padding: '6px 12px', borderRadius: '4px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer' }} onClick={handleEnableAll}>Enable all</button>
                <button className="quick-fill-btn" style={{ padding: '6px 12px', borderRadius: '4px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer' }} onClick={handleOneOfEach}>One of each</button>
                <button className="quick-fill-btn" style={{ padding: '6px 12px', borderRadius: '4px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer' }} onClick={handleSplitEvenly}>Split evenly</button>
              </div>

              <div className="agent-picker-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '24px' }}>
                {AI_PROVIDERS.filter(p => p.value !== 'custom').map((provider) => {
                  const count = agentCounts[provider.value] || 0;
                  const isChecked = count > 0;
                  return (
                    <div
                      key={provider.value}
                      className={`agent-row ${isChecked ? 'active' : ''}`}
                      style={{ 
                        display: 'flex', alignItems: 'center', padding: '16px', 
                        background: 'var(--bg-tertiary)', borderRadius: '8px', 
                        border: isChecked ? '1px solid var(--text-primary)' : '1px solid transparent',
                        cursor: 'pointer' 
                      }}
                      onClick={() => handleAgentToggle(provider.value)}
                    >
                      <div style={{ width: '16px', height: '16px', borderRadius: '4px', border: isChecked ? '1px solid var(--text-primary)' : '1px solid var(--text-secondary)', background: isChecked ? 'var(--text-primary)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', marginRight: '16px' }}>
                        {isChecked && <Check size={12} color="var(--bg-tertiary)" strokeWidth={3} />}
                      </div>
                      <span style={{ flex: 1, fontWeight: 500, color: 'var(--text-primary)' }}>{provider.label}</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '16px', color: 'var(--text-secondary)' }} onClick={e => e.stopPropagation()}>
                        <button style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: '4px', opacity: count === 0 ? 0.3 : 1, fontSize: '16px' }} disabled={count === 0} onClick={() => handleAgentCountChange(provider.value, -1)}>-</button>
                        <span style={{ minWidth: '16px', textAlign: 'center', fontWeight: count > 0 ? 600 : 400, color: count > 0 ? 'var(--text-primary)' : 'inherit', fontSize: '15px' }}>{count}</span>
                        <button style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: '4px', opacity: totalAssigned >= clampedLayoutCount ? 0.3 : 1, fontSize: '16px' }} disabled={totalAssigned >= clampedLayoutCount} onClick={() => handleAgentCountChange(provider.value, 1)}>+</button>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div style={{ textAlign: 'center', marginBottom: '24px' }}>
                <button style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', fontSize: '12px', letterSpacing: '1px', textTransform: 'uppercase', cursor: 'pointer', fontWeight: 600 }}>SHOW LESS</button>
              </div>

              <div className="custom-command-section" style={{ background: 'var(--bg-tertiary)', borderRadius: '8px', padding: '20px', border: customCommandCount > 0 ? '1px solid var(--text-primary)' : '1px solid transparent' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', marginBottom: '16px' }}>
                  <div onClick={() => setCustomCommandCount(prev => prev > 0 ? 0 : Math.min(1, clampedLayoutCount - totalAssigned + prev))} style={{ width: '16px', height: '16px', borderRadius: '4px', border: customCommandCount > 0 ? '1px solid var(--text-primary)' : '1px solid var(--text-secondary)', background: customCommandCount > 0 ? 'var(--text-primary)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', marginRight: '16px', marginTop: '2px', cursor: 'pointer' }}>
                    {customCommandCount > 0 && <Check size={12} color="var(--bg-tertiary)" strokeWidth={3} />}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 500, marginBottom: '4px', color: 'var(--text-primary)' }}>Custom Command</div>
                    <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>Enter any CLI agent or shell command</div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '16px', color: 'var(--text-secondary)', fontSize: '13px' }}>
                    <button style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: '12px', fontWeight: 600 }} onClick={() => setCustomCommandCount(clampedLayoutCount - totalAssigned + customCommandCount)}>ALL {clampedLayoutCount}</button>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <button style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: '4px', opacity: customCommandCount === 0 ? 0.3 : 1, fontSize: '16px' }} disabled={customCommandCount === 0} onClick={() => setCustomCommandCount(prev => prev - 1)}>-</button>
                      <span style={{ fontWeight: customCommandCount > 0 ? 600 : 400, color: customCommandCount > 0 ? 'var(--text-primary)' : 'inherit', fontSize: '15px' }}>{customCommandCount}</span>
                      <button style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: '4px', opacity: totalAssigned >= clampedLayoutCount ? 0.3 : 1, fontSize: '16px' }} disabled={totalAssigned >= clampedLayoutCount} onClick={() => setCustomCommandCount(prev => prev + 1)}>+</button>
                    </div>
                  </div>
                </div>
                <input type="text" value={customCommand} onChange={(e) => setCustomCommand(e.target.value)} placeholder="npm run agent..." style={{ width: '100%', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border)', padding: '12px 16px', borderRadius: '6px', color: 'var(--text-primary)', outline: 'none' }} />
              </div>

              <div style={{ marginTop: '20px', paddingBottom: '20px' }}>
                <button style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontWeight: 500 }}>
                  <Plus size={14} /> ADD CUSTOM COMMAND
                </button>
              </div>
            </div>
          )}

          <div className="command-setup-footer">
            <button
              onClick={() => {
                if (setupStep === 'agents') setSetupStep('layout');
                else if (setupStep === 'layout') setSetupStep('start');
              }}
              disabled={setupStep === 'start'}
            >
              <ArrowLeft size={15} />
              Back
            </button>
            <div className="command-setup-footer-actions">
              {setupStep === 'start' && (
                <>
                  <button onClick={() => currentProjectPath && launchPanes(false)} disabled={!currentProjectPath}>
                    Open without AI
                  </button>
                  <button className="primary" onClick={() => currentProjectPath && setSetupStep('layout')} disabled={!currentProjectPath}>
                    Next: Layout
                  </button>
                </>
              )}
              {setupStep === 'layout' && (
                <>
                  <button onClick={() => launchPanes(false)} disabled={!currentProjectPath}>
                    Open without AI
                  </button>
                  <button className="primary" onClick={() => setSetupStep('agents')} disabled={!currentProjectPath}>
                    Next: Add AI agents
                  </button>
                </>
              )}
              {setupStep === 'agents' && (
                <>
                  <button onClick={() => launchPanes(false)} disabled={!currentProjectPath}>
                    Skip - no agents
                  </button>
                  <button className="primary" onClick={() => launchPanes(true)} disabled={!currentProjectPath || totalAssigned !== clampedLayoutCount}>
                    Launch Command Room
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="terminal-room command-workbench">
      <div className="terminal-grid-wrapper">
        <div className="terminal-grid-container">
          {panes.length > 0 ? (
            <div className={gridClassName}>
              {panes.map((paneId) => (
                <TerminalPane
                  key={paneId}
                  sessionId={paneId}
                  maximized={maximizedPaneId === paneId}
                />
              ))}
            </div>
          ) : (
            <div className="terminal-empty-state">
              <TerminalIcon size={40} style={{ color: 'var(--text-muted)', marginBottom: 8 }} />
              <p>No active terminal panes.</p>
              <p style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
                Create up to {maxLimit} panes for parallel terminal or agent sessions
              </p>
              <button onClick={handleAddPane} className="primary" style={{ marginTop: '16px' }}>
                <Plus size={16} />
                <span>New Pane</span>
              </button>
              {savedPaneCount > 0 && (
                <button
                  onClick={() => currentProjectPath && restoreWorkspacePanes(currentProjectPath)}
                  style={{ marginTop: '10px' }}
                >
                  <History size={15} />
                  <span>Restore previous {savedPaneCount} terminal{savedPaneCount === 1 ? '' : 's'}</span>
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export const TerminalGrid = memo(TerminalGridComponent);

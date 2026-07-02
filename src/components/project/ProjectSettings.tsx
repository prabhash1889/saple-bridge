import React, { useState, useEffect } from 'react';
import { Clock, Cpu, Database, Key, Network, ShieldCheck, Terminal } from 'lucide-react';
import { useProjectStore } from '../../stores/projectStore';
import { KeychainTab } from './settings/KeychainTab';
import { ProvidersTab } from './settings/ProvidersTab';
import { WorkspaceTab } from './settings/WorkspaceTab';
import { McpTab } from './settings/McpTab';
import { MemoryTab } from './settings/MemoryTab';
import { SessionsTab } from './settings/SessionsTab';
import { DiagnosticsTab } from './settings/DiagnosticsTab';

type SettingsTab = 'keychain' | 'providers' | 'workspace' | 'mcp' | 'memory' | 'sessions' | 'diagnostics';

const tabs: Array<{ id: SettingsTab; label: string; icon: React.ElementType }> = [
  { id: 'keychain', label: 'Keychain', icon: Key },
  { id: 'providers', label: 'Providers', icon: Cpu },
  { id: 'workspace', label: 'Workspace', icon: Terminal },
  { id: 'mcp', label: 'MCP', icon: Network },
  { id: 'memory', label: 'Memory', icon: Database },
  { id: 'sessions', label: 'Sessions', icon: Clock },
  { id: 'diagnostics', label: 'Diagnostics', icon: ShieldCheck },
];

const isSettingsTab = (tab: string): tab is SettingsTab =>
  tabs.some((t) => t.id === tab);

export const ProjectSettings: React.FC = () => {
  const [activeTab, setActiveTab] = useState<SettingsTab>('keychain');
  const pendingSettingsTab = useProjectStore((state) => state.pendingSettingsTab);
  // Honor a one-shot tab request (e.g. command palette "Run diagnostics") and clear it so a
  // later plain visit to Settings doesn't re-apply it.
  useEffect(() => {
    if (pendingSettingsTab && isSettingsTab(pendingSettingsTab)) {
      setActiveTab(pendingSettingsTab);
    }
    if (pendingSettingsTab) {
      useProjectStore.getState().setPendingSettingsTab(null);
    }
  }, [pendingSettingsTab]);

  return (
    <div className="settings-shell">
      <div className="room-header">
        <h2>Settings</h2>
        <p>Configure provider credentials, workspace defaults, and MCP integration.</p>
      </div>

      <div className="settings-tabs" role="tablist">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              role="tab"
              className={`settings-tab ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
              aria-selected={activeTab === tab.id}
            >
              <Icon size={15} />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      <div className="settings-content">
        {activeTab === 'keychain' && <KeychainTab />}
        {activeTab === 'providers' && <ProvidersTab />}
        {activeTab === 'workspace' && <WorkspaceTab />}
        {activeTab === 'mcp' && <McpTab />}
        {activeTab === 'memory' && <MemoryTab />}
        {activeTab === 'sessions' && <SessionsTab />}
        {activeTab === 'diagnostics' && <DiagnosticsTab />}
      </div>
    </div>
  );
};

import React, { useRef, useState, useEffect, useLayoutEffect } from 'react';
import { Shield, Bot, UserCheck, CheckCircle, Clock, AlertTriangle, Play } from 'lucide-react';
import { SwarmAgent, AgentStatus } from '../../stores/swarmStore';

interface SwarmGraphProps {
  agents: SwarmAgent[];
  onSelectAgent: (agentId: string) => void;
  selectedAgentId?: string;
  onRelaunch: (agentId: string) => void;
}

export const SwarmGraph: React.FC<SwarmGraphProps> = ({
  agents,
  onSelectAgent,
  selectedAgentId,
  onRelaunch
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [connections, setConnections] = useState<Array<{ from: string; to: string; d: string }>>([]);

  // Compute dependency levels
  const levels: Record<string, number> = {};
  const computeLevel = (agentId: string, visited = new Set<string>()): number => {
    if (levels[agentId] !== undefined) return levels[agentId];
    const agent = agents.find(a => a.id === agentId);
    if (!agent || agent.dependencies.length === 0) {
      levels[agentId] = 0;
      return 0;
    }
    if (visited.has(agentId)) return 0;
    visited.add(agentId);

    let maxDepLevel = -1;
    for (const depId of agent.dependencies) {
      maxDepLevel = Math.max(maxDepLevel, computeLevel(depId, visited));
    }
    visited.delete(agentId);
    levels[agentId] = maxDepLevel + 1;
    return maxDepLevel + 1;
  };

  agents.forEach(a => computeLevel(a.id));

  // Group agents by level
  const maxLevel = Math.max(...Object.values(levels), 0);
  const levelColumns: SwarmAgent[][] = Array.from({ length: maxLevel + 1 }, () => []);
  agents.forEach(a => {
    const lvl = levels[a.id] ?? 0;
    levelColumns[lvl].push(a);
  });

  const getStatusColor = (status: AgentStatus) => {
    switch (status) {
      case 'running': return 'var(--accent)';
      case 'done': return 'var(--color-success)';
      case 'failed': return 'var(--color-danger)';
      case 'review': return 'var(--color-warning)';
      case 'blocked': return 'var(--text-muted)';
      default: return 'var(--border)';
    }
  };

  const getStatusIcon = (status: AgentStatus) => {
    switch (status) {
      case 'running': return <Bot size={14} className="spin" style={{ color: 'var(--accent)' }} />;
      case 'done': return <CheckCircle size={14} style={{ color: 'var(--color-success)' }} />;
      case 'failed': return <AlertTriangle size={14} style={{ color: 'var(--color-danger)' }} />;
      case 'review': return <UserCheck size={14} style={{ color: 'var(--color-warning)' }} />;
      case 'blocked': return <Clock size={14} style={{ color: 'var(--text-muted)' }} />;
      default: return <Clock size={14} style={{ color: 'var(--text-muted)' }} />;
    }
  };

  const getRoleLabelColor = (role: string) => {
    switch (role) {
      case 'coordinator': return 'var(--accent)';
      case 'builder': return 'var(--color-success)';
      case 'reviewer': return 'var(--color-info)';
      case 'scout': return 'var(--color-warning)';
      default: return 'var(--text-secondary)';
    }
  };

  // Compute SVG connections
  const updateConnections = () => {
    if (!containerRef.current) return;
    const containerRect = containerRef.current.getBoundingClientRect();
    const newConnections: typeof connections = [];

    agents.forEach(agent => {
      agent.dependencies.forEach(depId => {
        const fromNode = nodeRefs.current[depId];
        const toNode = nodeRefs.current[agent.id];

        if (fromNode && toNode) {
          const fromRect = fromNode.getBoundingClientRect();
          const toRect = toNode.getBoundingClientRect();

          // Calculate connection points relative to container
          const x1 = fromRect.right - containerRect.left;
          const y1 = fromRect.top + fromRect.height / 2 - containerRect.top;

          const x2 = toRect.left - containerRect.left;
          const y2 = toRect.top + toRect.height / 2 - containerRect.top;

          // Bezier control points
          const dx = Math.abs(x2 - x1) * 0.5;
          const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;

          newConnections.push({
            from: depId,
            to: agent.id,
            d
          });
        }
      });
    });

    setConnections(newConnections);
  };

  useLayoutEffect(() => {
    updateConnections();
  }, [agents]);

  useEffect(() => {
    window.addEventListener('resize', updateConnections);
    return () => window.removeEventListener('resize', updateConnections);
  }, [agents]);

  return (
    <div style={graphContainerStyle} ref={containerRef}>
      {/* SVG Canvas for Connections */}
      <svg style={svgCanvasStyle}>
        <defs>
          <marker
            id="arrow"
            viewBox="0 0 10 10"
            refX="6"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--border)" />
          </marker>
          <marker
            id="arrow-active"
            viewBox="0 0 10 10"
            refX="6"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--accent)" />
          </marker>
        </defs>
        {connections.map((conn) => {
          const fromAgent = agents.find(a => a.id === conn.from);
          const toAgent = agents.find(a => a.id === conn.to);
          const isActive = fromAgent?.status === 'done' && (toAgent?.status === 'running' || toAgent?.status === 'starting');

          return (
            <path
              key={`${conn.from}-${conn.to}`}
              d={conn.d}
              fill="none"
              stroke={isActive ? 'var(--accent)' : 'var(--border)'}
              strokeWidth={isActive ? 2 : 1.5}
              strokeDasharray={toAgent?.status === 'blocked' ? '4 4' : undefined}
              markerEnd={isActive ? 'url(#arrow-active)' : 'url(#arrow)'}
              style={{ transition: 'stroke 0.2s, stroke-width 0.2s' }}
            />
          );
        })}
      </svg>

      {/* Grid of Columns */}
      <div style={columnsContainerStyle}>
        {levelColumns.map((columnAgents, colIdx) => (
          <div key={colIdx} style={columnStyle}>
            <div style={columnHeaderStyle}>Stage {colIdx + 1}</div>
            <div style={columnNodesContainerStyle}>
              {columnAgents.map(agent => {
                const isSelected = selectedAgentId === agent.id;
                const borderClr = getStatusColor(agent.status);

                return (
                  <div
                    key={agent.id}
                    ref={el => { nodeRefs.current[agent.id] = el; }}
                    onClick={() => onSelectAgent(agent.id)}
                    className={`swarm-node-card${isSelected ? ' is-selected' : ''}`}
                    style={{ '--node-border': borderClr } as React.CSSProperties}
                  >
                    <div style={nodeHeaderStyle}>
                      <Shield size={14} style={{ color: getRoleLabelColor(agent.role) }} />
                      <div style={nodeNameStyle}>{agent.name}</div>
                    </div>

                    <div style={nodeMetaStyle}>
                      <span style={roleBadgeStyle(agent.role)}>{agent.role}</span>
                      <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{agent.model}</span>
                    </div>

                    <div style={nodeFooterStyle}>
                      <div style={nodeStatusStyle(agent.status)}>
                        {getStatusIcon(agent.status)}
                        <span style={{ textTransform: 'uppercase', fontSize: '9px', fontWeight: 600 }}>{agent.status}</span>
                      </div>
                      
                      {agent.status === 'failed' && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onRelaunch(agent.id);
                          }}
                          className="swarm-node-relaunch"
                          title="Relaunch Agent"
                        >
                          <Play size={10} />
                          <span>Relaunch</span>
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

/* --- Styles --- */

const graphContainerStyle: React.CSSProperties = {
  position: 'relative',
  width: '100%',
  minHeight: '400px',
  backgroundColor: 'var(--bg-app)',
  borderRadius: 'var(--radius-lg)',
  border: '1px solid var(--border)',
  overflow: 'auto',
  padding: '24px',
};

const svgCanvasStyle: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 0,
  width: '100%',
  height: '100%',
  pointerEvents: 'none',
  zIndex: 1,
};

const columnsContainerStyle: React.CSSProperties = {
  display: 'flex',
  gap: '64px',
  minWidth: 'max-content',
  height: '100%',
  alignItems: 'flex-start',
  position: 'relative',
  zIndex: 2,
};

const columnStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '16px',
  width: '200px',
};

const columnHeaderStyle: React.CSSProperties = {
  fontSize: '11px',
  fontWeight: 700,
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  textAlign: 'center',
  borderBottom: '1px solid var(--border)',
  paddingBottom: '8px',
};

const columnNodesContainerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '24px',
  padding: '8px 0',
};

const nodeHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
};

const nodeNameStyle: React.CSSProperties = {
  fontSize: '12px',
  fontWeight: 600,
  color: 'var(--text-primary)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const nodeMetaStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
};

const roleBadgeStyle = (role: string): React.CSSProperties => {
  let color = 'var(--text-muted)';
  let bg = 'rgba(255, 255, 255, 0.05)';
  if (role === 'coordinator') { color = 'var(--accent)'; bg = 'rgba(99, 102, 241, 0.1)'; }
  else if (role === 'builder') { color = 'var(--color-success)'; bg = 'rgba(34, 197, 94, 0.1)'; }
  else if (role === 'reviewer') { color = 'var(--color-info)'; bg = 'rgba(59, 130, 246, 0.1)'; }
  else if (role === 'scout') { color = 'var(--color-warning)'; bg = 'rgba(245, 158, 11, 0.1)'; }

  return {
    fontSize: '8.5px',
    fontWeight: 700,
    textTransform: 'uppercase',
    padding: '2px 6px',
    borderRadius: '4px',
    color,
    backgroundColor: bg,
  };
};

const nodeFooterStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  borderTop: '1px solid var(--border)',
  paddingTop: '6px',
  marginTop: '2px',
};

const nodeStatusStyle = (status: AgentStatus): React.CSSProperties => {
  let color = 'var(--text-muted)';
  if (status === 'running') color = 'var(--accent)';
  if (status === 'done') color = 'var(--color-success)';
  if (status === 'review') color = 'var(--color-warning)';
  if (status === 'failed') color = 'var(--color-danger)';

  return {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    color,
  };
};


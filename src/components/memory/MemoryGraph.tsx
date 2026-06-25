import React, { useEffect, useState, useRef, useMemo } from 'react';
import { Maximize2, Globe, Target, ExternalLink, X } from 'lucide-react';
import { useMemoryStore, MemoryNode } from '../../stores/memoryStore';
import { useProjectStore } from '../../stores/projectStore';

interface SimNode extends MemoryNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

const CATEGORY_COLORS: Record<string, string> = {
  decision: 'var(--mem-decision)',
  architecture: 'var(--mem-architecture)',
  pattern: 'var(--mem-pattern)',
  bug: 'var(--mem-bug)',
  handoff: 'var(--mem-handoff)',
  review: 'var(--mem-review)',
  general: '#9CA3AF',
};

type GraphMode = 'global' | 'local';

export const MemoryGraph: React.FC = () => {
  const { currentProjectPath } = useProjectStore();
  const { nodes, edges, loadNote, setActiveNote } = useMemoryStore();

  const canvasRef = useRef<SVGSVGElement>(null);
  const isSimulationActive = useRef(true);

  const [simNodes, setSimNodes] = useState<SimNode[]>([]);
  const [draggedNodeId, setDraggedNodeId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);

  // Global vs. local (focused neighborhood) view, plus display toggles.
  const [mode, setMode] = useState<GraphMode>('global');
  const [focusId, setFocusId] = useState<string | null>(null);
  const [showOrphans, setShowOrphans] = useState(true);

  // Zoom & Pan state
  const [zoom, setZoom] = useState(1);
  const [panX, setPanX] = useState(0);
  const [panY, setPanY] = useState(0);
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });

  const width = 800;
  const height = 500;

  // Inbound-link counts drive node size (hubs grow, like Obsidian).
  const inbound = useMemo(() => {
    const counts: Record<string, number> = {};
    edges.forEach((e) => { counts[e.target] = (counts[e.target] || 0) + 1; });
    return counts;
  }, [edges]);

  // Total degree (in + out) — used to detect orphans.
  const degree = useMemo(() => {
    const counts: Record<string, number> = {};
    edges.forEach((e) => {
      counts[e.source] = (counts[e.source] || 0) + 1;
      counts[e.target] = (counts[e.target] || 0) + 1;
    });
    return counts;
  }, [edges]);

  const radiusFor = (id: string) => 6 + Math.min(inbound[id] || 0, 10) * 1.3;

  // The set of node ids actually rendered, given mode + focus + orphan toggle.
  const visibleIds = useMemo(() => {
    const ids = new Set<string>();
    if (mode === 'local' && focusId) {
      ids.add(focusId);
      edges.forEach((e) => {
        if (e.source === focusId) ids.add(e.target);
        if (e.target === focusId) ids.add(e.source);
      });
      return ids;
    }
    nodes.forEach((n) => {
      if (showOrphans || (degree[n.id] || 0) > 0) ids.add(n.id);
    });
    return ids;
  }, [mode, focusId, showOrphans, nodes, edges, degree]);

  const visibleEdges = useMemo(
    () => edges.filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target)),
    [edges, visibleIds]
  );

  // Neighbors of the hovered node (for highlight dimming).
  const hoverNeighbors = useMemo(() => {
    if (!hoverId) return null;
    const set = new Set<string>([hoverId]);
    edges.forEach((e) => {
      if (e.source === hoverId) set.add(e.target);
      if (e.target === hoverId) set.add(e.source);
    });
    return set;
  }, [hoverId, edges]);

  const focusNode = focusId ? nodes.find((n) => n.id === focusId) : null;

  // Initialize simulation nodes
  useEffect(() => {
    const initialNodes: SimNode[] = nodes.map((node, index) => {
      const angle = (index / nodes.length) * Math.PI * 2;
      const radius = 100 + Math.random() * 60;
      return {
        ...node,
        x: width / 2 + Math.cos(angle) * radius,
        y: height / 2 + Math.sin(angle) * radius,
        vx: 0,
        vy: 0,
      };
    });
    setSimNodes(initialNodes);
    isSimulationActive.current = true;
  }, [nodes]);

  // Run Physics Loop with Cooldown
  useEffect(() => {
    if (simNodes.length === 0) return;
    isSimulationActive.current = true;

    let animationFrameId: number;

    const updatePhysics = () => {
      if (!isSimulationActive.current) return;

      setSimNodes(prevNodes => {
        const nextNodes = prevNodes.map(n => ({ ...n }));

        const charge = 1000;
        const spring = 0.04;
        const restLength = 80;
        const gravity = 0.015;
        const friction = 0.8;

        // 1. Repulsion
        for (let i = 0; i < nextNodes.length; i++) {
          const n1 = nextNodes[i];
          for (let j = i + 1; j < nextNodes.length; j++) {
            const n2 = nextNodes[j];
            const dx = n1.x - n2.x;
            const dy = n1.y - n2.y;
            const distSq = dx * dx + dy * dy + 0.1;
            const dist = Math.sqrt(distSq);

            if (dist < 220) {
              const force = charge / distSq;
              const fX = (dx / dist) * force;
              const fY = (dy / dist) * force;

              if (n1.id !== draggedNodeId) {
                n1.vx += fX;
                n1.vy += fY;
              }
              if (n2.id !== draggedNodeId) {
                n2.vx -= fX;
                n2.vy -= fY;
              }
            }
          }
        }

        // 2. Attraction
        edges.forEach(edge => {
          const n1 = nextNodes.find(n => n.id === edge.source);
          const n2 = nextNodes.find(n => n.id === edge.target);
          if (n1 && n2) {
            const dx = n2.x - n1.x;
            const dy = n2.y - n1.y;
            const dist = Math.sqrt(dx * dx + dy * dy) + 0.1;
            const force = (dist - restLength) * spring;
            const fX = (dx / dist) * force;
            const fY = (dy / dist) * force;

            if (n1.id !== draggedNodeId) {
              n1.vx += fX;
              n1.vy += fY;
            }
            if (n2.id !== draggedNodeId) {
              n2.vx -= fX;
              n2.vy -= fY;
            }
          }
        });

        // 3. Gravity & Update Positions
        nextNodes.forEach(node => {
          if (node.id === draggedNodeId) return;

          const dx = width / 2 - node.x;
          const dy = height / 2 - node.y;
          node.vx += dx * gravity;
          node.vy += dy * gravity;

          node.x += node.vx;
          node.y += node.vy;

          node.vx *= friction;
          node.vy *= friction;

          // Boundary constraints (generous limits to allow panning exploration)
          node.x = Math.max(-200, Math.min(width + 200, node.x));
          node.y = Math.max(-200, Math.min(height + 200, node.y));
        });

        // Cooldown Check: stop updating if nodes are static
        let maxSpeedSq = 0;
        nextNodes.forEach(node => {
          const speedSq = node.vx * node.vx + node.vy * node.vy;
          if (speedSq > maxSpeedSq) {
            maxSpeedSq = speedSq;
          }
        });

        if (maxSpeedSq < 0.005 && !draggedNodeId) {
          isSimulationActive.current = false;
        }

        return nextNodes;
      });

      if (isSimulationActive.current) {
        animationFrameId = requestAnimationFrame(updatePhysics);
      }
    };

    animationFrameId = requestAnimationFrame(updatePhysics);
    return () => cancelAnimationFrame(animationFrameId);
  }, [simNodes.length, edges, draggedNodeId]);

  // Bring a set of nodes into view (used by Fit and on focus/mode change).
  const fitToNodes = (list: SimNode[]) => {
    if (list.length === 0) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    list.forEach(n => {
      if (n.x < minX) minX = n.x;
      if (n.x > maxX) maxX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.y > maxY) maxY = n.y;
    });

    const padding = 60;
    const graphW = (maxX - minX) || 1;
    const graphH = (maxY - minY) || 1;

    const scaleX = (width - padding * 2) / graphW;
    const scaleY = (height - padding * 2) / graphH;
    const nextZoom = Math.max(0.2, Math.min(Math.min(scaleX, scaleY), 1.5));

    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    setZoom(nextZoom);
    setPanX(width / 2 - centerX * nextZoom);
    setPanY(height / 2 - centerY * nextZoom);
  };

  // Re-fit whenever the visible neighborhood changes (focus / mode toggles).
  useEffect(() => {
    if (simNodes.length === 0) return;
    const visible = simNodes.filter((n) => visibleIds.has(n.id));
    // Defer a frame so positions reflect the latest simulation tick.
    const id = requestAnimationFrame(() => fitToNodes(visible));
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, focusId, showOrphans]);

  // Coordinate transformation helper
  const getGraphCoordinates = (clientX: number, clientY: number) => {
    if (!canvasRef.current) return { x: 0, y: 0 };
    const rect = canvasRef.current.getBoundingClientRect();
    const viewBoxX = ((clientX - rect.left) / rect.width) * width;
    const viewBoxY = ((clientY - rect.top) / rect.height) * height;

    const x = (viewBoxX - panX) / zoom;
    const y = (viewBoxY - panY) / zoom;
    return { x, y };
  };

  const handleMouseDown = (nodeId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setDraggedNodeId(nodeId);
    isSimulationActive.current = true;
  };

  const handleSvgMouseDown = (e: React.MouseEvent) => {
    if (
      e.target === canvasRef.current ||
      (e.target as SVGElement).tagName === 'svg' ||
      (e.target as SVGElement).tagName === 'line'
    ) {
      setIsPanning(true);
      setPanStart({ x: e.clientX - panX, y: e.clientY - panY });
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isPanning) {
      setPanX(e.clientX - panStart.x);
      setPanY(e.clientY - panStart.y);
    } else if (draggedNodeId && canvasRef.current) {
      const { x, y } = getGraphCoordinates(e.clientX, e.clientY);
      isSimulationActive.current = true;
      setSimNodes(prevNodes =>
        prevNodes.map(n =>
          n.id === draggedNodeId
            ? { ...n, x, y, vx: 0, vy: 0 }
            : n
        )
      );
    }
  };

  const handleMouseUp = () => {
    setDraggedNodeId(null);
    setIsPanning(false);
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const zoomFactor = 1.05;
    const nextZoom = e.deltaY < 0 ? zoom * zoomFactor : zoom / zoomFactor;
    const clampedZoom = Math.max(0.1, Math.min(5, nextZoom));

    if (canvasRef.current) {
      const rect = canvasRef.current.getBoundingClientRect();
      const clientX = e.clientX - rect.left;
      const clientY = e.clientY - rect.top;
      const viewBoxX = (clientX / rect.width) * width;
      const viewBoxY = (clientY / rect.height) * height;

      const nextPanX = viewBoxX - ((viewBoxX - panX) / zoom) * clampedZoom;
      const nextPanY = viewBoxY - ((viewBoxY - panY) / zoom) * clampedZoom;

      setZoom(clampedZoom);
      setPanX(nextPanX);
      setPanY(nextPanY);
    }
  };

  const handleFitScreen = () => {
    fitToNodes(simNodes.filter((n) => visibleIds.has(n.id)));
  };

  // Single-click: in local mode, focus the neighborhood; in global mode, open it.
  const handleNodeClick = (node: MemoryNode, e: React.MouseEvent) => {
    e.stopPropagation();
    if (mode === 'local') {
      setFocusId(node.id);
    } else if (currentProjectPath) {
      loadNote(currentProjectPath, node);
    }
  };

  const openNote = (node: MemoryNode) => {
    if (currentProjectPath) loadNote(currentProjectPath, node);
  };

  const handleCreateNewNote = () => {
    setActiveNote({
      id: '',
      title: 'New Note',
      category: 'general',
      tags: [],
      aliases: [],
      filePath: '',
    });
  };

  const toggleMode = () => {
    setMode((m) => {
      const next = m === 'global' ? 'local' : 'global';
      if (next === 'global') setFocusId(null);
      return next;
    });
  };

  return (
    <div
      style={graphContainerStyle}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      <div style={headerStyle}>
        <span style={titleStyle}>SapleMemory Graph</span>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {/* Global / Local mode toggle */}
          <div style={segToggleStyle}>
            <button
              onClick={toggleMode}
              style={mode === 'global' ? segActiveStyle : segBtnStyle}
              title="Show the whole vault"
            >
              <Globe size={12} />
              <span>Global</span>
            </button>
            <button
              onClick={toggleMode}
              style={mode === 'local' ? segActiveStyle : segBtnStyle}
              title="Focus one note and its neighbors"
            >
              <Target size={12} />
              <span>Local</span>
            </button>
          </div>

          <label style={orphanToggleStyle} title="Show notes with no links">
            <input
              type="checkbox"
              checked={showOrphans}
              onChange={(e) => setShowOrphans(e.target.checked)}
              style={{ margin: 0 }}
            />
            <span>Orphans</span>
          </label>

          <button onClick={handleFitScreen} style={fitBtnStyle} title="Fit to Screen">
            <Maximize2 size={12} />
            <span>Fit</span>
          </button>
          <button onClick={handleCreateNewNote} style={newNoteBtnStyle}>
            Create Memory Note
          </button>
        </div>
      </div>

      {/* Local-mode focus bar */}
      {mode === 'local' && (
        <div style={focusBarStyle}>
          {focusNode ? (
            <>
              <span style={{ color: 'var(--text-secondary)' }}>Focused:</span>
              <strong style={{ color: 'var(--text-primary)' }}>{focusNode.title}</strong>
              <button onClick={() => openNote(focusNode)} style={focusOpenBtnStyle}>
                <ExternalLink size={12} />
                <span>Open</span>
              </button>
              <button onClick={() => setFocusId(null)} style={focusClearBtnStyle} title="Clear focus">
                <X size={12} />
              </button>
            </>
          ) : (
            <span style={{ color: 'var(--text-muted)' }}>
              Click a node to focus its neighborhood. Click again to open it.
            </span>
          )}
        </div>
      )}

      {nodes.length > 0 ? (
        <svg
          ref={canvasRef}
          viewBox={`0 0 ${width} ${height}`}
          style={svgStyle}
          onMouseDown={handleSvgMouseDown}
          onWheel={handleWheel}
        >
          <defs>
            <marker
              id="mem-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--text-muted)" />
            </marker>
          </defs>

          {/* Render Zoomed/Panned Content Group */}
          <g transform={`translate(${panX}, ${panY}) scale(${zoom})`}>
            {/* Render links */}
            {visibleEdges.map((edge, i) => {
              const sourceNode = simNodes.find(n => n.id === edge.source);
              const targetNode = simNodes.find(n => n.id === edge.target);
              if (!sourceNode || !targetNode) return null;

              // Shorten the line to the target node's edge so the arrowhead sits
              // on the rim, not buried under the circle.
              const dx = targetNode.x - sourceNode.x;
              const dy = targetNode.y - sourceNode.y;
              const dist = Math.sqrt(dx * dx + dy * dy) || 1;
              const tr = radiusFor(targetNode.id) + 4;
              const x2 = targetNode.x - (dx / dist) * tr;
              const y2 = targetNode.y - (dy / dist) * tr;

              const active = !hoverId || hoverNeighbors?.has(edge.source) && hoverNeighbors?.has(edge.target);

              return (
                <line
                  key={`link-${i}`}
                  x1={sourceNode.x}
                  y1={sourceNode.y}
                  x2={x2}
                  y2={y2}
                  stroke="var(--border)"
                  strokeWidth={1.5}
                  opacity={active ? 0.55 : 0.12}
                  markerEnd="url(#mem-arrow)"
                />
              );
            })}

            {/* Render nodes */}
            {simNodes.filter((n) => visibleIds.has(n.id)).map(node => {
              const nodeColor = CATEGORY_COLORS[node.category] || CATEGORY_COLORS.general;
              const isDragged = node.id === draggedNodeId;
              const r = radiusFor(node.id);
              const dim = hoverId && !hoverNeighbors?.has(node.id);
              const isFocus = node.id === focusId;
              return (
                <g
                  key={node.id}
                  transform={`translate(${node.x}, ${node.y})`}
                  style={{ cursor: isDragged ? 'grabbing' : 'grab', opacity: dim ? 0.25 : 1 }}
                  onMouseDown={(e) => handleMouseDown(node.id, e)}
                  onMouseEnter={() => setHoverId(node.id)}
                  onMouseLeave={() => setHoverId(null)}
                  onClick={(e) => handleNodeClick(node, e)}
                >
                  <circle
                    r={r}
                    fill={nodeColor}
                    stroke={isFocus ? 'var(--accent)' : 'var(--bg-app)'}
                    strokeWidth={isFocus ? 3 : 2}
                    style={{
                      filter: `drop-shadow(0 0 5px ${nodeColor})`,
                      transition: 'r 0.1s',
                    }}
                    className="graph-node"
                  />
                  <text
                    y={r + 10}
                    textAnchor="middle"
                    fill="var(--text-primary)"
                    fontSize={10}
                    fontWeight={500}
                    style={{ pointerEvents: 'none', userSelect: 'none' }}
                  >
                    {node.title}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
      ) : (
        <div style={emptyGraphStyle} onClick={handleCreateNewNote}>
          <p>Double-click graph area or click button above to create your first memory note.</p>
        </div>
      )}
    </div>
  );
};

/* --- Inline CSS Styles --- */

const graphContainerStyle: React.CSSProperties = {
  flex: 1,
  height: '100%',
  backgroundColor: 'var(--bg-surface)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-lg)',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  position: 'relative',
};

const headerStyle: React.CSSProperties = {
  padding: '12px 16px',
  borderBottom: '1px solid var(--border)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  backgroundColor: 'var(--bg-surface-light)',
  zIndex: 2,
};

const titleStyle: React.CSSProperties = {
  fontSize: '13px',
  fontWeight: 600,
  color: 'var(--text-secondary)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};

const segToggleStyle: React.CSSProperties = {
  display: 'flex',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  overflow: 'hidden',
};

const segBtnStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
  fontSize: '11px',
  height: '24px',
  padding: '4px 8px',
  background: 'transparent',
  border: 'none',
  borderRadius: 0,
  color: 'var(--text-secondary)',
};

const segActiveStyle: React.CSSProperties = {
  ...segBtnStyle,
  background: 'var(--bg-surface-active)',
  color: 'var(--text-primary)',
};

const orphanToggleStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '5px',
  fontSize: '11px',
  color: 'var(--text-secondary)',
  cursor: 'pointer',
  userSelect: 'none',
};

const newNoteBtnStyle: React.CSSProperties = {
  fontSize: '11px',
  padding: '4px 8px',
  height: '24px',
};

const fitBtnStyle: React.CSSProperties = {
  fontSize: '11px',
  padding: '4px 8px',
  height: '24px',
  backgroundColor: 'transparent',
  border: '1px solid var(--border)',
  color: 'var(--text-secondary)',
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
};

const focusBarStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  padding: '6px 16px',
  borderBottom: '1px solid var(--border)',
  backgroundColor: 'var(--bg-app)',
  fontSize: '12px',
  zIndex: 2,
};

const focusOpenBtnStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
  fontSize: '11px',
  height: '22px',
  padding: '2px 8px',
};

const focusClearBtnStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  height: '22px',
  padding: '2px 6px',
  background: 'transparent',
  border: '1px solid var(--border)',
  color: 'var(--text-secondary)',
};

const svgStyle: React.CSSProperties = {
  flex: 1,
  width: '100%',
  height: '100%',
  cursor: 'move',
};

const emptyGraphStyle: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '40px',
  textAlign: 'center',
  color: 'var(--text-muted)',
  fontSize: '12.5px',
  cursor: 'pointer',
};

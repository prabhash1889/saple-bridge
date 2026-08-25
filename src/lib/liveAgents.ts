import { useSwarmStore } from '../stores/swarmStore';
import { useTerminalStore } from '../stores/terminalStore';

export interface LiveAgents {
  /** Names of swarm agents currently working (running or waiting). */
  swarm: string[];
  /**
   * Names of terminal panes running a launched agent task. Only panes explicitly linked
   * to an agent session count: plain shells and provider CLIs the user started by hand
   * are their own business and must not block closing the app.
   */
  terminals: string[];
}

const LIVE_SWARM_STATUSES = ['running', 'waiting'];

/**
 * Snapshot of everything that would be interrupted by quitting right now.
 * Pure function over current store state so it can be unit tested without a webview.
 */
export const getLiveAgents = (): LiveAgents => {
  const swarm = useSwarmStore
    .getState()
    .activeAgents.filter((a) => LIVE_SWARM_STATUSES.includes(a.status))
    .map((a) => a.name || a.id);

  const sessions = useTerminalStore.getState().sessions;
  const panes = useTerminalStore.getState().panes;
  const terminals = panes
    .map((paneId) => sessions[paneId])
    .filter((session) => session && Boolean(session.agentSessionId))
    .map((session) => session.name);

  return { swarm, terminals };
};

/** Human summary for the quit confirmation ("2 swarm agents, 1 task agent"). */
export const describeLiveAgents = ({ swarm, terminals }: LiveAgents): string => {
  const parts: string[] = [];
  if (swarm.length > 0) {
    parts.push(`${swarm.length} swarm agent${swarm.length === 1 ? '' : 's'}`);
  }
  if (terminals.length > 0) {
    parts.push(`${terminals.length} task agent${terminals.length === 1 ? '' : 's'}`);
  }
  return parts.join(', ');
};

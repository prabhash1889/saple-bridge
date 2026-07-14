// June control dispatcher (June PLAN.md Phase 1).
//
// Authority stays in the renderer for now: the Rust control endpoint forwards each June `command`
// as a `june://command` Tauri event, this dispatcher runs it against the existing stores, reports
// state changes back through `june_emit_event` (which drives `observe`), and returns the contract
// `CommandResponse` through `june_command_result`. When renderer-mediated control proves fragile,
// authority migrates into Rust behind the same seam with zero changes to June (PLAN.md §2).

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import { useBrowserStore } from '../stores/browserStore';
import { useProjectStore } from '../stores/projectStore';
import { useSwarmStore } from '../stores/swarmStore';
import { useTerminalStore, type AiProvider } from '../stores/terminalStore';

// Kept in lockstep with the Rust `MAX_BATCH_SIZE` (june_control.rs).
const MAX_BATCH_SIZE = 16;

interface CommandEvent {
  correlation_id: string;
  request_id: string;
  workspace_id: string;
  action: string;
  arguments: Record<string, unknown>;
}

type CommandResponse =
  | { status: 'result'; request_id: string; result: Record<string, unknown> }
  | { status: 'error'; request_id: string; error: { code: string; message: string } };

const ok = (requestId: string, result: Record<string, unknown>): CommandResponse => ({
  status: 'result',
  request_id: requestId,
  result,
});

const err = (requestId: string, code: string, message: string): CommandResponse => ({
  status: 'error',
  request_id: requestId,
  error: { code, message },
});

// A state change June sees through `observe`. Tagged with June's logical workspace_id so its
// observe(after_sequence) resume stays scoped to what it asked about.
function emitEvent(
  workspaceId: string,
  kind: string,
  requestId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  return invoke('june_emit_event', {
    workspaceId,
    kind,
    requestId: requestId || null,
    payload,
  });
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

async function handle(ev: CommandEvent): Promise<CommandResponse> {
  const { request_id: id, workspace_id: ws, arguments: args } = ev;
  const projectPath = useProjectStore.getState().currentProjectPath;
  if (!projectPath) return err(id, 'bridge_unavailable', 'no project is open in bridge');

  switch (ev.action) {
    case 'spawn_agents': {
      const provider = str(args.provider, 'claude') as AiProvider;
      const model = args.model ? str(args.model) : undefined;
      const count = Number(args.count ?? 1);
      const prompt = args.prompt ? str(args.prompt) : undefined;
      if (!Number.isInteger(count) || count < 1) return err(id, 'invalid_request', 'count must be a positive integer');
      if (count > MAX_BATCH_SIZE) return err(id, 'capacity', `requested ${count} exceeds max_batch_size (${MAX_BATCH_SIZE})`);

      const addPane = useTerminalStore.getState().addPane;
      const agentIds: string[] = [];
      let started = 0;
      let failed = 0;
      for (let i = 0; i < count; i++) {
        try {
          // Spawns into the active workspace; June's workspace_id is used only for observe routing.
          const paneId = await addPane(projectPath, provider, model);
          agentIds.push(paneId);
          started++;
          await emitEvent(ws, 'agent.spawned', id, { agent_id: paneId, provider, model: model ?? null });
          if (prompt) await invoke('write_pty', { id: paneId, data: `${prompt}\r` });
        } catch {
          failed++;
        }
      }
      // Partial success is first-class (PLAN.md §2): counts always sum to requested.
      return ok(id, { counts: { requested: count, started, failed, skipped: 0 }, agent_ids: agentIds });
    }

    case 'assign_task': {
      const agentId = str(args.agent_id);
      const task = str(args.task);
      if (!agentId) return err(id, 'invalid_request', 'agent_id is required');
      await invoke('write_pty', { id: agentId, data: `${task}\r` });
      await emitEvent(ws, 'task.assigned', id, { agent_id: agentId });
      return ok(id, { agent_id: agentId });
    }

    case 'write_terminal': {
      const paneId = str(args.pane_id);
      if (!paneId) return err(id, 'invalid_request', 'pane_id is required');
      await invoke('write_pty', { id: paneId, data: str(args.data) });
      return ok(id, { pane_id: paneId });
    }

    case 'close_terminal': {
      const paneId = str(args.pane_id);
      if (!paneId) return err(id, 'invalid_request', 'pane_id is required');
      await useTerminalStore.getState().removePane(paneId);
      await emitEvent(ws, 'terminal.closed', id, { pane_id: paneId });
      return ok(id, { pane_id: paneId });
    }

    case 'open_browser': {
      const url = str(args.url);
      if (!url) return err(id, 'invalid_request', 'url is required');
      const browser = useBrowserStore.getState();
      browser.openPanel(ws);
      browser.newTab(ws, url);
      await emitEvent(ws, 'browser.opened', id, { url });
      return ok(id, { url });
    }

    case 'close_browser': {
      await useBrowserStore.getState().closeWorkspaceBrowser(ws);
      await emitEvent(ws, 'browser.closed', id, {});
      return ok(id, {});
    }

    case 'get_swarm_status': {
      const terminals = useTerminalStore.getState().panes;
      const agents = useSwarmStore.getState().activeAgents.map((a) => ({
        id: a.id,
        name: a.name,
        status: a.status,
      }));
      return ok(id, { terminals, agents });
    }

    default:
      return err(id, 'invalid_request', `unknown action '${ev.action}'`);
  }
}

/**
 * Start listening for June commands. Safe to call unconditionally: if the endpoint is disabled no
 * events ever arrive. Returns the unlisten function.
 */
export function startJuneDispatcher(): Promise<UnlistenFn> {
  return listen<CommandEvent>('june://command', async ({ payload }) => {
    let response: CommandResponse;
    try {
      response = await handle(payload);
    } catch (e) {
      response = err(payload.request_id, 'provider_failure', e instanceof Error ? e.message : String(e));
    }
    await invoke('june_command_result', { correlationId: payload.correlation_id, response });
  });
}

import { browser, $ } from '@wdio/globals';
import { smokeWorkspace } from '../paths';

// The single critical path: the packaged app boots its webview (proves the bundle loaded past the
// production CSP), opens a project, and spawns a terminal whose prompt streams back through Tauri
// IPC (proves the PTY wiring survives packaging). That trio is exactly the regression class unit
// tests can't reach.
describe('Saple Bridge smoke', () => {
  it('boots the UI, opens a project, and renders a terminal prompt', async () => {
    // 1. The React shell mounted. A CSP/packaging break leaves an empty body instead.
    await $('.app-grid').waitForExist({ timeout: 30_000 });

    // 2. Seed the persisted project store so the app opens smoke-test-workspace on reload. We can't
    //    drive the native folder picker through WebDriver, and this is the store's own persist key.
    await browser.execute((ws: string) => {
      localStorage.setItem(
        'saple-bridge-project-store',
        JSON.stringify({
          state: {
            currentProjectPath: ws,
            currentProjectName: 'smoke-test-workspace',
            currentWorkspaceId: 'ws_smoke',
            activeView: 'terminals',
            recentProjects: [ws],
            workspaceHistory: [],
            openWorkspaces: [{ id: 'ws_smoke', path: ws, name: 'smoke-test-workspace' }],
          },
          version: 1,
        }),
      );
    }, smokeWorkspace);
    await browser.refresh();
    await $('.app-grid').waitForExist({ timeout: 30_000 });

    // 3. Spawn a terminal via the app shortcut (Ctrl+Shift+T -> addPane + terminals room).
    await browser.keys(['Control', 'Shift', 't']);

    // 4. A non-empty terminal grid means the PTY spawned and its prompt streamed back.
    const rows = await $('.xterm-rows');
    await rows.waitForExist({ timeout: 60_000 });
    await browser.waitUntil(async () => (await rows.getText()).trim().length > 0, {
      timeout: 60_000,
      timeoutMsg: 'terminal never rendered a prompt',
    });
  });
});

import { describe, it, expect } from 'vitest';
import { buildSshCommand } from './sshPreset';

describe('buildSshCommand', () => {
  it('bare host: no -t, no remote payload', () => {
    expect(buildSshCommand({ hostAlias: 'devbox' })).toBe('ssh devbox');
  });

  it('remote command forces a TTY and quotes the payload once', () => {
    expect(buildSshCommand({ hostAlias: 'devbox', providerCommand: 'claude' })).toBe('ssh -t devbox "claude"');
  });

  it('cd + command, dir single-quoted so spaces survive on the remote shell', () => {
    expect(buildSshCommand({ hostAlias: 'user@host', remoteDir: '/srv/my app', providerCommand: 'npm run dev' })).toBe(
      `ssh -t user@host "cd '/srv/my app' && npm run dev"`,
    );
  });

  it('dir only still cds', () => {
    expect(buildSshCommand({ hostAlias: 'devbox', remoteDir: '/srv/app' })).toBe(`ssh -t devbox "cd '/srv/app'"`);
  });

  it('never emits password/key material', () => {
    const out = buildSshCommand({ hostAlias: 'devbox', remoteDir: '/x', providerCommand: 'codex' });
    expect(out.toLowerCase()).not.toContain('password');
    expect(out).not.toContain('-i ');
  });
});

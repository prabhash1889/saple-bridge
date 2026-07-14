import { describe, it, expect } from 'vitest';
import { buildSshCommand, sshPresetIssue } from './sshPreset';

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

describe('sshPresetIssue', () => {
  it('accepts ordinary presets', () => {
    expect(sshPresetIssue({ hostAlias: 'devbox' })).toBeNull();
    expect(
      sshPresetIssue({ hostAlias: 'user@host', remoteDir: '/srv/my app', providerCommand: "npm run dev -- --name='x'" }),
    ).toBeNull();
  });

  it('rejects characters the local shell would expand or that break the arg boundary', () => {
    expect(sshPresetIssue({ hostAlias: 'devbox', providerCommand: 'echo $HOME' })).toMatch(/local shell/);
    expect(sshPresetIssue({ hostAlias: 'devbox', providerCommand: 'echo `id`' })).toMatch(/local shell/);
    expect(sshPresetIssue({ hostAlias: 'devbox', providerCommand: 'say "hi"' })).toMatch(/local shell/);
  });

  it("rejects a single quote in the remote dir (it is single-quoted in the cd)", () => {
    expect(sshPresetIssue({ hostAlias: 'devbox', remoteDir: "/home/o'brien" })).toMatch(/Remote directory/);
  });

  it('rejects spaces and shell-active characters in the host alias', () => {
    expect(sshPresetIssue({ hostAlias: 'evil -oProxyCommand=x' })).toMatch(/spaces/);
    expect(sshPresetIssue({ hostAlias: 'host$x' })).toMatch(/Host alias/);
  });
});

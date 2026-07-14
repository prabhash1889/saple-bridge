// P7 SSH terminal presets. A preset is a reusable remote-terminal launch: it assembles a plain
// `ssh` command that runs through the existing custom-command PTY path. No password/key material is
// ever stored or passed — authentication is delegated entirely to the user's SSH agent and
// ~/.ssh/config, so `hostAlias` must resolve there. This is a remote *terminal*, not a remote
// workspace: files, Git, memory, Kanban, and Review stay local.

export interface SshPreset {
  id: string;
  name: string;
  hostAlias: string;
  remoteDir?: string;
  providerCommand?: string;
}

export type SshPresetInput = Omit<SshPreset, 'id' | 'name'> & { name?: string };

// Assemble the launch command. Force a TTY (`-t`) only when we hand ssh a remote command, so the
// remote provider CLI runs interactively; a bare host uses ssh's default interactive session.
//
// Quoting is cross-shell safe (Windows PowerShell is the primary target, macOS sh secondary): the
// remote payload is wrapped in ONE level of double quotes so the local shell passes it to ssh as a
// single argument, and the remote directory is single-quoted (literal inside the outer double
// quotes on both PowerShell and sh) so a path with spaces still `cd`s correctly on the remote shell.
export function buildSshCommand({ hostAlias, remoteDir, providerCommand }: SshPresetInput): string {
  const alias = hostAlias.trim();
  const dir = (remoteDir ?? '').trim();
  const cmd = (providerCommand ?? '').trim();

  const remoteParts: string[] = [];
  if (dir) remoteParts.push(`cd '${dir}'`);
  if (cmd) remoteParts.push(cmd);

  if (remoteParts.length === 0) return `ssh ${alias}`;
  return `ssh -t ${alias} "${remoteParts.join(' && ')}"`;
}

// Characters the quoting layers above cannot carry: `"` breaks the outer double-quoted argument,
// and `$` / backtick are expanded by the LOCAL shell (both PowerShell and sh interpolate inside
// double quotes), so they would silently mangle the remote command. Newlines end the command line.
const SHELL_ACTIVE = /["$`\r\n]/;

// Validate a draft preset before saving. Returns a human-readable problem, or null when every
// field survives `buildSshCommand`'s quoting intact. Not a security boundary - the user authors
// and confirms the command - it exists so legitimate input is rejected loudly instead of being
// silently rewritten by the local shell.
export function sshPresetIssue({ hostAlias, remoteDir, providerCommand }: SshPresetInput): string | null {
  const alias = hostAlias.trim();
  if (/\s/.test(alias)) return 'Host alias cannot contain spaces.';
  if (SHELL_ACTIVE.test(alias) || alias.includes("'")) {
    return 'Host alias cannot contain quotes, $, or backticks.';
  }
  const dir = (remoteDir ?? '').trim();
  // The remote dir is single-quoted, so a single quote in it breaks the cd on the remote shell.
  if (SHELL_ACTIVE.test(dir) || dir.includes("'")) {
    return 'Remote directory cannot contain quotes, $, or backticks.';
  }
  const cmd = (providerCommand ?? '').trim();
  if (SHELL_ACTIVE.test(cmd)) {
    return 'Provider command cannot contain ", $, or backticks - the local shell would expand them before they reach the remote host.';
  }
  return null;
}

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

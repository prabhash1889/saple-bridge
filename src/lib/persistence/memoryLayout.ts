// Renderer-side counterpart of `memory_layout.rs`: the only place in the UI that
// maps a workspace memory mode to its on-disk note directory. All memory file I/O
// itself stays in Rust; this exists so display-only path prefixes are not re-derived
// per component.

export type MemoryMode = 'saple' | 'bridge-compatible' | 'both';

// Mirrors get_memory_dir in memory_layout.rs: bridge-compatible keeps notes under
// `.bridgememory/`, every other mode (including `both`) displays `.saple/memory/`.
export function memoryPathPrefix(mode: string | undefined): string {
  return mode === 'bridge-compatible' ? '.bridgememory/' : '.saple/memory/';
}

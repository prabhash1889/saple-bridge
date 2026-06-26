import React from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';
import { openUrl } from '@tauri-apps/plugin-opener';
import remarkWikilinks, { MEM_LINK_PREFIX } from './remarkWikilinks';
import { useMemoryStore, MemoryNode } from '../../../stores/memoryStore';
import { useProjectStore } from '../../../stores/projectStore';

/**
 * Markdown preview for memory notes. Same GitHub-flavored rendering as the file
 * viewer's MarkdownPreview, plus Obsidian-style `[[wikilinks]]`:
 *  - resolved links open the target note in-app (loadNote)
 *  - unresolved links render muted (the target note doesn't exist yet)
 *  - `[[file:...]]` links are shown as file references (not navigable here)
 *
 * Raw HTML is intentionally not enabled (no rehype-raw), matching MarkdownPreview.
 */
interface Props {
  content: string;
}

const ABSOLUTE_URL = /^(https?:|mailto:)/i;

/**
 * Resolve a wikilink target to a node by id, then case-insensitive title, then case-insensitive
 * alias. Mirrors the Rust graph's resolution order (memory.rs id/file-stem/alias lookup) so
 * `[[alias]]` renders as a resolved link in the preview, matching the edges in the graph.
 */
function resolveTarget(target: string, nodes: MemoryNode[]): MemoryNode | undefined {
  const byId = nodes.find((n) => n.id === target);
  if (byId) return byId;
  const lower = target.toLowerCase();
  const byTitle = nodes.find((n) => n.title.toLowerCase() === lower);
  if (byTitle) return byTitle;
  return nodes.find((n) => n.aliases?.some((a) => a.toLowerCase() === lower));
}

export const MemoryMarkdown: React.FC<Props> = ({ content }) => {
  const { nodes, loadNote } = useMemoryStore();
  const { currentProjectPath } = useProjectStore();

  const components: Components = {
    a(props) {
      const { href, children } = props;

      // In-app memory wikilink.
      if (href && href.startsWith(MEM_LINK_PREFIX)) {
        const target = href.slice(MEM_LINK_PREFIX.length);

        // File reference — not a memory note; show as a styled mono badge.
        if (target.startsWith('file:')) {
          return (
            <code className="mem-link mem-link-file" title={target.slice(5)}>
              {children}
            </code>
          );
        }

        const node = resolveTarget(target, nodes);
        if (!node) {
          return (
            <span className="mem-link mem-link-unresolved" title="Note not found">
              {children}
            </span>
          );
        }
        return (
          <a
            href="#"
            className="mem-link"
            title={node.title}
            onClick={(e) => {
              e.preventDefault();
              if (currentProjectPath) loadNote(currentProjectPath, node);
            }}
          >
            {children}
          </a>
        );
      }

      // Absolute external link — hand to the OS, never navigate the webview.
      return (
        <a
          href={href}
          title={href}
          rel="noreferrer"
          onClick={(e) => {
            e.preventDefault();
            if (href && ABSOLUTE_URL.test(href)) {
              openUrl(href).catch(() => { /* no-op */ });
            }
          }}
        >
          {children}
        </a>
      );
    },
  };

  return (
    <div className="md-preview">
      <Markdown remarkPlugins={[remarkGfm, remarkWikilinks]} components={components}>
        {content}
      </Markdown>
    </div>
  );
};

export default MemoryMarkdown;

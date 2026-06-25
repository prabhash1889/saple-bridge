/**
 * Remark plugin that rewrites Obsidian-style `[[wikilinks]]` into mdast `link`
 * nodes so react-markdown can render them as clickable elements.
 *
 * Supported forms:
 *   [[target]]            → link, label = target
 *   [[target|label]]      → link, label = label
 *   [[file:src/foo.ts]]   → link to an external workspace file (target keeps the
 *                            `file:` prefix so the renderer can branch on it)
 *
 * The rewritten links use a synthetic `saple-mem:<target>` URL scheme. The
 * markdown renderer's custom `a` component branches on that scheme to resolve the
 * target against the memory graph (and never lets the webview navigate away).
 *
 * Operating on the AST — rather than string-replacing before parse — means
 * `[[...]]` inside fenced/inline code is left untouched, since those become
 * `code` / `inlineCode` nodes, not `text`.
 */

export const MEM_LINK_PREFIX = 'saple-mem:';

// Capture `[[target]]` or `[[target|label]]`. Targets/labels can't contain ] or |.
const WIKILINK = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

// Minimal structural types — we avoid depending on @types/mdast being resolvable.
interface MdNode {
  type: string;
  value?: string;
  url?: string;
  title?: string | null;
  children?: MdNode[];
}

function splitTextNode(node: MdNode): MdNode[] {
  const value = node.value ?? '';
  const out: MdNode[] = [];
  let lastIndex = 0;
  WIKILINK.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = WIKILINK.exec(value)) !== null) {
    if (match.index > lastIndex) {
      out.push({ type: 'text', value: value.slice(lastIndex, match.index) });
    }
    const target = match[1].trim();
    const label = (match[2] ?? match[1]).trim();
    out.push({
      type: 'link',
      url: MEM_LINK_PREFIX + target,
      title: null,
      children: [{ type: 'text', value: label }],
    });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex === 0) return [node]; // no wikilinks — leave node as-is
  if (lastIndex < value.length) {
    out.push({ type: 'text', value: value.slice(lastIndex) });
  }
  return out;
}

function transform(node: MdNode): void {
  if (!node.children || node.children.length === 0) return;
  const next: MdNode[] = [];
  for (const child of node.children) {
    // Don't rewrite text that is already inside a link (no nested links).
    if (child.type === 'text' && node.type !== 'link') {
      next.push(...splitTextNode(child));
    } else {
      transform(child);
      next.push(child);
    }
  }
  node.children = next;
}

export default function remarkWikilinks() {
  return (tree: MdNode): void => {
    transform(tree);
  };
}

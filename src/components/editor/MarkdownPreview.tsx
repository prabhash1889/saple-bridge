import React from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';
import { openLink } from '../../stores/browserStore';

/**
 * Rendered Markdown preview (GitHub-flavored) for the Files viewer.
 *
 * Raw HTML is intentionally NOT enabled (no rehype-raw), so untrusted file content
 * cannot inject markup — safe for arbitrary workspace files. Lazy-loaded by CodeViewer
 * so react-markdown stays out of the initial bundle.
 */
interface Props {
  content: string;
}

const ABSOLUTE_URL = /^(https?:|mailto:)/i;

// In a Tauri webview a normal anchor click would navigate the whole app away.
// Intercept it and open absolute links in the built-in browser panel instead.
function openExternally(href: string | undefined) {
  return (e: React.MouseEvent) => {
    e.preventDefault();
    if (href && ABSOLUTE_URL.test(href)) {
      openLink(href);
    }
  };
}

const components: Components = {
  a(props) {
    const { href, children } = props;
    return (
      <a href={href} title={href} rel="noreferrer" onClick={openExternally(href)}>
        {children}
      </a>
    );
  },
};

export const MarkdownPreview: React.FC<Props> = ({ content }) => (
  <div className="md-preview">
    <Markdown remarkPlugins={[remarkGfm]} components={components}>
      {content}
    </Markdown>
  </div>
);

export default MarkdownPreview;

import type { ILink, ILinkProvider, IBufferRange, Terminal } from '@xterm/xterm';

// Clickable-URL support for terminal panes (Phase 3.1). The stable @xterm/addon-web-links
// release still peers on xterm 5, and the xterm-6 build is a pre-release we don't want to
// pin a shipped app to — so we register our own link provider through xterm's supported
// `registerLinkProvider` API. The coordinate math is factored into pure helpers below so it
// can be unit-tested without a live terminal.

// http/https URLs. We grab a greedy run of non-whitespace and trim trailing punctuation
// afterwards (trailingTrim), which is more reliable than trying to express "not trailing
// punctuation" inside the regex across every shell-quoting style.
const URL_REGEX = /https?:\/\/[^\s]+/g;

// Punctuation that commonly sits right after a URL in prose ("see https://x.com.") but is
// almost never part of it. Closing brackets are trimmed only when unbalanced (a URL can
// legitimately contain a matched "(...)", e.g. Wikipedia links).
const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?', '"', "'", '`', '<', '>']);
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

/** Strip trailing punctuation that is not really part of the URL. */
export function trimTrailingPunctuation(url: string): string {
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1];
    if (TRAILING_PUNCTUATION.has(ch)) {
      end -= 1;
      continue;
    }
    const opener = CLOSERS[ch];
    if (opener) {
      const slice = url.slice(0, end);
      const opens = slice.split(opener).length - 1;
      const closes = slice.split(ch).length - 1;
      if (closes > opens) {
        end -= 1;
        continue;
      }
    }
    break;
  }
  return url.slice(0, end);
}

export interface UrlMatch {
  text: string;
  // Offsets into the (cols-padded) logical-line string. `endIndex` is exclusive.
  startIndex: number;
  endIndex: number;
}

const MIN_URL_LENGTH = 'http://a'.length;

/** Find all URLs in a reconstructed logical line, with trailing punctuation trimmed. */
export function findUrlMatches(text: string): UrlMatch[] {
  const matches: UrlMatch[] = [];
  URL_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = URL_REGEX.exec(text)) !== null) {
    const url = trimTrailingPunctuation(match[0]);
    if (url.length < MIN_URL_LENGTH) continue;
    matches.push({ text: url, startIndex: match.index, endIndex: match.index + url.length });
  }
  return matches;
}

// Map a character offset span in the cols-padded logical line back to an xterm buffer range.
// A wrapped logical line stores exactly `cols` cells per row, so offset `i` lives at
// row `startY + floor(i / cols)`, column `(i % cols) + 1` (both 1-based; end is inclusive).
export function offsetsToBufferRange(
  startIndex: number,
  endIndex: number,
  cols: number,
  startY: number,
): IBufferRange {
  const lastIndex = endIndex - 1;
  return {
    start: { x: (startIndex % cols) + 1, y: startY + Math.floor(startIndex / cols) },
    end: { x: (lastIndex % cols) + 1, y: startY + Math.floor(lastIndex / cols) },
  };
}

// Reconstruct the full logical line that `bufferLineNumber` (1-based) belongs to, stitching
// wrapped continuation rows so a URL split across the right edge is still matched as one.
// Returns the cols-padded text and the 1-based buffer row where the logical line starts.
function readLogicalLine(terminal: Terminal, bufferLineNumber: number): { text: string; startY: number } {
  const buffer = terminal.buffer.active;
  let start = bufferLineNumber - 1; // 0-based
  while (start > 0 && buffer.getLine(start)?.isWrapped) start -= 1;

  let text = '';
  let i = start;
  while (true) {
    const line = buffer.getLine(i);
    if (!line) break;
    // trimRight=false keeps each row padded to `cols`, so offset→cell math stays uniform.
    text += line.translateToString(false);
    const next = buffer.getLine(i + 1);
    if (next?.isWrapped) {
      i += 1;
    } else {
      break;
    }
  }
  return { text, startY: start + 1 };
}

/** A link provider that makes http(s) URLs clickable, handing them to `activate`. */
export function createWebLinkProvider(
  terminal: Terminal,
  activate: (url: string) => void,
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const cols = terminal.cols;
      if (cols < 1) {
        callback(undefined);
        return;
      }
      const { text, startY } = readLogicalLine(terminal, bufferLineNumber);
      const matches = findUrlMatches(text);
      if (matches.length === 0) {
        callback(undefined);
        return;
      }
      const links: ILink[] = matches.map((mt) => ({
        text: mt.text,
        range: offsetsToBufferRange(mt.startIndex, mt.endIndex, cols, startY),
        decorations: { pointerCursor: true, underline: true },
        activate: (event, url) => {
          event.preventDefault();
          activate(url);
        },
      }));
      callback(links);
    },
  };
}

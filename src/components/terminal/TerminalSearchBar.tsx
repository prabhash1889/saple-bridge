import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { SearchAddon } from '@xterm/addon-search';

interface TerminalSearchBarProps {
  searchAddonRef: React.RefObject<SearchAddon | null>;
  // Close the bar; the parent clears its `open` flag and refocuses the terminal.
  onClose: () => void;
}

// The Ctrl/Cmd+F find-in-terminal overlay (C1). Owns the query state and drives the xterm
// search addon; mounted by TerminalPane only while the bar is open.
export const TerminalSearchBar: React.FC<TerminalSearchBarProps> = ({ searchAddonRef, onClose }) => {
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Focus the find bar as soon as it opens (Ctrl+F inside xterm can't focus a React input
  // synchronously — the overlay mounts on the next render).
  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  const runSearch = (direction: 'next' | 'previous', query = searchQuery) => {
    const addon = searchAddonRef.current;
    if (!addon || !query) return;
    if (direction === 'next') addon.findNext(query, { incremental: false });
    else addon.findPrevious(query, { incremental: false });
  };

  const handleSearchInput = (value: string) => {
    setSearchQuery(value);
    // Incremental: extend the current match as the user types instead of jumping ahead.
    if (value) searchAddonRef.current?.findNext(value, { incremental: true });
  };

  const closeSearch = () => {
    try {
      searchAddonRef.current?.clearDecorations();
    } catch {
      // Addon may already be disposed with its terminal — nothing to clear.
    }
    onClose();
  };

  return (
    <div className="terminal-search-overlay">
      <Search size={12} aria-hidden />
      <input
        ref={searchInputRef}
        className="terminal-search-input"
        value={searchQuery}
        placeholder="Find in terminal"
        spellCheck={false}
        onChange={(e) => handleSearchInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            runSearch(e.shiftKey ? 'previous' : 'next');
          } else if (e.key === 'Escape') {
            e.preventDefault();
            closeSearch();
          }
        }}
      />
      <button
        className="terminal-pane-title-button"
        onClick={() => runSearch('previous')}
        title="Previous match (Shift+Enter)"
        aria-label="Previous match"
      >
        <ChevronUp size={13} />
      </button>
      <button
        className="terminal-pane-title-button"
        onClick={() => runSearch('next')}
        title="Next match (Enter)"
        aria-label="Next match"
      >
        <ChevronDown size={13} />
      </button>
      <button
        className="terminal-pane-title-button"
        onClick={closeSearch}
        title="Close search (Esc)"
        aria-label="Close search"
      >
        <X size={13} />
      </button>
    </div>
  );
};

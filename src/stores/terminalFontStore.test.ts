import { describe, it, expect, beforeEach } from 'vitest';
import { useTerminalFontStore } from './terminalFontStore';

const store = () => useTerminalFontStore.getState();

describe('terminalFontStore screenReaderMode', () => {
  beforeEach(() => {
    // Reset to defaults; the persist middleware rehydrates from localStorage in the
    // browser but starts clean in tests.
    useTerminalFontStore.setState({ screenReaderMode: false });
  });

  it('defaults to off', () => {
    expect(store().screenReaderMode).toBe(false);
  });

  it('round-trips through the setter', () => {
    store().setScreenReaderMode(true);
    expect(store().screenReaderMode).toBe(true);
    store().setScreenReaderMode(false);
    expect(store().screenReaderMode).toBe(false);
  });
});

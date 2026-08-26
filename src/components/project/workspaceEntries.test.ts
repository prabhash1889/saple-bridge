import { describe, it, expect } from 'vitest';
import { ROOM_ORDER } from '../../stores/projectStore';
import { workspaceEntries } from './workspaceEntries';

// The home page shows a keyboard hint per room entry. That hint must match the real
// global binding in App.tsx: Alt + (position in ROOM_ORDER). This test is the contract
// that keeps the displayed hints and the actual keybindings from drifting apart.
describe('dashboard shortcut hints', () => {
  it('every entry hint matches the room position in ROOM_ORDER', () => {
    for (const entry of workspaceEntries) {
      const index = ROOM_ORDER.indexOf(entry.id);
      expect(index, `room "${entry.id}" must exist in ROOM_ORDER`).toBeGreaterThan(-1);
      expect(entry.hint).toBe(`Alt+${index + 1}`);
    }
  });
});

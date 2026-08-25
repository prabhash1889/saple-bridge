import type { ViewType } from '../../stores/projectStore';

// Home-page room entries. The `hint` must mirror the actual global binding in App.tsx:
// rooms switch with Alt + position in ROOM_ORDER (see projectStore), not a per-room number.
// This module stays dependency-free so the hint-to-binding contract can be unit tested
// without pulling in the view layer.
export const workspaceEntries: Array<{
  id: ViewType;
  title: string;
  description: string;
  hint: string;
}> = [
  {
    id: 'terminals',
    title: 'Saple Bridge',
    description: 'Open the command room and arrange local terminal agents.',
    hint: 'Alt+2',
  },
  {
    id: 'swarm',
    title: 'Saple Swarm',
    description: 'Coordinate multi-agent missions for the current workspace.',
    hint: 'Alt+5',
  },
  {
    id: 'editor',
    title: 'Saple Canvas',
    description: 'Inspect files and shape workspace context.',
    hint: 'Alt+7',
  },
];

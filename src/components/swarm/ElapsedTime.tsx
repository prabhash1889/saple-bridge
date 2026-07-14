import React, { useEffect, useState } from 'react';
import { formatElapsed } from '../../lib/swarmStatus';

// Ticking "running for" badge for active agent nodes/cards. `startedAt` is the ms epoch stamped
// when the agent went running (persisted on the agent, so it survives room/project switches and
// restart). Renders nothing without a start time.
export const ElapsedTime: React.FC<{ startedAt?: number; className?: string }> = ({
  startedAt,
  className,
}) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);
  if (!startedAt) return null;
  return <span className={className}>{formatElapsed(now - startedAt)}</span>;
};

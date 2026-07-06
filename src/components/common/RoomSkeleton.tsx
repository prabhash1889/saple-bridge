import React from 'react';

/**
 * Lightweight placeholder shown while a lazily-loaded room chunk resolves.
 * Replaces the bare "Loading room..." text with a calm shimmer so the switch
 * reads as progress rather than a blank flash. The shimmer respects
 * prefers-reduced-motion (see common.css).
 */
export const RoomSkeleton: React.FC = () => (
  <div className="room-skeleton" role="status" aria-label="Loading room">
    <div className="room-skeleton-header">
      <div className="skeleton-block skeleton-title" />
      <div className="skeleton-block skeleton-subtitle" />
    </div>
    <div className="room-skeleton-grid">
      <div className="skeleton-block skeleton-card" />
      <div className="skeleton-block skeleton-card" />
      <div className="skeleton-block skeleton-card" />
      <div className="skeleton-block skeleton-card" />
    </div>
    <span className="visually-hidden">Loading room…</span>
  </div>
);

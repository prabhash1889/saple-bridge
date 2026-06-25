import type React from 'react';

// Shared inline styles for the swarm creation wizard. Steps reuse these so the
// hero / section / chip / input language stays consistent across all six screens.

export const heroWrapStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  textAlign: 'center',
  gap: '8px',
  marginBottom: '28px',
};

export const heroIconWrapStyle: React.CSSProperties = {
  width: '56px',
  height: '56px',
  borderRadius: '50%',
  display: 'grid',
  placeItems: 'center',
  background: 'var(--accent-light)',
  color: 'var(--accent)',
  marginBottom: '4px',
  boxShadow: '0 0 0 6px rgba(93, 95, 239, 0.06)',
};

export const heroTitleStyle: React.CSSProperties = {
  fontSize: '20px',
  fontWeight: 700,
  color: 'var(--text-primary)',
  margin: 0,
};

export const heroSubtitleStyle: React.CSSProperties = {
  fontSize: '13px',
  color: 'var(--text-secondary)',
  maxWidth: '540px',
  lineHeight: 1.55,
  margin: 0,
};

export const sectionLabelStyle: React.CSSProperties = {
  fontSize: '10px',
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
  marginBottom: '10px',
};

export const sectionStyle: React.CSSProperties = {
  marginBottom: '24px',
};

export const chipRowStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '8px',
};

export const chipStyle = (selected: boolean, accent = 'var(--accent)'): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  padding: '6px 12px',
  borderRadius: 'var(--radius-full)',
  border: `1px solid ${selected ? accent : 'var(--border)'}`,
  background: selected ? 'var(--accent-light)' : 'var(--bg-surface-light)',
  color: selected ? 'var(--text-primary)' : 'var(--text-secondary)',
  fontSize: '12px',
  fontWeight: 600,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  transition: 'border-color 0.15s, background 0.15s, color 0.15s',
});

export const inputStyle: React.CSSProperties = {
  width: '100%',
  height: '36px',
  background: 'var(--bg-deep)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--text-primary)',
  padding: '0 12px',
  fontSize: '13px',
};

export const textareaStyle: React.CSSProperties = {
  width: '100%',
  minHeight: '120px',
  background: 'var(--bg-deep)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)',
  color: 'var(--text-primary)',
  padding: '12px',
  fontSize: '13px',
  lineHeight: 1.5,
  resize: 'vertical',
};

export const errorBannerStyle: React.CSSProperties = {
  backgroundColor: 'rgba(239, 68, 68, 0.1)',
  color: 'var(--color-danger)',
  border: '1px solid rgba(239, 68, 68, 0.2)',
  padding: '10px 14px',
  borderRadius: 'var(--radius-md)',
  fontSize: '12px',
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  marginBottom: '16px',
};

export const warningBannerStyle: React.CSSProperties = {
  backgroundColor: 'rgba(245, 158, 11, 0.1)',
  color: 'var(--color-warning)',
  border: '1px solid rgba(245, 158, 11, 0.25)',
  padding: '10px 14px',
  borderRadius: 'var(--radius-md)',
  fontSize: '12px',
  display: 'flex',
  alignItems: 'flex-start',
  gap: '8px',
  marginBottom: '12px',
};

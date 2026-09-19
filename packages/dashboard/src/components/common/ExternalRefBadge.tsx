import type { CSSProperties } from 'react';
import { X } from 'lucide-react';
import { useStickyExternalRef } from '../../lib/externalRef.js';

export function ExternalRefBadge() {
  const { ref, clear } = useStickyExternalRef();
  if (!ref) return null;
  return (
    <div style={wrapStyle}>
      <span style={labelStyle}>external ref</span>
      <span className="mono" style={valueStyle} title={ref}>
        {ref}
      </span>
      <button
        type="button"
        onClick={clear}
        title="Remove — the next stream won't carry this ref"
        aria-label="Remove external ref"
        style={xStyle}
      >
        <X size={13} />
      </button>
    </div>
  );
}

const wrapStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  padding: '5px 8px 5px 10px',
  marginBottom: 14,
  maxWidth: '100%',
  minWidth: 0,
  background: 'color-mix(in oklab, var(--accent) 8%, var(--card))',
  border: '1px solid color-mix(in oklab, var(--accent) 30%, var(--line))',
  borderRadius: 8,
  fontSize: 12,
};

const labelStyle: CSSProperties = {
  color: 'var(--fg-4)',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  fontSize: 9.5,
  fontWeight: 600,
  flexShrink: 0,
};

const valueStyle: CSSProperties = {
  color: 'var(--fg)',
  fontSize: 12,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  minWidth: 0,
};

const xStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 2,
  borderRadius: 5,
  border: 0,
  background: 'transparent',
  color: 'var(--fg-3)',
  cursor: 'pointer',
  flexShrink: 0,
};

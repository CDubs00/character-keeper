/**
 * RollLog.jsx
 *
 * Slide-over panel showing this character's dice roll history (newest
 * first). Purely presentational — CharacterSheet owns the `rolls` array
 * (fetched once on load, then kept current as DiceTray reports each new
 * roll via onRollLogged), so this component never fetches on its own.
 *
 * `source` is rendered when present but is empty for every roll today; it's
 * reserved for a future "roll from this field" trigger (e.g. a Sword Attack
 * button on the sheet) to label an entry without any storage change.
 */
import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { DIE_ICONS } from './DiceFaces';

function formatTime(iso) {
  try {
    const date = new Date(iso);
    const now = new Date();

    const isToday =
      date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate();

    if (isToday) {
      return date.toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit',
      });
    }

    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');

    const time = date.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });

    return `${yyyy}.${mm}.${dd} ${time}`;
  } catch {
    return '';
  }
}

export default function RollLog({ open, onClose, rolls }) {
  // Escape closes the panel, same as DiceTray's drawer.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const panelStyle = {
    position: 'fixed', top: 0, right: 0, bottom: 0, zIndex: 1600,
    width: 320, maxWidth: '88vw',
    background: 'var(--bg-surface)', borderLeft: '1px solid var(--border)',
    boxShadow: '-6px 0 24px rgba(0,0,0,0.45)',
    display: 'flex', flexDirection: 'column',
    transform: open ? 'translateX(0)' : 'translateX(100%)',
    transition: 'transform 0.25s ease',
  };

  return createPortal(
    <div style={panelStyle} role="dialog" aria-label="Roll log" aria-hidden={!open}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 16px', borderBottom: '1px solid var(--border)',
      }}>
        <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700,
          letterSpacing: '0.05em', color: 'var(--text-accent)', fontSize: '0.9rem' }}>
          Roll Log
        </span>
        <button type="button" onClick={onClose}
          style={{ border: 'none', background: 'none', color: 'var(--text-dim)',
            cursor: 'pointer', fontSize: '1.1rem', lineHeight: 1, padding: 4 }}
          aria-label="Close roll log">×</button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px' }}>
        {rolls.length === 0 && (
          <p style={{ color: 'var(--text-dim)', fontFamily: 'var(--font-mono)',
            fontSize: '0.78rem', textAlign: 'center', marginTop: 24 }}>
            No rolls yet.
          </p>
        )}

        {rolls.map((entry) => (
          <div key={entry.id} style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '8px 4px', borderBottom: '1px solid var(--border)',
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              {entry.source && (
                <div style={{ fontFamily: 'var(--font-display)', fontSize: '0.72rem',
                  color: 'var(--text-primary)', marginBottom: 2 }}>
                  {entry.source}
                </div>
              )}
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
                {Object.entries(entry.dice || {})
                  .sort((a, b) => parseInt(a[0].slice(1), 10) - parseInt(b[0].slice(1), 10))
                  .map(([die, vals]) => {
                    const Glyph = DIE_ICONS[die];
                    return (
                      <span key={die} style={{ display: 'inline-flex', alignItems: 'center', gap: 3,
                        fontFamily: 'var(--font-mono)', fontSize: '0.7rem', color: 'var(--text-dim)' }}>
                        {Glyph && <Glyph size={14} />}
                        {vals.join(',')}
                      </span>
                    );
                  })}
                {entry.modifier !== 0 && (
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.7rem', color: 'var(--text-dim)' }}>
                    {entry.modifier > 0 ? `+${entry.modifier}` : entry.modifier}
                  </span>
                )}
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.62rem', color: 'var(--text-dim)', marginTop: 2 }}>
                {formatTime(entry.rolledAt)}
              </div>
            </div>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700,
              fontSize: '1.3rem', color: 'var(--text-accent)', minWidth: 36, textAlign: 'right' }}>
              {entry.total}
            </div>
          </div>
        ))}
      </div>
    </div>,
    document.body
  );
}
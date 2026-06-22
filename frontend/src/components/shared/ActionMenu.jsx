import React, { useState, useEffect, useRef } from 'react';

/**
 * ActionMenu — a kebab (⋯) overflow menu.
 *
 * Pass an `items` array of { label, onClick, danger? }. Falsy entries are
 * skipped, so you can inline conditionals directly in the array. If no items
 * remain, the menu renders nothing — that's what makes per-viewer / per-character
 * filtering work: a viewer with no permitted actions simply gets no menu.
 *
 * The panel right-aligns to the button and flips upward when it's near the
 * bottom of the viewport, so it never clips off-screen on mobile. Closes on
 * outside-click or Escape.
 */
export default function ActionMenu({ items, label }) {
  const [open,   setOpen]   = useState(false);
  const [openUp, setOpenUp] = useState(false);
  const wrapRef = useRef(null);
  const btnRef  = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    const onKey  = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const visible = items.filter(it => it && !it.hidden);
  if (visible.length === 0) return null;

  const toggle = (e) => {
    e.stopPropagation();
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      const estHeight = visible.length * 38 + 12;          // rough menu height
      setOpenUp(rect.bottom + estHeight > window.innerHeight && rect.top > estHeight);
    }
    setOpen(o => !o);
  };

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-block' }}>
      {label ? (
        <button ref={btnRef} type="button" className="btn-ghost" onClick={toggle}
          aria-haspopup="menu" aria-expanded={open}
          style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
          {label}<span style={{ fontSize: '0.7em', opacity: 0.8 }}>▾</span>
        </button>
      ) : (
        <button ref={btnRef} type="button" onClick={toggle}
          aria-haspopup="menu" aria-expanded={open} title="Actions"
          onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--border-bright)'; e.currentTarget.style.color = 'var(--text-accent)'; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: '2rem', height: '1.8rem', padding: 0,
            background: 'var(--bg-input)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
          }}>
          {/* SVG instead of the ⋯ glyph: text characters sit on a font baseline,
              so the dots rendered visually high. Shapes center exactly. */}
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" style={{ display: 'block' }}>
            <circle cx="2.5"  cy="7" r="1.4" fill="currentColor" />
            <circle cx="7"    cy="7" r="1.4" fill="currentColor" />
            <circle cx="11.5" cy="7" r="1.4" fill="currentColor" />
          </svg>
        </button>
      )}

      {open && (
        <div role="menu" onClick={e => e.stopPropagation()} style={{
          position: 'absolute',
          right: 0,
          ...(openUp ? { bottom: '100%', marginBottom: '0.25rem' } : { top: '100%', marginTop: '0.25rem' }),
          minWidth: '150px',
          background: 'var(--bg-raised)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
          padding: '0.25rem',
          display: 'flex',
          flexDirection: 'column',
          zIndex: 200,
        }}>
          {visible.map((it, i) => (
            <button key={i} type="button" role="menuitem"
              onClick={(e) => { e.stopPropagation(); setOpen(false); it.onClick(e); }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-input)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}
              style={{
                background: 'none', border: 'none', textAlign: 'left',
                font: 'inherit', fontSize: '0.8rem', cursor: 'pointer',
                padding: '0.4rem 0.6rem', borderRadius: 'var(--radius)',
                color: it.danger ? 'var(--red)' : 'var(--text-primary)',
                whiteSpace: 'nowrap',
              }}>
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

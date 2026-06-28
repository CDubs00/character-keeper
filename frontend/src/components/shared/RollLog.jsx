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
import React, { useEffect, useRef, useState } from 'react';
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

// ── Notation help content ──────────────────────────────────────────────────────
// One source of truth for what the popup teaches.  Each row is { syntax, label,
// example } so the popup can render a tight three-column layout AND let the
// user click an example to populate the command input.
const NOTATION_HELP_SECTIONS = [
  {
    heading: 'Keep / Drop',
    rows: [
      { syntax: 'khN', label: 'Keep highest N',  example: '2d20kh1+5' },
      { syntax: 'klN', label: 'Keep lowest N',   example: '2d20kl1' },
      { syntax: 'dhN', label: 'Drop highest N',  example: '4d6dh1' },
      { syntax: 'dlN', label: 'Drop lowest N',   example: '4d6dl1' },
    ],
  },
  {
    heading: 'Reroll',
    rows: [
      { syntax: 'rN',  label: 'Reroll Ns once',           example: '4d6r1' },
      { syntax: 'rrN', label: 'Reroll Ns until none left', example: '4d6rr1' },
    ],
  },
  {
    heading: 'Explode',
    rows: [
      { syntax: 'x',  label: 'Explode on max',           example: '1d6x' },
      { syntax: 'xo', label: 'Explode on max once',      example: '5d10xo' },
      { syntax: 'xN', label: 'Explode up to N times',    example: '3d6x3' },
    ],
  },
  {
    heading: 'Successes',
    rows: [
      { syntax: 'cs>=N', label: 'Count successes',        example: '5d10cs>=8' },
      { syntax: 'cf<=N', label: 'Count failures',         example: '5d10cf1' },
      { syntax: 'df<=N', label: 'Subtract failures',      example: '5d10cs>=7df1' },
    ],
  },
  {
    heading: 'Bounds',
    rows: [
      { syntax: 'minN', label: 'Floor each die at N',     example: '3d6min2' },
      { syntax: 'maxN', label: 'Cap each die at N',       example: '3d6max5' },
    ],
  },
  {
    heading: 'Special',
    rows: [
      { syntax: 'dF',  label: 'Fate / Fudge (-1, 0, +1)', example: '4dF' },
      { syntax: '/',   label: 'Roll independently',       example: '1d6x/1d6x' },
    ],
  },
];

// ── NotationHelp ──────────────────────────────────────────────────────────────
// Small popover triggered by the ⓘ next to "Roll notation".  Renders inside the
// RollLog panel rather than as a global portal so it inherits the panel's z-index
// and doesn't clip outside the slide-over on mobile.
//
// Clicking any example calls onInsertExample(notation) to populate the command
// input — saves the user from having to type the syntax to try it.
function NotationHelp({ open, onClose, onInsertExample }) {
  const popRef = useRef(null);

  // Outside-click / Escape closes
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (popRef.current?.contains(e.target)) return;
      // The ⓘ button is the toggle; clicking it again calls onClose itself.
      // Anything else closes.
      const trigger = document.getElementById('notation-help-trigger');
      if (trigger?.contains(e.target)) return;
      onClose();
    };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={popRef}
      role="dialog"
      aria-label="Dice notation help"
      style={{
        position: 'absolute', top: '100%', left: 0, right: 0,     // ← was bottom: '100%'
        marginTop: 6,                                              // ← was marginBottom: 6
        zIndex: 10,
        background: 'var(--bg-surface)',
        border: '1px solid var(--accent, #b48c3c)',
        borderRadius: 6,
        boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
        maxHeight: '60vh', overflowY: 'auto',
        padding: '10px 12px',
      }}
    >
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 8, paddingBottom: 6, borderBottom: '1px solid var(--border)',
      }}>
        <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700,
          fontSize: '0.78rem', letterSpacing: '0.05em',
          color: 'var(--text-accent)' }}>
          Dice Notation
        </span>
        <button type="button" onClick={onClose}
          style={{ border: 'none', background: 'none', color: 'var(--text-dim)',
            cursor: 'pointer', fontSize: '1rem', lineHeight: 1, padding: 2 }}
          aria-label="Close help">×</button>
      </div>

      {NOTATION_HELP_SECTIONS.map((section) => (
        <div key={section.heading} style={{ marginBottom: 10 }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.58rem',
            color: 'var(--text-dim)', letterSpacing: '0.08em',
            textTransform: 'uppercase', marginBottom: 4 }}>
            {section.heading}
          </div>
          {section.rows.map((row) => (
            <div key={row.syntax + row.example} style={{
              display: 'grid',
              gridTemplateColumns: '52px 1fr auto',
              gap: 8, alignItems: 'baseline',
              padding: '3px 0',
              fontFamily: 'var(--font-mono)', fontSize: '0.7rem',
            }}>
              <span style={{ color: 'var(--text-accent)', fontWeight: 700 }}>
                {row.syntax}
              </span>
              <span style={{ color: 'var(--text-primary)', lineHeight: 1.3 }}>
                {row.label}
              </span>
              {/* Example: click to insert into the command bar */}
              <button type="button" onClick={() => onInsertExample(row.example)}
                title="Insert this example"
                style={{
                  border: '1px solid var(--border)', borderRadius: 3,
                  background: 'var(--bg-raised, rgba(255,255,255,0.06))',
                  color: 'var(--text-dim)', cursor: 'pointer',
                  fontFamily: 'var(--font-mono)', fontSize: '0.65rem',
                  padding: '2px 6px', whiteSpace: 'nowrap',
                }}>
                {row.example}
              </button>
            </div>
          ))}
        </div>
      ))}

      <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.6rem',
        color: 'var(--text-dim)', borderTop: '1px solid var(--border)',
        paddingTop: 6, marginTop: 4, lineHeight: 1.5 }}>
        Combine with <span style={{ color: 'var(--text-accent)' }}>+</span> for one total
        (e.g. <span style={{ color: 'var(--text-accent)' }}>2d6+1d8+3</span>)
        or <span style={{ color: 'var(--text-accent)' }}>/</span> for separate rolls.
      </div>
    </div>
  );
}

export default function RollLog({ open, onClose, rolls, onRollCommand }) {
  // Escape closes the panel, same as DiceTray's drawer.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Command bar
  const [cmd,     setCmd]     = useState('');
  const [cmdErr,  setCmdErr]  = useState('');
  const [cmdBusy, setCmdBusy] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const inputRef = useRef(null);

  // Focus the input whenever the panel opens
  useEffect(() => {
    if (open && onRollCommand) {
      const t = setTimeout(() => inputRef.current?.focus(), 80);
      return () => clearTimeout(t);
    }
  }, [open, onRollCommand]);

  const handleRollCommand = async () => {
    const notation = cmd.trim();
    if (!notation || cmdBusy || !onRollCommand) return;
    setCmdErr('');
    setCmdBusy(true);
    try {
      const result = await onRollCommand(notation);
      if (result?.error) {
        setCmdErr(result.error);
      } else {
        setCmd('');
      }
    } catch (e) {
      setCmdErr(e.message || 'Roll failed');
    } finally {
      setCmdBusy(false);
    }
  };

  // Clicking an example in the help popup drops it into the input — gives the
  // user a fast way to try a notation without typing it, and closes the popup
  // so they can see what they're about to roll.
  const insertExample = (notation) => {
    setCmd(notation);
    setCmdErr('');
    setHelpOpen(false);
    inputRef.current?.focus();
  };

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
    <>
      {/* Backdrop — clicking anywhere outside the panel closes it.
          pointer-events only active when open so it doesn't block the sheet. */}
      <div
        aria-hidden="true"
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0, zIndex: 1599,
          background: 'transparent',
          pointerEvents: open ? 'auto' : 'none',
        }}
      />

      <div style={panelStyle} role="dialog" aria-label="Roll log" aria-hidden={!open}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 16px', borderBottom: '1px solid var(--border)',
          flexShrink: 0,
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

        {/* Command bar — only shown when a roll handler is wired up (i.e. dice
            are available for this bundle; CharacterSheet omits the prop if not).
            position:relative anchors the help popover, which renders just above
            the bar via position:absolute. */}
        {onRollCommand && (
          <div style={{
            padding: '10px 12px', borderTop: '1px solid var(--border)',
            flexShrink: 0, position: 'relative',
          }}>
            <NotationHelp
              open={helpOpen}
              onClose={() => setHelpOpen(false)}
              onInsertExample={insertExample}
            />

            {/* Label + info trigger */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.6rem',
                color: 'var(--text-dim)', letterSpacing: '0.08em',
                textTransform: 'uppercase' }}>
                Roll notation
              </span>
              <button
                id="notation-help-trigger"
                type="button"
                onClick={() => setHelpOpen((o) => !o)}
                title="Notation help"
                aria-label="Notation help"
                aria-expanded={helpOpen}
                style={{
                  border: '1px solid var(--border)', borderRadius: '50%',
                  background: helpOpen ? 'var(--accent-glow, rgba(180,140,60,0.18))' : 'transparent',
                  color: helpOpen ? 'var(--text-accent)' : 'var(--text-dim)',
                  cursor: 'pointer', width: 16, height: 16, lineHeight: 1,
                  fontFamily: 'var(--font-display)', fontSize: '0.65rem',
                  fontWeight: 700, padding: 0,
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                }}>
                i
              </button>
            </div>

            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                ref={inputRef}
                type="text"
                value={cmd}
                placeholder="e.g. 4d6kh3 or 5d10cs>=8"
                onChange={(e) => { setCmd(e.target.value); if (cmdErr) setCmdErr(''); }}
                onKeyDown={(e) => { if (e.key === 'Enter') handleRollCommand(); }}
                style={{
                  flex: 1, minWidth: 0,
                  background: 'var(--bg-raised, rgba(255,255,255,0.06))',
                  border: '1px solid var(--border)', borderRadius: 4,
                  color: 'var(--text-primary)', fontFamily: 'var(--font-mono)',
                  fontSize: '0.78rem', padding: '5px 8px', outline: 'none',
                }}
                aria-label="Dice notation"
                spellCheck={false}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
              />
              <button
                type="button"
                onClick={handleRollCommand}
                disabled={cmdBusy || !cmd.trim()}
                style={{
                  padding: '5px 10px', borderRadius: 4,
                  border: '1px solid var(--accent, #b48c3c)',
                  background: cmdBusy || !cmd.trim()
                    ? 'transparent'
                    : 'var(--accent-glow, rgba(180,140,60,0.18))',
                  color: 'var(--text-accent)', fontFamily: 'var(--font-display)',
                  fontWeight: 700, fontSize: '0.75rem',
                  cursor: cmdBusy || !cmd.trim() ? 'default' : 'pointer',
                  opacity: cmdBusy || !cmd.trim() ? 0.45 : 1,
                  letterSpacing: '0.05em', whiteSpace: 'nowrap',
                }}>
                {cmdBusy ? '…' : 'Roll'}
              </button>
            </div>
            {cmdErr && (
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.65rem',
                color: 'var(--color-danger, #c0392b)', marginTop: 5, lineHeight: 1.4 }}>
                {cmdErr}
              </div>
            )}
          </div>
        )}

        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px' }}>
          {rolls.length === 0 && (
            <p style={{ color: 'var(--text-dim)', fontFamily: 'var(--font-mono)',
              fontSize: '0.78rem', textAlign: 'center', marginTop: 24 }}>
              No rolls yet.
            </p>
          )}

          {rolls.map((entry) => {
            // Multi-roll entries (slash-separated like "1d6x/1d6x") carry
            // their per-segment breakdown.  Each segment had its own total
            // when rolled, so we show each one separately rather than a
            // single combined total that would misrepresent what happened.
            const isMulti = Array.isArray(entry.segments) && entry.segments.length > 1;

            return (
              <div key={entry.id} style={{
                display: 'flex', alignItems: isMulti ? 'flex-start' : 'center', gap: 10,
                padding: '8px 4px', borderBottom: '1px solid var(--border)',
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {entry.source && (
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.65rem',
                      color: 'var(--text-dim)', marginBottom: 4, letterSpacing: '0.03em' }}>
                      {entry.source}
                    </div>
                  )}

                  {isMulti ? (
                    /* Per-segment rows: notation · dice · total */
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {entry.segments.map((seg, i) => (
                        <div key={i} style={{
                          display: 'flex', alignItems: 'center', gap: 8,
                          paddingTop: i > 0 ? 4 : 0,
                          borderTop: i > 0 ? '1px dashed var(--border)' : 'none',
                        }}>
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.62rem',
                            color: 'var(--text-dim)', minWidth: 56 }}>
                            {seg.notation}
                          </span>
                          <div style={{ flex: 1, display: 'flex', flexWrap: 'wrap',
                            alignItems: 'center', gap: 5 }}>
                            {Object.entries(seg.dice || {})
                              .sort((a, b) => parseInt(a[0].slice(1), 10) - parseInt(b[0].slice(1), 10))
                              .map(([die, vals]) => {
                                const Glyph = DIE_ICONS[die];
                                return (
                                  <span key={die} style={{ display: 'inline-flex', alignItems: 'center',
                                    gap: 3, fontFamily: 'var(--font-mono)', fontSize: '0.7rem',
                                    color: 'var(--text-dim)' }}>
                                    {Glyph && <Glyph size={14} />}
                                    {vals.join(',')}
                                  </span>
                                );
                              })}
                            {seg.modifier !== 0 && (
                              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.7rem',
                                color: 'var(--text-dim)' }}>
                                {seg.modifier > 0 ? `+${seg.modifier}` : seg.modifier}
                              </span>
                            )}
                          </div>
                          <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700,
                            fontSize: '1.05rem', color: 'var(--text-accent)',
                            minWidth: 28, textAlign: 'right' }}>
                            {seg.total}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    /* Single roll: dice inline, total on the right (existing layout) */
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
                  )}

                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.62rem',
                    color: 'var(--text-dim)', marginTop: 4 }}>
                    {formatTime(entry.rolledAt)}
                  </div>
                </div>

                {/* Right-rail total: only for single rolls.  Multi-rolls show
                    totals inline per segment, so a single grand total here
                    would just confuse what's a sum versus what's individual. */}
                {!isMulti && (
                  <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700,
                    fontSize: '1.3rem', color: 'var(--text-accent)', minWidth: 36, textAlign: 'right' }}>
                    {entry.total}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </>,
    document.body
  );
}
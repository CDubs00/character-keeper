/**
 * CharacterSheet.jsx
 *
 * Shell that owns:
 *   - Character load + bundle verification
 *   - Autosave (debounced, uses stable ID always)
 *
 * Rename now lives on the Character page — the name field inside the sheet
 * is read-only (rendered via data-type="readonly-name" in the bundle).
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import SheetRenderer from './SheetRenderer';
import DiceTray from './DiceTray';
import RollLog from './shared/RollLog';
import FilesModal from './shared/FilesModal';
import { api } from '../api';
import { SwordsIcon, DiceIcon, FileIcon } from './shared/Icons';

const AUTOSAVE_DELAY_MS = 800;

export default function CharacterSheet({ user }) {
  const { id }   = useParams();
  const navigate = useNavigate();

  const [char,      setChar]      = useState(null);
  const [bundle,    setBundle]    = useState(null);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState(null);   // { message, status } | null
  const [saveState, setSaveState] = useState('saved');

  const autosaveTimer = useRef(null);
  const pendingChar   = useRef(null);
  const diceRef       = useRef(null);   // exposes rollFromNotation to RollLog command bar

  const [diceOpen,      setDiceOpen]      = useState(false);
  const [diceAvailable, setDiceAvailable] = useState(true);  // hidden if a bundle opts out
  const [logOpen,       setLogOpen]       = useState(false);
  const [rolls,         setRolls]         = useState([]);    // this character's roll log
  const [filesOpen,           setFilesOpen]           = useState(false);
  const [attachmentsAllowed,  setAttachmentsAllowed]  = useState(false); // admin gate for the Files button

  // Track a narrow viewport so the header can drop the name onto its own row
  // below the buttons (inline styles can't carry a media query).
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)');
    const onChange = (e) => setIsMobile(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Whether the admin has enabled file attachments — gates the Files button so a
  // disabled instance doesn't show an entry point that 403s on use.
  useEffect(() => {
    api.getSettings().then(s => { if (s && !s.error) setAttachmentsAllowed(!!s.allowAttachments); }).catch(() => {});
  }, []);

  // ── Load character + verify bundle ────────────────────────────────────────
  useEffect(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      api.getCharacter(id),
      // Roll log is non-critical to the sheet rendering — a flaky/failed fetch
      // here shouldn't block the character from loading, so it gets its own
      // catch instead of falling into the shared .catch below.
      api.getRolls(id).catch(() => []),
    ])
      .then(async ([charData, rollsData]) => {
        // api.getCharacter resolves to an { error, status } envelope when the
        // request failed (e.g. 403 Forbidden because this isn't our character,
        // or 404 because it's gone). We must NOT treat that as a character —
        // doing so is what produced the misleading "Sheet Not Found / Unknown
        // Sheet" screen, since the error object has no sheetId.
        if (charData?.error) {
          setError({ message: charData.error, status: charData.status });
          setLoading(false);
          return;
        }
        setChar(charData);
        setRolls(Array.isArray(rollsData) ? rollsData : []);

        // Verify the bundle is present — by sheetId, ignoring the admin-set
        // `enabled` flag. A disabled sheet still renders for existing
        // characters; only a truly missing registry entry should trip the
        // "Sheet Not Found" screen. The /info endpoint exists for exactly
        // this lookup so we don't have to consult the picker-friendly list.
        const info = await api.getSheetInfo(charData.sheetId);
        setBundle(info?.error ? null : info);
        setLoading(false);
      })
      .catch(e => { setError({ message: e.message, status: e.status }); setLoading(false); });
  }, [id]);

  // ── Autosave ───────────────────────────────────────────────────────────────
  const flush = useCallback(() => {
    if (!pendingChar.current) return;
    const toSave = pendingChar.current;
    pendingChar.current = null;
    setSaveState('saving');
    api.saveCharacter(id, toSave)
      .then((saved) => {
        // A save can now legitimately fail (e.g. a stale tab whose ownership
        // changed underneath it) — surface that instead of falsely showing
        // "Saved".
        if (saved?.error) { setSaveState('error'); return; }
        setSaveState('saved');
        if (saved && typeof saved === 'object') {
          setChar(c => c ? { ...c, campaignId: saved.campaignId ?? null, campaignName: saved.campaignName ?? null } : c);
        }
      })
      .catch(() => setSaveState('error'));
  }, [id]);

  const update = useCallback((newChar) => {
    setChar(newChar);
    pendingChar.current = newChar;
    setSaveState('saving');
    clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(flush, AUTOSAVE_DELAY_MS);
  }, [flush]);

  useEffect(() => {
    return () => { clearTimeout(autosaveTimer.current); flush(); };
  }, [flush]);

  // ── Render states ──────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="sheet-loading-screen">
        <p>Loading character…</p>
      </div>
    );
  }

  if (error) {
    // Tailor the message to the failure. A 401/403 means the character exists
    // but isn't visible to us (not the owner, not an admin, not a GM of its
    // campaign) — that's a permission story, not a "missing bundle" one.
    const status = error.status;
    let heading = 'Error loading character';
    let detail  = error.message || 'Something went wrong loading this character.';
    if (status === 401 || status === 403) {
      heading = 'No access';
      detail  = "You don't have permission to view this character — it may belong to another player.";
    } else if (status === 404) {
      heading = 'Character not found';
      detail  = 'This character no longer exists.';
    }
    return (
      <div className="sheet-error-screen">
        <h2>{heading}</h2>
        <p>{detail}</p>
        <button onClick={() => navigate('/characters')}>← Back to Characters</button>
      </div>
    );
  }

  // Reached only when we successfully loaded a character WE can see, but its
  // sheet bundle isn't installed/enabled on this server. This is the genuine
  // "drop the bundle into /bundles" case — no longer reachable by a 403.
  if (!bundle && char) {
    return (
      <div className="sheet-not-found-screen">
        <div className="not-found-box">
          <h2>SHEET NOT FOUND</h2>
          <p>This character requires:</p>
          <p className="not-found-name">"{char.sheetName ?? 'Unknown Sheet'}"</p>
          <p className="not-found-id">ID: {char.sheetId ?? 'unknown'}</p>
          <p className="not-found-instructions">
            Drop the sheet bundle into <code>/bundles/</code> and refresh sheets in the admin panel.
          </p>
          <p className="not-found-assurance">The character data is intact and unaffected.</p>
          <div className="not-found-actions">
            <button onClick={() => {
              const blob = new Blob([JSON.stringify(char, null, 2)], { type: 'application/json' });
              window.open(URL.createObjectURL(blob));
            }}>View Raw JSON</button>
            <button onClick={() => navigate('/characters')}>← Back to Characters</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="character-sheet-wrapper">

      {/* Top bar: back nav + name + share + save indicator */}
      <div style={{
        display:      'flex',
        alignItems:   'center',
        justifyContent: 'space-between',
        flexWrap:     'wrap',
        gap:          '0.5rem',
        rowGap:       isMobile ? '0.4rem' : '0.5rem',
        padding:      '0.5rem 1rem',
        borderBottom: '1px solid var(--border)',
        background:   'var(--bg-surface)',
        position:     'sticky',
        top:          0,
        zIndex:       100,
      }}>
        {/* Left column — fixed width, never shrinks */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: '0 0 auto', order: 1 }}>
          <button className="btn-ghost" onClick={() => navigate('/characters')}
            style={{ fontSize: '0.75rem', padding: '0.2rem 0.6rem' }}>
            ← Back
          </button>
          {/* Toggles the dice drawer. Hidden if the bundle opts out of dice
              (schema.dice.enabled === false). */}
          {diceAvailable && (
            <button className="btn-ghost" onClick={() => setDiceOpen((o) => !o)}
              title="Dice tray" aria-label="Dice tray"
              style={{ padding: '0.2rem 0.2rem', lineHeight: 0,
                display: 'inline-flex', alignItems: 'center' }}>
              <DiceIcon size={17} />
            </button>
          )}
        </div>

        {/* Center — desktop: grows in the middle (basis 0) and truncates.
            Mobile: full-width (basis 100%) on its own row BELOW the buttons via
            order, so the name + campaign aren't crammed against the controls. */}
        <div style={{
          flex: isMobile ? '1 1 100%' : '1 1 0%',
          order: isMobile ? 3 : 2,
          minWidth: 0,
          textAlign: 'center',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          fontFamily: 'var(--font-display)',
          fontSize: '0.95rem',
          color: 'var(--text-accent)',
          letterSpacing: '0.04em',
        }}>
          {char.info?.name || 'Unnamed Character'}
          {char.campaignName?.trim() && (
            <>
              <SwordsIcon size={14} style={{ verticalAlign: 'middle', margin: '0 0.35rem' }} />
              {char.campaignName}
            </>
          )}
        </div>

        {/* Right column — fixed width, never shrinks. On mobile it stays on the
            top row (order 2) opposite the buttons; the name drops below. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: '0 0 auto',
          order: isMobile ? 2 : 3 }}>
          {/* Files panel — opposite the dice/log on the left, so an attachment is
              reachable mid-session without leaving the sheet. Gated on the admin
              setting, same as the dice button is gated on the bundle. */}
          {attachmentsAllowed && (
            <button className="btn-ghost" onClick={() => setFilesOpen(true)}
              title="Files" aria-label="Files"
              style={{ padding: '0.2rem 0.2rem', lineHeight: 0,
                display: 'inline-flex', alignItems: 'center' }}>
              <FileIcon size={17} />
            </button>
          )}
          <div className={`save-indicator save-${saveState}`} style={{ position: 'static' }}>
            {saveState === 'saving' && '● Saving…'}
            {saveState === 'saved'  && '✓ Saved'}
            {saveState === 'error'  && '✗ Save failed'}
          </div>
        </div>
      </div>

      <SheetRenderer char={char} update={update} charId={id} />

      {/* Dice overlay + drawer. Click-through canvas sits above the sheet; the
          rail shows when open. Reports availability so the 🎲 can hide for
          diceless bundles. Every completed roll is logged server-side and
          reported back up via onRollLogged, which keeps `rolls` (and the log
          panel) current without RollLog needing to fetch on its own.

          ref={diceRef} wires forwardRef so the command bar in RollLog can call
          diceRef.current.rollFromNotation(notationStr). onLogOpen moves the
          log toggle into the tray rail itself. */}
      <DiceTray
        ref={diceRef}
        open={diceOpen}
        onClose={() => setDiceOpen(false)}
        sheetId={char.sheetId}
        characterId={id}
        diceScale={user?.diceScale ?? 3}   // ← add this
        onAvailabilityChange={setDiceAvailable}
        onRollLogged={setRolls}
        onLogOpen={() => setLogOpen(true)}
      />

      <RollLog
        open={logOpen}
        onClose={() => setLogOpen(false)}
        rolls={rolls}
        onRollCommand={
          diceAvailable
            ? (notation) => diceRef.current?.rollFromNotation(notation)
            : undefined
        }
      />

      {filesOpen && (
        <FilesModal
          characterId={id}
          characterName={char.info?.name}
          onClose={() => setFilesOpen(false)}
        />
      )}
    </div>
  );
}
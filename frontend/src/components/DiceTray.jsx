/**
 * DiceTray.jsx  —  PHASE 2
 *
 * The dice drawer + physics overlay.
 *
 *   - 🎲 in the header toggles `open`.
 *   - Tapping a die adds it to a POOL (tap d6 ×3 → 3d6). A modifier stepper and
 *     a Roll button finish the throw; Clear resets.
 *   - Dice tumble on a fixed, click-through canvas; a floating card shows the
 *     per-die breakdown + total, then auto-dismisses.
 *   - The die set comes from the bundle's schema.dice.available, defaulting to
 *     the standard polyhedral set. A bundle may opt out entirely with
 *     schema.dice.enabled === false (the host hides the 🎲 in that case).
 *
 * Not here yet (Phase 3): the per-character roll log + its sidecar endpoints.
 */

import React, { useEffect, useRef, useState, useCallback, useImperativeHandle, forwardRef } from 'react';
import { createPortal } from 'react-dom';
import DiceBox from '@3d-dice/dice-box';
import { DIE_ICONS } from './shared/DiceFaces';
import { LogIcon, ClearDiceIcon } from './shared/Icons';
import { parseNotation, evaluateGroup, parseMultiRoll } from './diceParser';

const ASSET_PATH   = '/assets/dice-box/';
const DEFAULT_DICE = ['d4', 'd6', 'd8', 'd10', 'd12', 'd20', 'd100'];

// Responsive die size. dice-box's apparent die size depends on canvas size and
// `scale` together — a bigger canvas spreads the same scale smaller — so we grow
// scale with the screen's short side.
//
// Size also controls EDGE CLEARANCE: dice collide with invisible walls at the
// canvas edges, and a large die resting against a wall pokes past the camera's
// view and clips. Smaller dice settle in-frame even at the edges. So the floor
// is deliberately low (phones get smaller dice with room to spare) while large
// screens still get big, readable dice. SCALE_DIVISOR is the knob to tune
// (smaller = bigger dice); a future per-user preference will multiply on top.
const SCALE_DIVISOR = 120;
const SCALE_MIN = 5;
const SCALE_MAX = 14;
const USER_SCALE_MULT = { 1: 0.55, 2: 0.75, 3: 1.0, 4: 1.35, 5: 1.7 };
function computeScale(userPref = 3) {
  const short = Math.min(window.innerWidth, window.innerHeight);
  const base  = Math.max(SCALE_MIN, Math.min(SCALE_MAX, Math.round(short / SCALE_DIVISOR)));
  const mult  = USER_SCALE_MULT[userPref] ?? 1.0;
  return Math.max(SCALE_MIN, Math.min(SCALE_MAX, Math.round(base * mult)));
}

// How long settled dice stay on screen before they fade away on their own.
// Tune to taste (set to 0 to disable auto-removal). A future per-user/admin
// preference can override this.
const DICE_AUTOREMOVE_MS = 30000;
// Fade-out duration when dice are removed (close / Clear / auto-timeout).
const FADE_MS = 600;
// Fallback dice tint if the theme accent can't be read.
const DEFAULT_DICE_COLOR = '#b1402f';

// Dice follow the USER's selected app theme, not the bundle. applyTheme() writes
// the chosen preset's accent onto :root as --accent (Tavern gold, Arcane purple,
// Ember orange, …); read that live so the dice match the chrome the user picked.
function getThemeColor() {
  if (typeof document === 'undefined') return DEFAULT_DICE_COLOR;
  const v = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  return v || DEFAULT_DICE_COLOR;
}

const DiceTray = forwardRef(function DiceTray(
  { open, onClose, sheetId, characterId, diceScale = 3, onAvailabilityChange, onRollLogged, onLogOpen },
  ref
) {
  const boxRef    = useRef(null);              // live DiceBox instance
  const scaleRef  = useRef(computeScale(diceScale));    // current scale (avoids re-render churn)
  const colorRef  = useRef(getThemeColor()); // current dice tint (user theme --accent)
  const removeRef = useRef(null);              // auto-remove timer handle

  const [availableDice, setAvailableDice] = useState(DEFAULT_DICE);
  const [pool,          setPool]          = useState({});   // { d6: 3, d20: 1 }
  const [modifier,      setModifier]      = useState(0);
  const [rolling,       setRolling]       = useState(false);
  const [result,        setResult]        = useState(null); // { groups, modifier, total }

  // ── Init the physics box ───────────────────────────────────────────────────
  const initBox = useCallback((scale) => {
    const mount = document.getElementById('dice-box');
    if (!mount) return;
    mount.innerHTML = '';                     // clean any prior canvas
    colorRef.current = getThemeColor();       // match the user's current theme
    const box = new DiceBox('#dice-box', {
      assetPath: ASSET_PATH,
      theme: 'default',
      themeColor: colorRef.current,   // dice tint = user theme accent (--accent)
      scale,
    });

    // dice-box builds its physics world from the CANVAS's clientWidth/clientHeight
    // (verified in the 1.1.4 source), and the canvas it creates has no CSS size —
    // so it sits at the <canvas> default of 300×150 and pens the dice into a
    // corner. The canvas is created synchronously in the constructor and exposed
    // as box.canvas, so size it to fill the (full-screen) container BEFORE init()
    // reads it.
    if (box.canvas) {
      box.canvas.style.width   = '100%';
      box.canvas.style.height  = '100%';
      box.canvas.style.display = 'block';
    }

    box.init()
      .then(() => {
        boxRef.current = box;
        // init() registers a window-resize listener (resizeWorld) that re-reads
        // the canvas size. Nudge it once layout has settled, as insurance.
        requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
        setTimeout(() => window.dispatchEvent(new Event('resize')), 300);
      })
      .catch((e) => console.error('[dice] init failed:', e));
  }, []);

  // ── Init the physics box on mount and whenever the user's dice-size
  // preference changes. Previously this was two separate effects (one
  // mount-only, one for diceScale) which both fired on mount and raced —
  // the loser's canvas would get yanked from the DOM mid-init but its
  // box.init() promise would still resolve and clobber boxRef.current,
  // leaving us holding an orphan DiceBox whose canvas no longer exists.
  // One effect, one init.
  useEffect(() => {
    const next = computeScale(diceScale);
    scaleRef.current = next;
    boxRef.current = null;
    initBox(next);
    return () => {
      boxRef.current = null;
      if (removeRef.current) { clearTimeout(removeRef.current); removeRef.current = null; }
      const mount = document.getElementById('dice-box');
      if (mount) mount.innerHTML = '';
    };
  }, [diceScale, initBox]);

  // ── Re-scale (and re-init) on resize / rotation, debounced ─────────────────
  useEffect(() => {
    let t;
    const onResize = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        // If a roll is currently animating, skip this re-init. iOS keyboard
        // pop-ups fire `resize` and a mid-roll re-init nukes boxRef, causing
        // the in-flight box.roll() to resolve with no values (total = 0). The
        // next resize after the roll finishes will pick up the new scale.
        if (rolling) return;
        const next = computeScale(diceScale);
        if (next === scaleRef.current) return;
        scaleRef.current = next;
        boxRef.current = null;
        initBox(next);
      }, 250);
    };
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('resize', onResize); clearTimeout(t); };
  }, [initBox, diceScale, rolling]);

  // ── Read the bundle's dice config (default to the standard set) ────────────
  useEffect(() => {
    if (!sheetId) return undefined;
    let cancelled = false;
    fetch(`/api/sheets/${sheetId}/schema`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((schema) => {
        if (cancelled || !schema) return;
        const cfg = schema.dice;
        if (cfg?.enabled === false) {
          onAvailabilityChange?.(false);      // host hides the 🎲
          return;
        }
        onAvailabilityChange?.(true);
        setAvailableDice(cfg?.available?.length ? cfg.available : DEFAULT_DICE);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [sheetId, onAvailabilityChange]);

  // ── Escape closes the drawer ───────────────────────────────────────────────
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // ── Remove dice with a fade (used by close, Clear, and auto-timeout) ───────
  // dice-box's clear() is instant; to fade, we transition the canvas opacity to
  // 0, then clear and reset opacity so the next throw shows immediately.
  const fadeAndClear = useCallback(() => {
    if (removeRef.current) { clearTimeout(removeRef.current); removeRef.current = null; }
    const mount = document.getElementById('dice-box');
    if (!mount) { boxRef.current?.clear(); return; }
    mount.style.transition = `opacity ${FADE_MS}ms ease`;
    mount.style.opacity = '0';
    window.setTimeout(() => {
      boxRef.current?.clear();
      mount.style.transition = 'none';
      mount.style.opacity = '1';
    }, FADE_MS);
  }, []);

  // ── Clear the table when the drawer closes ─────────────────────────────────
  useEffect(() => {
    if (open) return;
    fadeAndClear();
    setResult(null);
  }, [open, fadeAndClear]);

  // ── Auto-dismiss the floating result ───────────────────────────────────────
  useEffect(() => {
    if (!result) return undefined;
    const t = setTimeout(() => setResult(null), 5000);
    return () => clearTimeout(t);
  }, [result]);

  // ── Pool helpers ───────────────────────────────────────────────────────────
  const addDie    = (d) => setPool((p) => ({ ...p, [d]: (p[d] || 0) + 1 }));
  const clearPool = () => { setPool({}); setModifier(0); setResult(null); fadeAndClear(); };
  const poolCount = Object.values(pool).reduce((a, b) => a + b, 0);

  // Human-readable assembly, e.g. "3d6 + 1d20 + 2"
  const notationLabel = [
    ...Object.entries(pool).map(([d, n]) => `${n}${d}`),
    modifier ? (modifier > 0 ? `+${modifier}` : `${modifier}`) : null,
  ].filter(Boolean).join(' + ');

  // ── Persist the roll to the per-character log (fire-and-forget) ───────────
  // A direct fetch with credentials, not the api.js wrapper — DiceTray has no
  // api.js import today and this keeps the file's own existing convention
  // (see the schema fetch above) rather than introducing a second one.
  const logRoll = useCallback((groups, mod, total, label) => {
    if (!characterId) return;
    fetch(`/api/characters/${characterId}/rolls`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dice: groups, modifier: mod, total, source: label || '' }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((rolls) => { if (rolls) onRollLogged?.(rolls); })
      .catch((e) => console.error('[dice] roll log failed:', e));
  }, [characterId, onRollLogged]);

  // ── Roll ───────────────────────────────────────────────────────────────────
  const roll = useCallback(async () => {
    const box = boxRef.current;
    if (!box || poolCount === 0 || rolling) return;
    setRolling(true);
    setResult(null);
    try {
      // Cancel any pending auto-remove and make the table fully visible (in case
      // a previous fade was mid-flight) before the new throw.
      if (removeRef.current) { clearTimeout(removeRef.current); removeRef.current = null; }
      const mount = document.getElementById('dice-box');
      if (mount) { mount.style.transition = 'none'; mount.style.opacity = '1'; }

      // Keep dice matching the user's current theme — if they switched themes
      // since the last roll, recolor before throwing (updateConfig is live).
      const themeColor = getThemeColor();
      if (themeColor !== colorRef.current) {
        colorRef.current = themeColor;
        try { await box.updateConfig?.({ themeColor }); } catch { /* non-fatal */ }
      }

      box.clear();
      // Pass an array of per-die-type notations — avoids parser edge cases with
      // a single combined "+" string and still returns one flat results array.
      const groupsNotation = Object.entries(pool).map(([d, n]) => `${n}${d}`);
      const rolled = await box.roll(groupsNotation);

      // rolled: array of die results. Group values by die type for display and
      // sum everything; the modifier is applied here in JS (not in the dice-box
      // notation) so we keep full control of the breakdown and total.
      const groups = {};
      let sum = 0;
      for (const r of rolled) {
        const sides = r.sides ?? parseInt(String(r.dieType || '').replace(/\D/g, ''), 10);
        const key   = `d${sides}`;
        (groups[key] = groups[key] || []).push(r.value);
        sum += r.value;
      }
      const total = sum + modifier;
      setResult({ groups, modifier, total });
      logRoll(groups, modifier, total);

      // Auto-remove the dice after the timeout (fades them out).
      if (DICE_AUTOREMOVE_MS > 0) {
        removeRef.current = setTimeout(fadeAndClear, DICE_AUTOREMOVE_MS);
      }
    } catch (e) {
      console.error('[dice] roll failed:', e);
    } finally {
      setRolling(false);
    }
  }, [pool, poolCount, modifier, rolling, fadeAndClear, logRoll]);

  // ── Command-bar roll (notation string) ────────────────────────────────────
  // Called from RollLog via the ref. Parses the notation, sends the base dice
  // pool to the physics engine for visuals, then applies result modifiers
  // (keep/drop, successes, explode, …) in JS via diceParser.evaluateGroup().
  //
  // Supports "/" to roll multiple independent pools: "1d6x/1d8+2" rolls each
  // segment separately and shows both totals in the result card.
  //
  // Falls back to pure-JS values (no animation) when the box isn't ready yet —
  // math and logging still work either way.
  const rollFromNotation = useCallback(async (notationStr) => {
    if (rolling) return { error: 'A roll is already in progress' };

    // Parse — detect single vs multi-roll (/ separator)
    let segments;
    try {
      segments = parseMultiRoll(notationStr);
    } catch (e) {
      return { error: e.message };
    }

    setRolling(true);
    setResult(null);

    try {
      const box = boxRef.current;

      // ── Phase 1: collect all dice across every segment for the engine ────
      // We send one combined roll to the physics engine (all base dice from all
      // segments together) so they all tumble at once visually, then split the
      // results back out by segment.
      //
      // Each segment's groups are flattened into a sequential physics list;
      // we remember the slice sizes so we can reconstruct per-segment raw values.
      const allGroups = segments.flatMap(s => s.parsed.groups);
      let rawByGroupFlat; // [{ sides, values[] }] parallel to allGroups

      if (box) {
        if (removeRef.current) { clearTimeout(removeRef.current); removeRef.current = null; }
        const mount = document.getElementById('dice-box');
        if (mount) { mount.style.transition = 'none'; mount.style.opacity = '1'; }

        const themeColor = getThemeColor();
        if (themeColor !== colorRef.current) {
          colorRef.current = themeColor;
          try { await box.updateConfig?.({ themeColor }); } catch { /* non-fatal */ }
        }

        box.clear();
        const physicsNotation = allGroups.map(g =>
          g.isFudge ? `${g.count}d6` : `${g.count}d${g.sides}`
        );
        const rolled = await box.roll(physicsNotation);

        const remaining = [...rolled];
        rawByGroupFlat = allGroups.map((g) => {
          const slice = remaining.splice(0, g.count);
          if (g.isFudge) {
            return { sides: 'F', values: slice.map(r => Math.floor((r.value - 1) / 2) - 1) };
          }
          return { sides: g.sides, values: slice.map(r => r.value) };
        });

        if (DICE_AUTOREMOVE_MS > 0) {
          removeRef.current = setTimeout(fadeAndClear, DICE_AUTOREMOVE_MS);
        }
      } else {
        // No physics box — generate in JS.
        rawByGroupFlat = allGroups.map(g => ({
          sides:  g.sides,
          values: Array.from({ length: g.count }, () =>
            g.isFudge
              ? Math.floor(Math.random() * 3) - 1
              : Math.floor(Math.random() * g.sides) + 1
          ),
        }));
      }

      // ── Phase 2: apply modifiers per segment ─────────────────────────────
      // Walk rawByGroupFlat in order, consuming entries for each segment.
      // After evaluating, if explode added extra dice we call box.add() so
      // those extra rolls appear on the physics table too.
      let flatIdx = 0;
      const segmentResults = segments.map((seg) => {
        const diceForSeg = {};
        let segTotal = seg.parsed.modifier;

        seg.parsed.groups.forEach((g) => {
          const raw = rawByGroupFlat[flatIdx++];
          const { values, total } = evaluateGroup(raw.values, raw.sides, g.modStr);
          const key = g.isFudge ? 'dF' : `d${g.sides}`;
          if (!diceForSeg[key]) diceForSeg[key] = [];
          diceForSeg[key].push(...values);
          segTotal += total;

          // If evaluateGroup produced more values than we gave it (explode
          // added dice), throw those extra ones on the physics table visually.
          const extraCount = values.length - raw.values.length;
          if (extraCount > 0 && box) {
            const extraNotation = g.isFudge ? `${extraCount}d6` : `${extraCount}d${g.sides}`;
            box.add(extraNotation).catch(() => {/* non-fatal */});
          }
        });

        return { notation: seg.notation, dice: diceForSeg, modifier: seg.parsed.modifier, total: segTotal };
      });

      // For logging: combine all dice into one entry (multi-roll logged as one
      // row with the full notation as source, totals shown in the label).
      const combinedDice = {};
      for (const seg of segmentResults) {
        for (const [k, v] of Object.entries(seg.dice)) {
          if (!combinedDice[k]) combinedDice[k] = [];
          combinedDice[k].push(...v);
        }
      }
      const grandTotal = segmentResults.reduce((a, s) => a + s.total, 0);

      setResult({
        segments:  segmentResults,           // array when multi-roll
        groups:    combinedDice,             // flat dict for single-roll compat
        modifier:  segments.length === 1 ? segments[0].parsed.modifier : 0,
        total:     grandTotal,
        label:     notationStr,
        isMulti:   segments.length > 1,
      });
      logRoll(combinedDice, segments.length === 1 ? segments[0].parsed.modifier : 0, grandTotal, notationStr);

      return { total: grandTotal };
    } catch (e) {
      console.error('[dice] command roll failed:', e);
      return { error: e.message };
    } finally {
      setRolling(false);
    }
  }, [rolling, fadeAndClear, logRoll]);

  // Expose rollFromNotation to CharacterSheet via the forwarded ref.
  // CharacterSheet passes it down to RollLog as onRollCommand.
  useImperativeHandle(ref, () => ({ rollFromNotation }), [rollFromNotation]);

  // ── Styles (inline, app CSS variables to match sheet chrome) ───────────────
  // Rail dimensions are ~10% smaller than the original tray.
  const railStyle = {
    position: 'fixed', left: 12, top: 72, zIndex: 1500,
    display: open ? 'flex' : 'none', flexDirection: 'column', gap: 7,
    width: 83, padding: '9px 7px',
    background: 'var(--bg-surface)', border: '1px solid var(--border)',
    borderRadius: 6, boxShadow: '0 6px 24px rgba(0,0,0,0.45)',
    maxHeight: 'calc(100vh - 88px)', overflowY: 'auto',
  };
  // display:flex + center is what actually centers the die icon AND the −/+
  // glyphs inside their boxes.
  const dieBtnStyle = {
    position: 'relative', height: 40, borderRadius: 6, cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    border: '1px solid var(--border)', background: 'var(--bg-raised, rgba(255,255,255,0.06))',
    color: 'var(--text-primary)', fontFamily: 'var(--font-display)', fontWeight: 700,
    fontSize: '0.75rem', letterSpacing: '0.03em', lineHeight: 1,
  };
  const badgeStyle = {
    position: 'absolute', top: -6, right: -6, minWidth: 18, height: 18, padding: '0 4px',
    borderRadius: 9, background: 'var(--accent, #b48c3c)', color: '#1a1410',
    fontFamily: 'var(--font-mono)', fontSize: '0.62rem', fontWeight: 700,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  };

  // Portal the entire overlay to document.body. .sheet-root sets
  // container-type: inline-size, which makes it a containing block for fixed
  // descendants and (on iOS Safari) lets a fixed WebGL canvas in the same
  // subtree disrupt the sheet's container-query layout. Rendering to body keeps
  // the dice fully outside that context — the same fix InfoButton uses.
  return createPortal(
    <>
      {/* Physics overlay — always mounted, full-screen, click-through. */}
      <div id="dice-box" aria-hidden="true"
        style={{ position: 'fixed', inset: 0, zIndex: 2000, pointerEvents: 'none' }} />

      {/* The drawer rail */}
      <div style={railStyle} role="dialog" aria-label="Dice tray">
        {availableDice.map((d) => {
          const count = pool[d] || 0;
          const Glyph = DIE_ICONS[d];           // icon if we have one for this die
          const num   = String(d).replace(/\D/g, '');
          return (
            <button key={d} type="button" onClick={() => addDie(d)} style={dieBtnStyle}
              title={d} aria-label={d}>
              {Glyph ? <Glyph size={30} /> : num}
              {count > 0 && <span style={badgeStyle}>{count}</span>}
            </button>
          );
        })}

        {/* Modifier stepper */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
          marginTop: 4, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
          <button type="button" onClick={() => setModifier((m) => m - 1)}
            style={{ ...dieBtnStyle, padding: 0, minWidth: 20, height: 20, width: 20, fontSize: '0.75rem' }}>−</button>
          <span style={{ padding: 4, fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: 'var(--text-primary)' }}>
            {modifier >= 0 ? `+${modifier}` : modifier}
          </span>
          <button type="button" onClick={() => setModifier((m) => m + 1)}
            style={{ ...dieBtnStyle, padding: 0, minWidth: 20, height: 20, width: 20, fontSize: '0.75rem' }}>+</button>
        </div>

        {/* Assembled notation */}
        <div style={{ minHeight: 16, fontFamily: 'var(--font-mono)', fontSize: '0.62rem',
          color: 'var(--text-dim)', textAlign: 'center', wordBreak: 'break-word' }}>
          {notationLabel || '—'}
        </div>

        {/* Roll + Clear/Log row */}
        <button type="button" onClick={roll} disabled={poolCount === 0 || rolling}
          style={{ height: 36, borderRadius: 6, cursor: poolCount === 0 ? 'default' : 'pointer',
            border: '1px solid var(--accent, #b48c3c)',
            background: poolCount === 0 ? 'transparent' : 'var(--accent-glow, rgba(180,140,60,0.18))',
            color: 'var(--text-accent)', fontFamily: 'var(--font-display)', fontWeight: 700,
            opacity: poolCount === 0 ? 0.45 : 1, letterSpacing: '0.05em' }}>
          {rolling ? '…' : 'Roll'}
        </button>

        {/* Bottom utility row: clear dice | open log.
            Ghost-styled (no box) so they read as secondary controls — the boxed
            look would compete with the die buttons above. */}
        <div style={{ display: 'flex', gap: 6, marginTop: 2, justifyContent: 'space-around' }}>
          <button type="button" onClick={clearPool} title="Clear dice"
            aria-label="Clear dice"
            style={{ background: 'none', border: 'none', cursor: 'pointer',
              padding: 4, color: 'var(--text-dim)',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
            <ClearDiceIcon size={20} />
          </button>
          <button type="button" onClick={onLogOpen} title="Roll log"
            aria-label="Roll log"
            style={{ background: 'none', border: 'none', cursor: 'pointer',
              padding: 4, color: 'var(--text-dim)',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
            <LogIcon size={20} />
          </button>
        </div>
      </div>

      {/* Floating result — near where the dice land (screen centre). */}
      {result && (
        <div onClick={() => setResult(null)}
          style={{ position: 'fixed', left: '50%', top: '42%', transform: 'translate(-50%, -50%)',
            zIndex: 2100, pointerEvents: 'auto', cursor: 'pointer',
            background: 'var(--bg-surface)', border: '1px solid var(--accent, #b48c3c)',
            borderRadius: 8, padding: '12px 18px', minWidth: 140, textAlign: 'center',
            boxShadow: '0 10px 40px rgba(0,0,0,0.5)' }}>
          {/* Notation label — shown for command-bar rolls */}
          {result.label && (
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.65rem',
              color: 'var(--text-dim)', marginBottom: 6, letterSpacing: '0.05em' }}>
              {result.label}
            </div>
          )}

          {result.isMulti ? (
            /* Multi-roll: show each segment's notation + dice + total separately */
            <div style={{ display: 'flex', gap: 0, alignItems: 'stretch', justifyContent: 'center' }}>
              {result.segments.map((seg, i) => (
                <div key={i} style={{
                  minWidth: 60, padding: '0 12px',
                  borderRight: i < result.segments.length - 1 ? '1px solid var(--border)' : 'none',
                }}>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.6rem',
                    color: 'var(--text-dim)', marginBottom: 2 }}>
                    {seg.notation}
                  </div>
                  {Object.entries(seg.dice)
                    .sort((a, b) => parseInt(a[0].slice(1), 10) - parseInt(b[0].slice(1), 10))
                    .map(([die, vals]) => (
                      <div key={die} style={{ fontFamily: 'var(--font-mono)', fontSize: '0.68rem',
                        color: 'var(--text-dim)' }}>
                        {die}: {vals.join(', ')}
                      </div>
                    ))}
                  {seg.modifier !== 0 && (
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.68rem', color: 'var(--text-dim)' }}>
                      mod {seg.modifier > 0 ? `+${seg.modifier}` : seg.modifier}
                    </div>
                  )}
                  <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700,
                    fontSize: '1.6rem', color: 'var(--text-accent)', lineHeight: 1, marginTop: 2 }}>
                    {seg.total}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            /* Single roll: original layout */
            <>
              {Object.entries(result.groups)
                .sort((a, b) => parseInt(a[0].slice(1), 10) - parseInt(b[0].slice(1), 10))
                .map(([die, vals]) => (
                  <div key={die} style={{ fontFamily: 'var(--font-mono)', fontSize: '0.72rem',
                    color: 'var(--text-dim)' }}>
                    {die}: {vals.join(', ')}
                  </div>
                ))}
              {result.modifier !== 0 && (
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.72rem', color: 'var(--text-dim)' }}>
                  mod {result.modifier > 0 ? `+${result.modifier}` : result.modifier}
                </div>
              )}
              <div style={{ marginTop: 4, fontFamily: 'var(--font-display)', fontWeight: 700,
                fontSize: '1.8rem', color: 'var(--text-accent)', lineHeight: 1 }}>
                {result.total}
              </div>
            </>
          )}
        </div>
      )}
    </>,
    document.body
  );
});

export default DiceTray;

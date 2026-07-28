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
import { LogIcon, ClearDiceIcon, PencilIcon, PlusIcon, ChevronLeftIcon } from './shared/Icons';
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

// ── Macro pages ────────────────────────────────────────────────────────────
// The tray is a fixed-width rail (see railStyle) and must STAY that size, so
// macros are laid out one-per-row in the same column the dice occupy — no new
// columns, no wider tray, no popout.
//
// SLOTS_PER_PAGE is how many slots a page shows while EDITING. It is not a
// per-page quota: a page stores only the macros actually filled in, so page 1
// can hold 2 and page 2 can hold 3. Outside edit mode a page renders only its
// filled macros, so a half-used page is short rather than padded with dead
// boxes. These ceilings mirror the server's (MACROS_PER_PAGE_MAX /
// MACRO_PAGES_MAX in server.js) — keep the pairs in step.
const SLOTS_PER_PAGE   = 6;
const MACRO_PAGES_MAX  = 10;
const MACRO_NAME_MAX   = 40;

// Client-side id for React keys only — the server re-mints anything that isn't
// a plain token, so this is never security-bearing.
function macroId() {
  return Math.random().toString(36).slice(2, 10);
}

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

  // ── Macro page state ───────────────────────────────────────────────────────
  // `page` is the tray's pager position: 0 is the dice page (the original
  // tray), 1..n are macro pages. macroPages always holds at least one page so
  // the pager has somewhere to go and a brand-new character can author a macro
  // without first having to create a page.
  const [macroPages, setMacroPages] = useState([{ macros: [] }]);
  const [page,       setPage]       = useState(0);
  const [editing,    setEditing]    = useState(false);
  // The macro editor popup: { pageIdx, macroIdx (null = new slot), name, notation, error }
  const [editor,     setEditor]     = useState(null);

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

  // ── Load this character's macro pages ──────────────────────────────────────
  // Raw fetch with credentials, matching this file's existing convention (the
  // schema fetch above and logRoll below) rather than introducing an api.js
  // import for one more call. The global fetch interceptor in index.js attaches
  // the CSRF token, so the PUT in saveMacros is covered too.
  useEffect(() => {
    if (!characterId) return undefined;
    let cancelled = false;
    fetch(`/api/characters/${characterId}/macros`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((pages) => {
        if (cancelled || !Array.isArray(pages)) return;
        // Never drop below one page — an empty array from a character that has
        // never saved macros would otherwise leave the pager with nothing to
        // show and no way to add the first page.
        setMacroPages(pages.length ? pages : [{ macros: [] }]);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [characterId]);

  // Whole-tree save. Optimistic: state is already updated by the caller, so a
  // failed write only costs the last edit (and logs) rather than reverting the
  // UI under the user's hands mid-edit.
  const saveMacros = useCallback((pages) => {
    if (!characterId) return;
    fetch(`/api/characters/${characterId}/macros`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pages }),
    }).catch((e) => console.error('[dice] macro save failed:', e));
  }, [characterId]);

  // Single mutation path for the macro tree: apply, then persist. Every caller
  // (add / edit / delete / page add / page remove) goes through this so no code
  // path can change macros in state and forget to write them.
  const commitMacros = useCallback((next) => {
    setMacroPages(next);
    saveMacros(next);
  }, [saveMacros]);

  // ── Escape closes the drawer ───────────────────────────────────────────────
  useEffect(() => {
    if (!open) return undefined;
    // With the macro editor popup open, Escape dismisses the popup rather than
    // the whole tray — closing the tray out from under an open dialog would
    // discard an in-progress edit with no way to get back to it.
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (editor) setEditor(null);
      else onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, editor]);

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
  //
  // `segments` is included only for multi-roll command-bar rolls so RollLog can
  // render per-segment totals; single rolls omit it for a leaner sidecar file.
  const logRoll = useCallback((groups, mod, total, label, segments) => {
    if (!characterId) return;
    const body = { dice: groups, modifier: mod, total, source: label || '' };
    if (segments && segments.length > 1) body.segments = segments;
    fetch(`/api/characters/${characterId}/rolls`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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
  // `sourceLabel` is optional and used only by macro buttons: the roll log then
  // reads "Sword Attack" instead of "2d6+3", which is the whole point of naming
  // a macro. The notation is still shown on the result card beside the name, so
  // nothing is hidden — you can always see what a macro actually rolled.
  const rollFromNotation = useCallback(async (notationStr, sourceLabel) => {
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
        label:     sourceLabel ? `${sourceLabel} · ${notationStr}` : notationStr,
        isMulti:   segments.length > 1,
      });
      logRoll(
        combinedDice,
        segments.length === 1 ? segments[0].parsed.modifier : 0,
        grandTotal,
        sourceLabel || notationStr,
        // Pass segment data for multi-rolls so the log can show per-segment
        // totals; logRoll itself drops this when segments.length <= 1.
        segmentResults,
      );

      return { total: grandTotal };
    } catch (e) {
      console.error('[dice] command roll failed:', e);
      return { error: e.message };
    } finally {
      setRolling(false);
    }
  }, [rolling, fadeAndClear, logRoll]);

  // ── Macro actions ──────────────────────────────────────────────────────────
  const macroPageIdx = page - 1;                 // page 0 is the dice page
  const onMacroPage  = page > 0;
  const currentPage  = macroPages[macroPageIdx] || { macros: [] };
  const totalPages   = macroPages.length + 1;    // dice page + macro pages

  // Clamp the pager if pages disappear (e.g. the last page is deleted, or a
  // reload returns fewer pages than the one we were sitting on).
  useEffect(() => {
    setPage((p) => Math.min(p, macroPages.length));
  }, [macroPages.length]);

  // Leaving a macro page drops edit mode: edit is a per-visit posture, and
  // returning to a page later expecting it to be "live" and getting an editor
  // instead is how you accidentally rewrite a macro you meant to roll.
  const goToPage = (next) => {
    setPage(next);
    setEditing(false);
    setEditor(null);
  };

  const saveEditor = () => {
    if (!editor) return;
    const name     = editor.name.trim().slice(0, MACRO_NAME_MAX);
    const notation = editor.notation.trim();
    if (!notation) { setEditor({ ...editor, error: 'Enter a roll notation' }); return; }
    // Validate through the SAME parser the roll uses, so a macro that saves is a
    // macro that rolls — catching it here beats a button that silently does
    // nothing at the table.
    try {
      parseMultiRoll(notation);
    } catch (e) {
      setEditor({ ...editor, error: e.message });
      return;
    }
    const next = macroPages.map((pg, i) => {
      if (i !== editor.pageIdx) return pg;
      const macros = [...pg.macros];
      if (editor.macroIdx === null) macros.push({ id: macroId(), name: name || notation, notation });
      else macros[editor.macroIdx] = { ...macros[editor.macroIdx], name: name || notation, notation };
      return { ...pg, macros };
    });
    commitMacros(next);
    setEditor(null);
  };

  const deleteMacro = () => {
    if (!editor || editor.macroIdx === null) return;
    const next = macroPages.map((pg, i) => (
      i === editor.pageIdx
        ? { ...pg, macros: pg.macros.filter((_, j) => j !== editor.macroIdx) }
        : pg
    ));
    commitMacros(next);
    setEditor(null);
  };

  const addPage = () => {
    if (macroPages.length >= MACRO_PAGES_MAX) return;
    commitMacros([...macroPages, { macros: [] }]);
    setPage(macroPages.length + 1);              // land on the page just created
  };

  // Only an EMPTY page can be removed — deleting a page full of macros from a
  // 20px button with no undo is a footgun; empty the page first.
  const removePage = () => {
    if (macroPages.length <= 1 || currentPage.macros.length) return;
    commitMacros(macroPages.filter((_, i) => i !== macroPageIdx));
    setPage(Math.max(1, page - 1));
  };

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

  // Pager / small utility button — deliberately smaller than a die button so
  // the chrome never competes with the content.
  const pagerBtnStyle = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 20, height: 20, padding: 0, borderRadius: 4, cursor: 'pointer',
    border: '1px solid var(--border)', background: 'transparent',
    color: 'var(--text-dim)', lineHeight: 1,
  };
  // Macro buttons are full-rail-width and single-row: the rail's width is fixed
  // (requirement — the tray must not grow in any direction), so a long name is
  // clipped with an ellipsis and the full text lives in `title`.
  const macroBtnStyle = (isEditing) => ({
    height: 32, borderRadius: 6, cursor: 'pointer', padding: '0 5px',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    border: `1px solid ${isEditing ? 'var(--accent, #b48c3c)' : 'var(--border)'}`,
    background: 'var(--bg-raised, rgba(255,255,255,0.06))',
    color: 'var(--text-primary)', fontFamily: 'var(--font-display)',
    fontWeight: 700, fontSize: '0.62rem', letterSpacing: '0.02em', lineHeight: 1,
    overflow: 'hidden',
  });
  const macroLabelStyle = {
    display: 'block', width: '100%', textAlign: 'center',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  };
  const macroInputStyle = {
    width: '100%', boxSizing: 'border-box', padding: '7px 9px',
    borderRadius: 'var(--radius, 4px)', border: '1px solid var(--border)',
    background: 'var(--bg-input, var(--bg-raised))', color: 'var(--text-primary)',
    fontFamily: 'var(--font-mono)', fontSize: '0.8rem',
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

        {/* Pager — page 0 is the dice page, 1..n are macro pages. Always
            rendered so the macro pages are discoverable; the chevrons wrap
            around so you can reach either end from either direction in a rail
            this narrow. */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 2, paddingBottom: 6, borderBottom: '1px solid var(--border)' }}>
          <button type="button" onClick={() => goToPage((page - 1 + totalPages) % totalPages)}
            title="Previous page" aria-label="Previous page" style={pagerBtnStyle}>
            <ChevronLeftIcon size={14} />
          </button>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.6rem',
            color: 'var(--text-dim)', letterSpacing: '0.04em' }}>
            {page === 0 ? 'DICE' : `M${page}/${macroPages.length}`}
          </span>
          <button type="button" onClick={() => goToPage((page + 1) % totalPages)}
            title="Next page" aria-label="Next page" style={pagerBtnStyle}>
            <ChevronLeftIcon size={14} style={{ transform: 'rotate(180deg)' }} />
          </button>
        </div>

        {/* ── Macro page ─────────────────────────────────────────────────── */}
        {onMacroPage ? (
          <>
            {currentPage.macros.map((m, i) => (
              <button key={m.id || i} type="button"
                onClick={() => (editing
                  ? setEditor({ pageIdx: macroPageIdx, macroIdx: i, name: m.name, notation: m.notation, error: '' })
                  : rollFromNotation(m.notation, m.name))}
                disabled={!editing && rolling}
                /* title carries the full name + notation: the rail is too
                   narrow to show a long name, so hover/long-press is how you
                   confirm what a truncated button actually rolls. */
                title={`${m.name} — ${m.notation}${editing ? ' (click to edit)' : ''}`}
                style={macroBtnStyle(editing)}>
                <span style={macroLabelStyle}>{m.name}</span>
              </button>
            ))}

            {/* Empty slots — edit mode only. Outside edit mode a half-filled
                page renders short rather than padded with dead boxes. */}
            {editing && Array.from({ length: Math.max(0, SLOTS_PER_PAGE - currentPage.macros.length) }, (_, i) => (
              <button key={`empty-${i}`} type="button"
                onClick={() => setEditor({ pageIdx: macroPageIdx, macroIdx: null, name: '', notation: '', error: '' })}
                title="Add a macro" aria-label="Add a macro"
                style={{ ...macroBtnStyle(true), borderStyle: 'dashed', color: 'var(--text-dim)' }}>
                <PlusIcon size={12} />
              </button>
            ))}

            {!editing && currentPage.macros.length === 0 && (
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.58rem',
                color: 'var(--text-dim)', textAlign: 'center', padding: '8px 0', lineHeight: 1.4 }}>
                No macros — tap ✎
              </div>
            )}

            {/* Page add/remove, edit mode only */}
            {editing && (
              <div style={{ display: 'flex', gap: 4, justifyContent: 'center' }}>
                <button type="button" onClick={addPage} title="Add a macro page"
                  disabled={macroPages.length >= MACRO_PAGES_MAX}
                  style={{ ...pagerBtnStyle, opacity: macroPages.length >= MACRO_PAGES_MAX ? 0.4 : 1 }}>
                  <PlusIcon size={12} />
                </button>
                <button type="button" onClick={removePage}
                  title={currentPage.macros.length ? 'Empty this page first' : 'Remove this page'}
                  disabled={macroPages.length <= 1 || currentPage.macros.length > 0}
                  style={{ ...pagerBtnStyle, fontSize: '0.8rem',
                    opacity: (macroPages.length <= 1 || currentPage.macros.length) ? 0.4 : 1 }}>−</button>
              </div>
            )}

            {/* Edit toggle, at the bottom of the macro page */}
            <button type="button" onClick={() => { setEditing(e => !e); setEditor(null); }}
              title={editing ? 'Done editing' : 'Edit macros'}
              aria-pressed={editing}
              style={{ height: 30, borderRadius: 6, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                border: `1px solid ${editing ? 'var(--accent, #b48c3c)' : 'var(--border)'}`,
                background: editing ? 'var(--accent-glow, rgba(180,140,60,0.18))' : 'transparent',
                color: editing ? 'var(--text-accent)' : 'var(--text-dim)',
                fontFamily: 'var(--font-mono)', fontSize: '0.58rem', letterSpacing: '0.05em' }}>
              <PencilIcon size={12} />{editing ? 'DONE' : 'EDIT'}
            </button>
          </>
        ) : (
        <>
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
        </>
        )}

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

      {/* Macro editor popup. A centred overlay, NOT an inline panel — the rail
          is 83px wide and must not grow, so the name/notation form lives above
          it rather than inside it. */}
      {editor && (
        <div onClick={() => setEditor(null)}
          style={{ position: 'fixed', inset: 0, zIndex: 2200,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(0,0,0,0.55)', padding: 16 }}>
          <div onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Edit macro"
            style={{ width: '100%', maxWidth: 320, background: 'var(--bg-surface)',
              border: '1px solid var(--border)', borderRadius: 8, padding: 16,
              boxShadow: '0 10px 40px rgba(0,0,0,0.5)',
              display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.62rem',
              color: 'var(--text-dim)', letterSpacing: '0.08em' }}>
              {editor.macroIdx === null ? 'NEW MACRO' : 'EDIT MACRO'}
            </div>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 4,
              fontFamily: 'var(--font-mono)', fontSize: '0.6rem', color: 'var(--text-dim)' }}>
              NAME
              <input autoFocus value={editor.name} maxLength={MACRO_NAME_MAX}
                onChange={(e) => setEditor({ ...editor, name: e.target.value })}
                placeholder="Sword Attack" style={macroInputStyle} />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 4,
              fontFamily: 'var(--font-mono)', fontSize: '0.6rem', color: 'var(--text-dim)' }}>
              ROLL NOTATION
              <input value={editor.notation}
                onChange={(e) => setEditor({ ...editor, notation: e.target.value, error: '' })}
                onKeyDown={(e) => { if (e.key === 'Enter') saveEditor(); }}
                placeholder="2d6+3" style={macroInputStyle} />
            </label>

            {editor.error && (
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.62rem',
                color: 'var(--danger, #c0554a)' }}>
                {editor.error}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 2 }}>
              {editor.macroIdx !== null && (
                <button type="button" onClick={deleteMacro}
                  style={{ marginRight: 'auto', padding: '7px 12px', borderRadius: 'var(--radius, 4px)',
                    cursor: 'pointer', border: '1px solid var(--danger, #c0554a)',
                    background: 'transparent', color: 'var(--danger, #c0554a)',
                    fontFamily: 'var(--font-mono)', fontSize: '0.65rem' }}>
                  Delete
                </button>
              )}
              <button type="button" onClick={() => setEditor(null)}
                style={{ padding: '7px 12px', borderRadius: 'var(--radius, 4px)', cursor: 'pointer',
                  border: '1px solid var(--border)', background: 'transparent',
                  color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', fontSize: '0.65rem' }}>
                Cancel
              </button>
              <button type="button" onClick={saveEditor}
                style={{ padding: '7px 14px', borderRadius: 'var(--radius, 4px)', cursor: 'pointer',
                  border: '1px solid var(--accent, #b48c3c)',
                  background: 'var(--accent-glow, rgba(180,140,60,0.18))',
                  color: 'var(--text-accent)', fontFamily: 'var(--font-mono)', fontSize: '0.65rem' }}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}

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

/**
 * diceParser.js
 *
 * Pure functions that parse dice notation strings and evaluate result
 * modifiers.  No React, no DOM — import anywhere.
 *
 * ── What this handles ─────────────────────────────────────────────────────
 *
 *  Modifier   Description
 *  ---------  --------------------------------------------------------------
 *  r          Reroll dice equal to n once              e.g. 4d6r1
 *  rr         Reroll recursively until no match        e.g. 4d6rr1
 *  x          Explode on max indefinitely              e.g. 1d6x  or  5d10x
 *  xo         Explode on max once                      e.g. 5d10xo
 *  xN         Explode up to N extra times              e.g. 3d6x3
 *  kh N       Keep highest N                           e.g. 4d6kh3
 *  kl N       Keep lowest N                            e.g. 2d20kl1
 *  dh N       Drop highest N                           e.g. 4d6dh1
 *  dl N       Drop lowest N                            e.g. 2d20dl1
 *  cs>=N      Count successes (default comparator >=)  e.g. 5d10cs>=8
 *  cf<=N      Count failures                           e.g. 5d10cf1
 *  df<=N      Deduct failures from success count       e.g. 5d10cs>=7df1
 *  minN       Clamp each die result to a minimum       e.g. 3d6min2
 *  maxN       Clamp each die result to a maximum       e.g. 3d6max5
 *  dF / dF    Fate/Fudge dice (-1, 0, +1)             e.g. 4dF
 *
 * ── Notation examples ─────────────────────────────────────────────────────
 *
 *  2d20kh1+5       D&D Advantage
 *  2d20kl1         D&D Disadvantage
 *  4d6kh3          Stat roll, drop lowest
 *  5d10cs>=8       World of Darkness successes
 *  5d10x10         Exploding 10s (Savage Worlds)
 *  5d10cs>=7df1    WoD successes minus botches
 *  4dF             Fate/Fudge
 *  2d6+1d8+3       Mixed pool with flat modifier
 *
 * ── Architecture note ─────────────────────────────────────────────────────
 *
 * The 3D physics engine (@3d-dice/dice-box) only understands plain notation
 * like "2d6" or "1d20".  When the user types a modified expression, DiceTray
 * asks the engine for the bare raw values, then passes those values through
 * evaluateGroup() here to apply keep/drop, successes, explode, etc.  That
 * separation means the visuals still work (dice fall on the table) while the
 * math is done correctly in JS.
 *
 * When we need additional dice for explodes/rerolls that weren't in the
 * original pool sent to the engine, we generate them locally with rollDie()
 * — no physics for those extra rolls, but they're logged to the sidecar the
 * same way.
 */

// ── Roll a single die ─────────────────────────────────────────────────────────
// Fate dice: equal probability of -1, 0, +1 (three faces each on a d6).
export function rollDie(sides) {
  if (sides === 'F') return Math.floor(Math.random() * 3) - 1;
  return Math.floor(Math.random() * sides) + 1;
}

// ── Mod-string tokeniser ──────────────────────────────────────────────────────
// Parses the modifier suffix attached to one dice group ("kh1cs>=8") into
// an array of structured ops consumed by evaluateGroup().
//
// Keywords are matched longest-first to avoid e.g. "r" eating "rr".
// The optional comparator+number that follows some keywords (cs>=8, min2, r1)
// is consumed greedily; if the number is missing we default to 1.
export function parseGroupMods(modStr) {
  const ops = [];
  let s = modStr.toLowerCase();
  // Longest-first alternatives so rr beats r, xo beats x, etc.
  const KW  = /^(rr|r|xo|x\d+|x|kh|kl|dl|dh|df|cs|cf|min|max)/;
  const CMP = /^(>=|<=|>|<|=)?(\d+)/;

  while (s.length > 0) {
    const kwm = s.match(KW);
    if (!kwm) { s = s.slice(1); continue; }        // skip unknown char
    const raw = kwm[1];
    s = s.slice(raw.length);

    // x alone (no trailing digit) → explode on max indefinitely
    if (raw === 'x') {
      // Peek: is there a comparator+number following? (e.g. x>=8 threshold)
      // For now, bare x just means "explode on natural max, no limit".
      ops.push({ op: 'x', limit: 100 });
      continue;
    }

    // xN — explode up to N extra times (N is a repeat count, not a threshold)
    const embedded = raw.match(/^x(\d+)$/);
    if (embedded) {
      ops.push({ op: 'x', limit: parseInt(embedded[1], 10) });
      continue;
    }

    // xo — explode once
    if (raw === 'xo') {
      ops.push({ op: 'xo', limit: 1 });
      continue;
    }

    // All other keywords: grab optional comparator + trailing integer
    const cmpm = s.match(CMP);
    const cmp  = cmpm && /^[><=]/.test(cmpm[1] || '') ? cmpm[1] : '>=';
    const n    = cmpm ? parseInt(cmpm[2], 10) : 1;
    if (cmpm) s = s.slice(cmpm[0].length);

    ops.push({ op: raw, n, cmp });
  }
  return ops;
}

// ── Notation parser ───────────────────────────────────────────────────────────
// Splits "2d20kh1+1d4cs>=3+5" into:
//   groups:   [ { count, sides, isFudge, modStr, raw }, … ]
//   modifier: 5   (the flat integer added at the end)
//
// The strategy is to split on + / - boundaries that separate tokens (not
// on comparators like >= that appear inside modifier strings).  Each token is
// then classified as a dice group (contains 'd') or a flat integer.
export function parseNotation(raw) {
  if (!raw || !raw.trim()) throw new Error('Empty notation');
  const src = raw.trim().replace(/\s+/g, '').toLowerCase();

  // Split on + or - that are NOT part of a comparator (>= <= > <).
  // Lookbehind for [><=!] prevents splitting >=8 or <=3.
  const tokens = src.split(/(?<![><!=])(?=[+-])/);
  const groups = [];
  let modifier = 0;

  for (const token of tokens) {
    if (!token) continue;
    // Dice group: optional sign, count, 'd', sides, then any modifier string
    const dm = token.match(/^([+-]?)(\d+)d([f\d]+)(.*)/i);
    if (dm) {
      const count  = parseInt(dm[2], 10);
      const sides  = /^f$/i.test(dm[3]) ? 'F' : parseInt(dm[3], 10);
      const modStr = dm[4] || '';
      if (sides !== 'F' && (isNaN(sides) || sides < 2)) {
        throw new Error(`Invalid die size "${dm[3]}" in "${token}"`);
      }
      groups.push({ count, sides, isFudge: sides === 'F', modStr, raw: token.replace(/^[+-]/, '') });
    } else {
      // Flat integer (may carry its own sign)
      const nm = token.match(/^([+-]?\d+)$/);
      if (nm) modifier += parseInt(nm[1], 10);
    }
  }

  if (groups.length === 0) throw new Error(`No dice found in: "${raw}"`);
  return { groups, modifier };
}

// ── Comparator helper ─────────────────────────────────────────────────────────
function matchCmp(val, cmp, threshold) {
  if (cmp === '>')  return val > threshold;
  if (cmp === '<=') return val <= threshold;
  if (cmp === '<')  return val < threshold;
  return val >= threshold;   // >= or bare = both mean "at least"
}

// ── Apply reroll ──────────────────────────────────────────────────────────────
// r:  reroll once if the die shows op.n
// rr: keep rerolling until it no longer shows op.n (up to 100 iterations as
//     a safety cap against infinite loops on degenerate inputs).
function applyReroll(vals, sides, op) {
  const limit = op.op === 'rr' ? 100 : 1;
  return vals.map((v) => {
    let cur = v, iters = 0;
    while (cur === op.n && iters++ < limit) cur = rollDie(sides);
    return cur;
  });
}

// ── Apply explode ─────────────────────────────────────────────────────────────
// When a die shows its maximum value, roll again and append that result.
// x   → keep exploding (cap: 100 extra per die)
// xo  → explode once per die
// xN  → stored on op.limit; explode up to that many extra times
//
// The value that triggers explosion is always the die's natural maximum
// (sides for numeric dice, +1 for fate dice).
function applyExplode(vals, sides, op) {
  const limit = op.op === 'xo' ? 1 : (op.limit ?? 100);
  const max   = sides === 'F' ? 1 : sides;
  const result = [];
  for (const v of vals) {
    result.push(v);
    let cur = v, count = 0;
    while (cur === max && count++ < limit) {
      cur = rollDie(sides);
      result.push(cur);
    }
  }
  return result;
}

// ── Apply keep / drop ─────────────────────────────────────────────────────────
// kh N → keep highest N      kl N → keep lowest N
// dh N → drop highest N      dl N → drop lowest N
//
// Returns { kept, dropped } so the caller can display both.
function applyKeepDrop(vals, op) {
  // Build index-aware sorted copy (ascending) so we can resolve ties
  // consistently by original position rather than arbitrarily.
  const indexed = vals.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  let keepSet;
  switch (op.op) {
    case 'kh': keepSet = new Set(indexed.slice(indexed.length - op.n).map(x => x.i)); break;
    case 'kl': keepSet = new Set(indexed.slice(0, op.n).map(x => x.i)); break;
    case 'dl': keepSet = new Set(indexed.slice(op.n).map(x => x.i)); break;          // drop lowest → keep rest
    case 'dh': keepSet = new Set(indexed.slice(0, indexed.length - op.n).map(x => x.i)); break; // drop highest → keep rest
    default:   keepSet = new Set(vals.map((_, i) => i));
  }
  return {
    kept:    vals.filter((_, i) => keepSet.has(i)),
    dropped: vals.filter((_, i) => !keepSet.has(i)),
  };
}

// ── Evaluate one dice group ───────────────────────────────────────────────────
// Given the raw die values already rolled (either by the physics engine or by
// rollDie() for pure-JS rolls), apply all result modifiers and return the
// structured outcome.
//
// rawVals — array of integer die faces as-rolled
// sides   — die size (integer or 'F')
// modStr  — the modifier suffix string, e.g. "kh1" or "cs>=8"
//
// Returns:
//   values        — final kept die values (after keep/drop, reroll, etc.)
//   dropped       — values excluded by keep/drop
//   isSuccessMode — true when cs/cf/df were used
//   successes     — net success count (only meaningful in success mode)
//   total         — sum of values OR net success count in success mode
export function evaluateGroup(rawVals, sides, modStr) {
  const ops = parseGroupMods(modStr);
  let vals    = [...rawVals];
  let dropped = [];
  let isSuccessMode = false;
  let successes     = 0;
  let minCap = null;
  let maxCap = null;

  for (const op of ops) {
    switch (op.op) {
      // ── Reroll ──
      case 'r':
      case 'rr':
        vals = applyReroll(vals, sides, op);
        break;

      // ── Explode ──
      case 'x':
      case 'xo':
        vals = applyExplode(vals, sides, op);
        break;

      // ── Keep / Drop ──
      case 'kh':
      case 'kl':
      case 'dh':
      case 'dl': {
        const r = applyKeepDrop(vals, op);
        dropped = r.dropped;
        vals    = r.kept;
        break;
      }

      // ── Bounds ──
      case 'min': minCap = op.n; break;
      case 'max': maxCap = op.n; break;

      // ── Successes / Failures ──
      case 'cs':
        isSuccessMode = true;
        successes += vals.filter(v => matchCmp(v, op.cmp, op.n)).length;
        break;
      case 'cf':
        isSuccessMode = true;
        successes += vals.filter(v => matchCmp(v, op.cmp, op.n)).length;
        break;
      case 'df':
        isSuccessMode = true;
        successes -= vals.filter(v => matchCmp(v, op.cmp, op.n)).length;
        break;
    }
  }

  // Apply min/max caps after all other processing
  if (minCap !== null) vals = vals.map(v => Math.max(v, minCap));
  if (maxCap !== null) vals = vals.map(v => Math.min(v, maxCap));

  const total = isSuccessMode
    ? successes
    : vals.reduce((a, b) => a + b, 0);

  return { values: vals, dropped, isSuccessMode, successes, total };
}

// ── Full JS roll (no physics engine) ─────────────────────────────────────────
// Parses the notation, generates all die values locally, applies modifiers,
// and returns the complete breakdown.  DiceTray uses this for command-bar
// rolls so the physics box can still animate the base dice separately when
// it's available, or fall back to this alone when it isn't.
//
// Returns:
//   groups   — array of per-group results (merged with parseNotation group data)
//   modifier — flat integer modifier
//   total    — grand total across all groups + modifier
export function rollNotation(notationStr) {
  const parsed = parseNotation(notationStr);
  let grandTotal = parsed.modifier;
  const groupResults = [];

  for (const group of parsed.groups) {
    const raw = Array.from({ length: group.count }, () => rollDie(group.sides));
    const ev  = evaluateGroup(raw, group.sides, group.modStr);
    grandTotal += ev.total;
    groupResults.push({ ...group, rawValues: raw, ...ev });
  }

  return {
    groups:   groupResults,
    modifier: parsed.modifier,
    total:    grandTotal,
  };
}

// ── Multi-roll parser ─────────────────────────────────────────────────────────
// Splits a "/" separated expression like "1d6x / 1d8+2" into independent
// rolls, each evaluated separately with their own total.
//
// "/" means "roll these independently and show both results" — it is NOT
// addition. Use "+" to add dice together into one pool.
//
// Returns an array of { notation, parsed } objects, one per segment.
// DiceTray detects a multi-roll by checking result.length > 1 and renders
// each total separately in the result card and log.
export function parseMultiRoll(raw) {
  const segments = raw.split('/').map(s => s.trim()).filter(Boolean);
  if (segments.length === 0) throw new Error('Empty notation');
  return segments.map(seg => ({
    notation: seg,
    parsed:   parseNotation(seg),
  }));
}

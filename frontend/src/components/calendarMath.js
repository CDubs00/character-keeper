// frontend/src/components/calendarMath.js
//
// ESM MIRROR of backend/calendarMath.js (§4.11) — the editor/reader/timeline use
// the same date arithmetic the server validates with. Keep the two in sync
// (same convention as loreAccess.js ↔ fog.js). No deps, pure functions.
//
// See backend/calendarMath.js for the full axis-model explanation. In short: one
// continuous day axis pinned at the epoch; toAbsoluteDays is era-agnostic; eras
// are a display label + an ordering band consumed by compareDates.
//
// TWO OVERLAYS ride on top of the spine — weekdays and cyclical year names. Both
// are overlays, NOT constraints: month length stays the authority, so an
// irregular year (31/28/1) is still legal. See the backend file for the full
// note on intercalary months and why every cycle lookup uses a floor-mod.

function months(cal)     { return Array.isArray(cal && cal.months) ? cal.months : []; }
function erasOf(cal)     { return Array.isArray(cal && cal.eras) ? cal.eras : []; }
export function yearLength(cal) { return months(cal).reduce((n, m) => n + (m.days | 0), 0); }
function epochYear(cal)  { const y = cal && cal.epoch && cal.epoch.year; return Number.isInteger(y) ? y : 1; }
function epochEra(cal) {
  const e = cal && cal.epoch && cal.epoch.era;
  if (e != null) return e;
  const es = erasOf(cal);
  return es.length ? es[0].id : null;
}

export function eraIndex(cal, era) {
  const es = erasOf(cal);
  if (!es.length) return 0;
  const i = es.findIndex(e => e.id === era);
  return i < 0 ? 0 : i;
}

function daysBeforeMonth(cal, month) {
  const ms = months(cal);
  let sum = 0;
  for (let i = 0; i < month - 1 && i < ms.length; i++) sum += (ms[i].days | 0);
  return sum;
}

export function toAbsoluteDays(cal, v) {
  if (!v) return null;
  return (v.year - epochYear(cal)) * yearLength(cal) + daysBeforeMonth(cal, v.month) + (v.day - 1);
}

export function fromAbsoluteDays(cal, n) {
  const yl = yearLength(cal);
  if (!yl) return null;
  const year = epochYear(cal) + Math.floor(n / yl);
  let rem = n - (year - epochYear(cal)) * yl;
  const ms = months(cal);
  let month = 1;
  for (let i = 0; i < ms.length; i++) {
    const d = ms[i].days | 0;
    if (rem < d) { month = i + 1; break; }
    rem -= d;
  }
  return { era: epochEra(cal), year, month, day: rem + 1 };
}

export function diffDays(cal, a, b) {
  const aa = toAbsoluteDays(cal, a);
  const bb = toAbsoluteDays(cal, b);
  if (aa == null || bb == null) return null;
  return aa - bb;
}

export function compareDates(cal, a, b) {
  const ea = eraIndex(cal, a && a.era);
  const eb = eraIndex(cal, b && b.era);
  if (ea !== eb) return ea - eb;
  return (toAbsoluteDays(cal, a) || 0) - (toAbsoluteDays(cal, b) || 0);
}

export function formatDate(cal, v) {
  if (!v || !cal) return '';
  const ms = months(cal);
  const m = ms[v.month - 1];
  const monthName = m ? m.name : `Month ${v.month}`;
  const era = erasOf(cal).find(e => e.id === v.era);
  const abbr = era ? (era.abbr || era.label || era.id) : (v.era || '');
  return `${v.day} ${monthName}, ${v.year}${abbr ? ` ${abbr}` : ''}`;
}

export function validateDate(cal, value) {
  if (value == null) return { ok: true, value: null };
  if (typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'not a date' };
  const ms = months(cal);
  if (!ms.length) return { ok: false, error: 'calendar has no months' };

  const { year, month, day } = value;
  if (!Number.isInteger(year)) return { ok: false, error: 'year must be a whole number' };
  if (!Number.isInteger(month) || month < 1 || month > ms.length)
    return { ok: false, error: `month out of range (1–${ms.length})` };
  const maxDay = ms[month - 1].days | 0;
  if (!Number.isInteger(day) || day < 1 || day > maxDay)
    return { ok: false, error: `day out of range (1–${maxDay})` };

  let era = null;
  const es = erasOf(cal);
  if (es.length) {
    const cand = value.era != null ? value.era : epochEra(cal);
    if (!es.some(e => e.id === cand)) return { ok: false, error: 'unknown era' };
    era = cand;
  }
  return { ok: true, value: { era, year, month, day } };
}

// Convenience for the editor: the ordered month list (name + days).
export function calMonths(cal) { return months(cal); }
export function calEras(cal) { return erasOf(cal); }


// --- overlay helpers (function declarations hoist, so this whole section can
// live at the end of the file as one contiguous append) ---------------------

function weekdaysOf(cal) { return Array.isArray(cal && cal.weekdays) ? cal.weekdays : []; }
function cycleOf(cal) {
  const y = cal && cal.yearNames;
  return y && Array.isArray(y.cycle) ? y.cycle : [];
}

// --- the week overlay --------------------------------------------------------

// Floor-based modulo. JS `%` keeps the sign of the DIVIDEND, so -1 % 12 is -1,
// not 11 — which would index off the front of a cycle array and render
// "undefined". Pre-epoch years and negative day counts are both legal, so EVERY
// cycle lookup goes through this.
function cycleIndex(n, len) {
  if (!len) return null;
  return ((n % len) + len) % len;
}

// Days per year that ride the week cycle — intercalary months excluded. Equals
// yearLength when nothing is flagged intercalary.
export function cycleYearLength(cal) {
  return months(cal).reduce((n, m) => n + (m.intercalary ? 0 : (m.days | 0)), 0);
}

// Position on the WEEK axis. Returns null when the date lands on an intercalary
// festival day, which by definition sits outside the week.
export function toCycleDays(cal, v) {
  if (!v) return null;
  const ms = months(cal);
  const m  = ms[v.month - 1];
  if (!m || m.intercalary) return null;
  let before = 0;
  for (let i = 0; i < v.month - 1 && i < ms.length; i++) {
    if (!ms[i].intercalary) before += (ms[i].days | 0);
  }
  return (v.year - epochYear(cal)) * cycleYearLength(cal) + before + (v.day - 1);
}

// The weekday NAME of a date, or null if the calendar declares no weekdays (never
// invented) or the date is an intercalary festival day.
export function weekdayOf(cal, v) {
  const wd = weekdaysOf(cal);
  if (!wd.length) return null;
  const n = toCycleDays(cal, v);
  if (n == null) return null;
  return wd[cycleIndex(n, wd.length)];
}

// --- the year-name overlay ---------------------------------------------------

// The year the cycle's FIRST name falls on. Defaults to the epoch year.
export function yearAnchor(cal) {
  const a = cal && cal.yearNames && cal.yearNames.anchorYear;
  return Number.isInteger(a) ? a : epochYear(cal);
}

// The cyclical name of a year — "Year of the Horse". null when no cycle is
// declared, so a caller can simply omit the label.
export function yearNameOf(cal, year) {
  const c = cycleOf(cal);
  if (!c.length || !Number.isInteger(year)) return null;
  return c[cycleIndex(year - yearAnchor(cal), c.length)];
}


// Convenience for the editor, matching calMonths/calEras: read the overlays
// without reaching into the raw object shape.
export function calWeekdays(cal) { return weekdaysOf(cal); }
export function calYearCycle(cal) { return cycleOf(cal); }
export function calEpochYear(cal) { return epochYear(cal); }

// --- validation: what blocks a save vs what merely warns ---------------------
//
// Lives HERE, beside the math, so the editor and the server enforce identical
// rules — the same reason the fog parser is shared rather than reimplemented per
// surface. Returns { errors, warnings }; each item is { code, message }.
//
// THE SPLIT MATTERS. Only things that make the arithmetic produce nonsense are
// errors. A week that doesn't divide the year evenly is NOT an error: that is
// Earth (365 % 7 = 1), and it was true of this codebase's own shipped calendar
// (335 % 7 = 6). Blocking it would make the common case unsavable and force every
// GM to pad their year. It warns, because drifting weekdays surprise people who
// expected "the 1st is always Restday" — and the fix (an intercalary festival) is
// worth naming in the message.
export function calendarIssues(cal) {
  const errors = [];
  const warnings = [];
  const err  = (code, message) => errors.push({ code, message });
  const warn = (code, message) => warnings.push({ code, message });

  const ms = months(cal);
  const wd = weekdaysOf(cal);
  const es = erasOf(cal);
  const cy = cycleOf(cal);

  // --- errors: the math breaks ---
  if (!ms.length) {
    err('no-months', 'Add at least one month — months are what a year is made of.');
  }
  ms.forEach((m, i) => {
    const label = (m && m.name) || `Month ${i + 1}`;
    if (!m || !Number.isInteger(m.days) || m.days < 1) {
      err('bad-days', `${label} needs a whole number of days, at least 1.`);
    }
    if (!m || typeof m.name !== 'string' || !m.name.trim()) {
      err('blank-month', `Month ${i + 1} needs a name.`);
    }
  });

  const eraIds = new Set();
  es.forEach((e, i) => {
    const id = e && e.id;
    if (typeof id !== 'string' || !/^[a-z0-9-]{1,60}$/.test(id)) {
      err('bad-era-id', `Era ${i + 1} needs a short id using lowercase letters, numbers or dashes.`);
    } else if (eraIds.has(id)) {
      err('dupe-era', `Two eras share the id "${id}" — ids must be unique.`);
    } else {
      eraIds.add(id);
    }
    if (!e || typeof e.label !== 'string' || !e.label.trim()) {
      err('blank-era', `Era ${i + 1} needs a name.`);
    }
  });

  const ep = (cal && cal.epoch) || {};
  if (ep.era != null && es.length && !eraIds.has(ep.era)) {
    err('epoch-era', 'The starting era is not one of the eras listed above.');
  }
  if (ep.year != null && !Number.isInteger(ep.year)) {
    err('epoch-year', 'The starting year must be a whole number.');
  }

  wd.forEach((d, i) => {
    if (typeof d !== 'string' || !d.trim()) err('blank-weekday', `Day ${i + 1} of the week needs a name.`);
  });
  cy.forEach((n, i) => {
    if (typeof n !== 'string' || !n.trim()) err('blank-year-name', `Year name ${i + 1} is blank.`);
  });

  // --- warnings: legal, but probably not what was intended ---
  if (wd.length && ms.length) {
    const counted = cycleYearLength(cal);
    const rem = counted % wd.length;
    if (rem !== 0) {
      warn('week-drift',
        `A ${wd.length}-day week doesn't divide the ${counted} days that ride it — ${rem} left over, so weekdays shift each year. Mark a short month as a festival to absorb the remainder.`);
    }
    for (const m of ms) {
      if (m && !m.intercalary && Number.isInteger(m.days) && m.days < wd.length) {
        warn('short-month', `${m.name} is shorter than a week.`);
      }
    }
  }
  if (cy.length === 1) {
    warn('single-year-name', 'A cycle of one name means every year carries it.');
  }

  return { errors, warnings };
}

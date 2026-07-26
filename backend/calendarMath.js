// backend/calendarMath.js
//
// Pure in-world date math for pack-declared calendars (§4.11). No eval, no deps,
// no I/O — just arithmetic over a calendar shape. Mirrored VERBATIM (minus the
// module wrapper) to frontend/src/components/calendarMath.js so the editor,
// reader, and timeline format dates the same way the server validates them. Keep
// the two in sync (same convention as loreAccess.js ↔ fog.js).
//
// A CALENDAR reaches here already validated by packs.cleanCalendar, from EITHER
// the world's own GM-authored `world.calendar` or its pack's calendar.json (the
// world wins — a calendar is lore, not rules). Shape:
//   { name?, epoch?: { era?, year? }, eras?: [{ id, label, abbr }],
//     months: [{ name, days, intercalary? }], weekdays?: [...],
//     yearNames?: { cycle: [...], anchorYear? } }
// `months` is the ordered spine; `days` is a positive int; a 1-day month is legal.
//
// TWO CYCLES ride on top of the spine, and both are OVERLAYS rather than
// constraints — month length stays the authority, so an irregular year (31/28/1)
// is still legal:
//   • weekdays — week length IS weekdays.length. The weekday of a date is its
//     position on the continuous day axis, mod that length, so weekdays drift
//     year to year exactly like Earth's unless intercalary days absorb the
//     remainder (see below).
//   • yearNames.cycle — a repeating list of year names indexed off the year
//     number ("Year of the Horse"). The same mechanism one scale up.
// Both return null when undeclared: a weekday or year name is NEVER invented.
//
// INTERCALARY MONTHS: a month flagged `intercalary: true` sits OUTSIDE the week
// cycle — its days are skipped when counting weekdays, and dates falling on one
// have no weekday at all. That is the Harptos/festival trick: 12 30-day months
// (a whole number of 10-day tendays) plus 5 festival days means every year
// starts on the same weekday. It changes NOTHING about toAbsoluteDays: the
// chronological axis still counts every day, festival or not.
//
// A DATE VALUE stored on a lore entry field:
//   { era, year, month, day }   // month & day are 1-BASED   — or null/absent.
//
// AXIS MODEL (deliberate, documented): there is ONE continuous day axis pinned at
// the epoch. `toAbsoluteDays` counts year·monthdays + preceding months + day and
// is ERA-AGNOSTIC (eras carry no length in the schema, so they can't participate
// in a single-integer day count). Eras are a DISPLAY label plus an ORDERING band:
// `compareDates` orders by era index first (array order), then by the day count.
// For the common single-era calendar this is exactly "sort by toAbsoluteDays".

function months(cal)     { return Array.isArray(cal && cal.months) ? cal.months : []; }
function eras(cal)       { return Array.isArray(cal && cal.eras) ? cal.eras : []; }
function weekdays(cal)   { return Array.isArray(cal && cal.weekdays) ? cal.weekdays : []; }
function yearCycle(cal) {
  const y = cal && cal.yearNames;
  return y && Array.isArray(y.cycle) ? y.cycle : [];
}

// The year the cycle's FIRST name falls on. Defaults to the epoch year so a
// calendar that omits it is still deterministic.
function yearAnchor(cal) {
  const a = cal && cal.yearNames && cal.yearNames.anchorYear;
  return Number.isInteger(a) ? a : epochYear(cal);
}

// Floor-based modulo. JS `%` keeps the sign of the DIVIDEND, so -1 % 12 is -1,
// not 11 — which would index off the front of a cycle array and return
// undefined. Years before the epoch are legal (validateDate accepts any integer
// year) and so are negative day counts, so EVERY cycle lookup goes through this.
function cycleIndex(n, len) {
  if (!len) return null;
  return ((n % len) + len) % len;
}
function yearLength(cal) { return months(cal).reduce((n, m) => n + (m.days | 0), 0); }
function epochYear(cal)  { const y = cal && cal.epoch && cal.epoch.year; return Number.isInteger(y) ? y : 1; }
function epochEra(cal) {
  const e = cal && cal.epoch && cal.epoch.era;
  if (e != null) return e;
  const es = eras(cal);
  return es.length ? es[0].id : null;
}

// Ordering band for an era: its position in the eras array. Unknown/implicit → 0.
function eraIndex(cal, era) {
  const es = eras(cal);
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

// { year, month, day } → integer day index from the epoch (era ignored — see note).
function toAbsoluteDays(cal, v) {
  if (!v) return null;
  return (v.year - epochYear(cal)) * yearLength(cal) + daysBeforeMonth(cal, v.month) + (v.day - 1);
}

// Inverse of toAbsoluteDays. Returns the epoch's era (the axis is pinned there),
// so it round-trips year/month/day exactly for any date on the epoch era.
function fromAbsoluteDays(cal, n) {
  const yl = yearLength(cal);
  if (!yl) return null;
  const year = epochYear(cal) + Math.floor(n / yl);
  let rem = n - (year - epochYear(cal)) * yl;   // n mod yl, always in [0, yl)
  const ms = months(cal);
  let month = 1;
  for (let i = 0; i < ms.length; i++) {
    const d = ms[i].days | 0;
    if (rem < d) { month = i + 1; break; }
    rem -= d;
  }
  return { era: epochEra(cal), year, month, day: rem + 1 };
}

// Gap in days between two dates (a − b) on the continuous axis. null if either is unset.
function diffDays(cal, a, b) {
  const aa = toAbsoluteDays(cal, a);
  const bb = toAbsoluteDays(cal, b);
  if (aa == null || bb == null) return null;
  return aa - bb;
}

// --- the week overlay --------------------------------------------------------

// Days per year that participate in the week cycle — intercalary months excluded.
// With no intercalary months this equals yearLength, so the default behaviour is
// unchanged.
function cycleYearLength(cal) {
  return months(cal).reduce((n, m) => n + (m.intercalary ? 0 : (m.days | 0)), 0);
}

// Position on the WEEK axis: like toAbsoluteDays, but intercalary days are not
// counted at all. Returns null when the date itself lands on an intercalary day,
// because such a day is deliberately outside the week and has no weekday.
function toCycleDays(cal, v) {
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

// The weekday NAME of a date, or null if the calendar declares no weekdays (we
// never invent one) or the date is an intercalary festival day.
function weekdayOf(cal, v) {
  const wd = weekdays(cal);
  if (!wd.length) return null;
  const n = toCycleDays(cal, v);
  if (n == null) return null;
  return wd[cycleIndex(n, wd.length)];
}

// --- the year-name overlay ---------------------------------------------------

// The cyclical name of a year — "Year of the Horse". Zodiac-style: a repeating
// list anchored to a year, so year+cycleLength always carries the same name.
// null when the calendar declares no cycle.
function yearNameOf(cal, year) {
  const c = yearCycle(cal);
  if (!c.length || !Number.isInteger(year)) return null;
  return c[cycleIndex(year - yearAnchor(cal), c.length)];
}

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
function calendarIssues(cal) {
  const errors = [];
  const warnings = [];
  const err  = (code, message) => errors.push({ code, message });
  const warn = (code, message) => warnings.push({ code, message });

  const ms = months(cal);
  const wd = weekdays(cal);
  const es = eras(cal);
  const cy = yearCycle(cal);

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

// Chronological comparator: era band first (array order), then day count.
function compareDates(cal, a, b) {
  const ea = eraIndex(cal, a && a.era);
  const eb = eraIndex(cal, b && b.era);
  if (ea !== eb) return ea - eb;
  return (toAbsoluteDays(cal, a) || 0) - (toAbsoluteDays(cal, b) || 0);
}

// Display string, e.g. "15 Hammer, 1492 DR". Deliberately UNCHANGED by the
// weekday/year-name work: this string is rendered by the reader, the entry list
// and the Events timeline, so widening it would reflow all three. Callers with
// room compose their own line from weekdayOf() / yearNameOf(), which return null
// when undeclared. (The previous note here promised an `opts.weekday` that was
// never implemented — weekdayOf is that feature, as a separate accessor.)
function formatDate(cal, v) {
  if (!v || !cal) return '';
  const ms = months(cal);
  const m = ms[v.month - 1];
  const monthName = m ? m.name : `Month ${v.month}`;
  const era = eras(cal).find(e => e.id === v.era);
  const abbr = era ? (era.abbr || era.label || era.id) : (v.era || '');
  return `${v.day} ${monthName}, ${v.year}${abbr ? ` ${abbr}` : ''}`;
}

// Validate + normalize a stored date value against a calendar. Returns
// { ok: true, value: {era,year,month,day}|null } or { ok: false, error }.
// Lenient on era: if the pack declares eras and none is given, defaults to the
// epoch era; if it declares none, era is forced to null.
function validateDate(cal, value) {
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
  const es = eras(cal);
  if (es.length) {
    const cand = value.era != null ? value.era : epochEra(cal);
    if (!es.some(e => e.id === cand)) return { ok: false, error: 'unknown era' };
    era = cand;
  }
  return { ok: true, value: { era, year, month, day } };
}

module.exports = {
  months, eras, yearLength, epochYear, epochEra, eraIndex,
  toAbsoluteDays, fromAbsoluteDays, diffDays, compareDates, formatDate, validateDate,
  // overlays: week + year-name cycles
  weekdays, cycleYearLength, toCycleDays, weekdayOf,
  yearCycle, yearAnchor, yearNameOf, cycleIndex,
  // validation
  calendarIssues,
};

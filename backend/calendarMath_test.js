// backend/calendarMath.test.js
//
// §4.11 pure date-math tests. No framework (the backend ships none) — plain
// `assert`, run with `node calendarMath.test.js`, exit non-zero on first failure.
// Covers: absolute↔date round-trip, multi-era ordering, 1-day months, and a diff
// across a year boundary. Same convention as loreAccess.test.js.

const assert = require('assert');
const cm = require('./calendarMath');

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

// A calendar with an irregular spine INCLUDING a 1-day festival month (Midyear),
// a single explicit era, epoch at CE year 1.
const CAL = {
  name: 'Test Reckoning',
  epoch: { era: 'CE', year: 1 },
  eras: [{ id: 'CE', label: 'Common Era', abbr: 'CE' }],
  months: [
    { name: 'Deepwinter', days: 31 },
    { name: 'Thawing', days: 28 },
    { name: 'Midyear', days: 1 },    // 1-day month
    { name: 'Harvest', days: 30 },
  ],
};
const YEAR_LEN = 31 + 28 + 1 + 30; // 90

check('year length = Σ month days', () => {
  assert.strictEqual(cm.yearLength(CAL), YEAR_LEN);
});

check('absolute↔date round-trips across every month (incl. the 1-day month)', () => {
  // Walk a couple of years day-by-day; each date must survive to→from unchanged,
  // and absolute days must increase by exactly 1 each step.
  let prev = null;
  for (let abs = 0; abs < YEAR_LEN * 2 + 5; abs++) {
    const d = cm.fromAbsoluteDays(CAL, abs);
    assert.strictEqual(cm.toAbsoluteDays(CAL, d), abs, `round-trip at abs=${abs}`);
    assert.ok(d.month >= 1 && d.month <= CAL.months.length);
    assert.ok(d.day >= 1 && d.day <= CAL.months[d.month - 1].days);
    if (prev !== null) assert.strictEqual(abs - prev, 1);
    prev = abs;
  }
});

check('epoch is day 0; the 1-day Midyear month is exactly one day wide', () => {
  assert.strictEqual(cm.toAbsoluteDays(CAL, { era: 'CE', year: 1, month: 1, day: 1 }), 0);
  // Midyear (month 3) sits after 31 + 28 = 59 days.
  assert.strictEqual(cm.toAbsoluteDays(CAL, { era: 'CE', year: 1, month: 3, day: 1 }), 59);
  // The next day rolls into Harvest (month 4, day 1).
  const next = cm.fromAbsoluteDays(CAL, 60);
  assert.deepStrictEqual(next, { era: 'CE', year: 1, month: 4, day: 1 });
});

check('diffDays across a year boundary = 1 (last day of year → first of next)', () => {
  const lastOfYear1  = { era: 'CE', year: 1, month: 4, day: 30 }; // abs = 89
  const firstOfYear2 = { era: 'CE', year: 2, month: 1, day: 1 };  // abs = 90
  assert.strictEqual(cm.toAbsoluteDays(CAL, lastOfYear1), YEAR_LEN - 1);
  assert.strictEqual(cm.toAbsoluteDays(CAL, firstOfYear2), YEAR_LEN);
  assert.strictEqual(cm.diffDays(CAL, firstOfYear2, lastOfYear1), 1);
});

check('negative years (before epoch) round-trip too', () => {
  const d = { era: 'CE', year: -2, month: 2, day: 5 };
  assert.strictEqual(cm.toAbsoluteDays(CAL, cm.fromAbsoluteDays(CAL, cm.toAbsoluteDays(CAL, d))), cm.toAbsoluteDays(CAL, d));
});

// Multi-era calendar: eras are ordered blocks (array order), era first, then day.
const MULTI = {
  epoch: { era: 'AF', year: 1 },
  eras: [
    { id: 'BF', label: 'Before Founding', abbr: 'BF' },
    { id: 'AF', label: 'After Founding', abbr: 'AF' },
  ],
  months: [{ name: 'One', days: 10 }, { name: 'Two', days: 10 }],
};

check('multi-era ordering: era band wins over the day count', () => {
  const bfLate = { era: 'BF', year: 999, month: 2, day: 10 };  // huge day count, but era BF (index 0)
  const afEarly = { era: 'AF', year: 1, month: 1, day: 1 };     // era AF (index 1)
  // BF sorts before AF regardless of the raw day numbers.
  assert.ok(cm.compareDates(MULTI, bfLate, afEarly) < 0);
  assert.ok(cm.compareDates(MULTI, afEarly, bfLate) > 0);
  // Within the same era, ordering falls back to the day count.
  const afLater = { era: 'AF', year: 3, month: 2, day: 5 };
  assert.ok(cm.compareDates(MULTI, afEarly, afLater) < 0);
  // A full sort lands in the intended chronology.
  const sorted = [afLater, bfLate, afEarly].slice().sort((a, b) => cm.compareDates(MULTI, a, b));
  assert.deepStrictEqual(sorted, [bfLate, afEarly, afLater]);
});

check('formatDate renders "day month, year abbr"', () => {
  assert.strictEqual(cm.formatDate(CAL, { era: 'CE', year: 1492, month: 1, day: 15 }), '15 Deepwinter, 1492 CE');
});

check('validateDate: ranges, era defaulting, and rejects', () => {
  assert.strictEqual(cm.validateDate(CAL, null).ok, true);
  assert.deepStrictEqual(cm.validateDate(CAL, { year: 5, month: 2, day: 28 }).value, { era: 'CE', year: 5, month: 2, day: 28 }); // era defaults to epoch
  assert.strictEqual(cm.validateDate(CAL, { year: 5, month: 2, day: 29 }).ok, false); // Thawing only has 28
  assert.strictEqual(cm.validateDate(CAL, { year: 5, month: 5, day: 1 }).ok, false);  // no month 5
  assert.strictEqual(cm.validateDate(CAL, { year: 1.5, month: 1, day: 1 }).ok, false); // non-integer year
  assert.strictEqual(cm.validateDate(MULTI, { era: 'ZZ', year: 1, month: 1, day: 1 }).ok, false); // unknown era
  // A calendar with no months can't validate a date.
  assert.strictEqual(cm.validateDate({ months: [] }, { year: 1, month: 1, day: 1 }).ok, false);
});

// --- the week overlay --------------------------------------------------------
//
// Week length IS weekdays.length. The weekday of a date is its position on the
// continuous day axis mod that length, so it must NOT reset each year.

const WEEK = {
  epoch: { year: 1 },
  months: [
    { name: 'One',   days: 31 },
    { name: 'Two',   days: 28 },
    { name: 'Three', days: 30 },
  ],
  weekdays: ['Sunsday', 'Moonsday', 'Toilsday', 'Waterday', 'Thundsday'],  // 5-day week
};

check('no weekdays declared → weekdayOf is null (never invented)', () => {
  assert.strictEqual(cm.weekdayOf(CAL, { era: 'CE', year: 1, month: 1, day: 1 }), null);
  assert.deepStrictEqual(cm.weekdays(CAL), []);
});

check('weekday cycles with the day axis and does NOT reset at year end', () => {
  // Epoch day 0 is the first weekday.
  assert.strictEqual(cm.weekdayOf(WEEK, { year: 1, month: 1, day: 1 }), 'Sunsday');
  assert.strictEqual(cm.weekdayOf(WEEK, { year: 1, month: 1, day: 6 }), 'Sunsday');   // +5
  assert.strictEqual(cm.weekdayOf(WEEK, { year: 1, month: 1, day: 2 }), 'Moonsday');
  // Year length 89 is not a multiple of 5, so year 2 starts mid-week — the drift
  // is the point: a reset would mean the cycle isn't riding the real axis.
  const yl = cm.yearLength(WEEK);            // 89
  assert.strictEqual(yl % WEEK.weekdays.length !== 0, true);
  assert.strictEqual(cm.weekdayOf(WEEK, { year: 2, month: 1, day: 1 }),
    WEEK.weekdays[yl % WEEK.weekdays.length]);
});

check('weekday is correct for PRE-EPOCH dates (floor-mod, not JS %)', () => {
  // The bug this pins: -1 % 5 is -1 in JS, so a naive index returns undefined.
  const before = { year: 0, month: 3, day: 30 };            // the day before the epoch
  assert.strictEqual(cm.toCycleDays(WEEK, before), -1);
  assert.strictEqual(cm.weekdayOf(WEEK, before), 'Thundsday'); // last weekday, wrapped
  for (let abs = -20; abs < 0; abs++) {
    const i = cm.cycleIndex(abs, 5);
    assert.ok(i >= 0 && i < 5, `cycleIndex(${abs}) out of range`);
  }
});

// Intercalary: 3 12-day months (a whole number of 4-day weeks) + a 2-day festival
// that sits OUTSIDE the week, so every year starts on the same weekday.
const FESTIVAL = {
  epoch: { year: 1 },
  months: [
    { name: 'First',    days: 12 },
    { name: 'Second',   days: 12 },
    { name: 'Third',    days: 12 },
    { name: 'Highfest', days: 2, intercalary: true },
  ],
  weekdays: ['A', 'B', 'C', 'D'],
};

check('intercalary days have NO weekday and are skipped by the cycle', () => {
  assert.strictEqual(cm.weekdayOf(FESTIVAL, { year: 1, month: 4, day: 1 }), null);
  assert.strictEqual(cm.weekdayOf(FESTIVAL, { year: 1, month: 4, day: 2 }), null);
  // 36 counted days/year ÷ a 4-day week = whole weeks, so every year starts on 'A'.
  assert.strictEqual(cm.cycleYearLength(FESTIVAL), 36);
  for (const year of [1, 2, 3, 10]) {
    assert.strictEqual(cm.weekdayOf(FESTIVAL, { year, month: 1, day: 1 }), 'A');
  }
});

check('intercalary changes the WEEK axis only — chronology still counts every day', () => {
  // The festival days are real days: they must still advance toAbsoluteDays, or
  // the timeline would place events on top of each other.
  assert.strictEqual(cm.yearLength(FESTIVAL), 38);          // 36 + the 2 festival days
  assert.strictEqual(cm.diffDays(FESTIVAL,
    { year: 2, month: 1, day: 1 }, { year: 1, month: 1, day: 1 }), 38);
});

// --- the year-name overlay ---------------------------------------------------

const ZODIAC = {
  epoch: { year: 1 },
  months: [{ name: 'One', days: 10 }],
  yearNames: {
    cycle: ['Rat', 'Ox', 'Tiger', 'Rabbit', 'Dragon', 'Snake',
            'Horse', 'Goat', 'Monkey', 'Rooster', 'Dog', 'Pig'],
    anchorYear: 2020,
  },
};

check('no cycle declared → yearNameOf is null (never invented)', () => {
  assert.strictEqual(cm.yearNameOf(CAL, 1492), null);
  assert.deepStrictEqual(cm.yearCycle(CAL), []);
});

check('year names cycle from the anchor year', () => {
  assert.strictEqual(cm.yearNameOf(ZODIAC, 2020), 'Rat');      // the anchor itself
  assert.strictEqual(cm.yearNameOf(ZODIAC, 2026), 'Horse');    // +6
  assert.strictEqual(cm.yearNameOf(ZODIAC, 2032), 'Rat');      // +12, one full cycle
  assert.strictEqual(cm.yearNameOf(ZODIAC, 2019), 'Pig');      // -1 wraps to the end
  assert.strictEqual(cm.yearNameOf(ZODIAC, 1900), 'Rat');      // far pre-anchor, still exact
});

check('year names survive negative years and non-integers are rejected', () => {
  for (let y = -60; y < 0; y++) {
    assert.ok(ZODIAC.yearNames.cycle.includes(cm.yearNameOf(ZODIAC, y)), `year ${y} fell off the cycle`);
  }
  assert.strictEqual(cm.yearNameOf(ZODIAC, 1.5), null);
  assert.strictEqual(cm.yearNameOf(ZODIAC, null), null);
});

check('the anchor defaults to the epoch year when omitted', () => {
  const noAnchor = { ...ZODIAC, yearNames: { cycle: ZODIAC.yearNames.cycle } };
  assert.strictEqual(cm.yearAnchor(noAnchor), cm.epochYear(noAnchor));
  assert.strictEqual(cm.yearNameOf(noAnchor, 1), 'Rat');
});

check('formatDate is UNCHANGED by the overlays (no reflow of existing views)', () => {
  const withBoth = { ...CAL, weekdays: ['A', 'B'], yearNames: { cycle: ['Rat'] } };
  assert.strictEqual(cm.formatDate(withBoth, { era: 'CE', year: 1492, month: 1, day: 15 }),
    '15 Deepwinter, 1492 CE');
});

console.log(`\ncalendarMath: ${passed} checks passed.`);

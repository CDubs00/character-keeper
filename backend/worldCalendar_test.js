// backend/worldCalendar_test.js
//
// The shared calendar validator. Plain `assert`, run with
// `node worldCalendar_test.js`; exits non-zero on first failure. Same convention
// as calendarMath_test.js / campaignAccess_test.js.
//
// A calendar is LORE, not rules — it belongs to the setting, so a world may hold
// its own GM-authored one and the pack's calendar.json is only a template.
// packs.cleanCalendar is the ONE validator both paths run through, which is what
// these checks pin: GM input can never be accepted in a shape a pack file
// couldn't be, and vice versa.

const assert = require('assert');
const packs  = require('./packs');
const cm     = require('./calendarMath');

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

const GOOD = {
  name: 'Harptos-ish',
  epoch: { era: 'dr', year: 1 },
  eras: [{ id: 'dr', label: 'Dalereckoning', abbr: 'DR' }],
  months: [
    { name: 'Hammer',   days: 30 },
    { name: 'Midwinter', days: 1, intercalary: true },
    { name: 'Alturiak', days: 30 },
  ],
  weekdays: ['First', 'Second', 'Third', 'Fourth', 'Fifth',
             'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth'],
  yearNames: { cycle: ['Year of the Gauntlet', 'Year of the Shield'], anchorYear: 1369 },
};

// --- 1. months are the required spine ----------------------------------------

check('a calendar with no usable months is rejected outright', () => {
  for (const raw of [
    { months: [] },
    { months: 'nope' },
    {},
    { months: [{ name: 'Bad', days: 0 }] },      // a 0-day month is not a month
    { months: [{ name: 'Bad', days: -3 }] },
    { months: [{ name: 'Bad' }] },               // no days at all
  ]) {
    assert.strictEqual(packs.cleanCalendar(raw, 'test'), null);
  }
});

check('non-objects are rejected, never coerced', () => {
  for (const raw of [null, undefined, 'calendar', 42, [], [{ months: [] }]]) {
    assert.strictEqual(packs.cleanCalendar(raw, 'test'), null);
  }
});

check('a 1-day month is legal and survives', () => {
  const c = packs.cleanCalendar({ months: [{ name: 'Midyear', days: 1 }] }, 'test');
  assert.strictEqual(c.months.length, 1);
  assert.strictEqual(c.months[0].days, 1);
});

// --- 2. the output shape is fixed --------------------------------------------

check('output carries every key calendarMath reads, even when the input omitted them', () => {
  const c = packs.cleanCalendar({ months: [{ name: 'One', days: 10 }] }, 'test');
  assert.deepStrictEqual(Object.keys(c).sort(),
    ['epoch', 'eras', 'months', 'name', 'weekdays', 'yearNames'].sort());
  assert.deepStrictEqual(c.eras, []);
  assert.deepStrictEqual(c.weekdays, []);
  assert.strictEqual(c.yearNames, null);       // null ⇒ never invented
  assert.strictEqual(c.name, 'Calendar');      // a default label, not undefined
});

check('unknown keys are dropped — the cleaner is an allowlist, not a passthrough', () => {
  const c = packs.cleanCalendar(
    { months: [{ name: 'One', days: 10 }], evil: 'payload', __proto__: { x: 1 } }, 'test');
  assert.ok(!('evil' in c));
});

check('leap rules are ignored rather than half-implemented', () => {
  const c = packs.cleanCalendar({ months: [{ name: 'One', days: 10 }], leap: { every: 4 } }, 'test');
  assert.ok(!('leap' in c));
});

// --- 3. intercalary ----------------------------------------------------------

check('intercalary is kept when true and OMITTED otherwise (no false noise)', () => {
  const c = packs.cleanCalendar(GOOD, 'test');
  assert.strictEqual(c.months[1].intercalary, true);
  assert.ok(!('intercalary' in c.months[0]), 'a plain month must stay byte-identical to before');
  // Only a literal true counts — a truthy string must not flag a festival month.
  const sneaky = packs.cleanCalendar({ months: [{ name: 'X', days: 5, intercalary: 'yes' }] }, 'test');
  assert.ok(!('intercalary' in sneaky.months[0]));
});

// --- 4. eras + epoch ---------------------------------------------------------

check('an epoch era that is not a declared era is dropped', () => {
  const c = packs.cleanCalendar({
    months: [{ name: 'One', days: 10 }],
    eras: [{ id: 'ce', label: 'Common Era', abbr: 'CE' }],
    epoch: { era: 'nope', year: 5 },
  }, 'test');
  assert.strictEqual(c.epoch.year, 5);
  assert.ok(!('era' in c.epoch), 'a dangling era reference must not be stored');
});

check('a non-integer epoch year is dropped, not floored', () => {
  const c = packs.cleanCalendar({ months: [{ name: 'One', days: 10 }], epoch: { year: 1.5 } }, 'test');
  assert.ok(!('year' in c.epoch));
});

// --- 5. year-name cycle ------------------------------------------------------

check('a good cycle survives with its anchor', () => {
  const c = packs.cleanCalendar(GOOD, 'test');
  assert.deepStrictEqual(c.yearNames.cycle, ['Year of the Gauntlet', 'Year of the Shield']);
  assert.strictEqual(c.yearNames.anchorYear, 1369);
});

check('an empty or garbage cycle drops the whole block rather than storing a stub', () => {
  for (const yearNames of [
    { cycle: [] }, { cycle: 'Rat' }, { cycle: ['', '  '] }, {}, 'zodiac', ['Rat'],
  ]) {
    const c = packs.cleanCalendar({ months: [{ name: 'One', days: 10 }], yearNames }, 'test');
    assert.strictEqual(c.yearNames, null, `yearNames ${JSON.stringify(yearNames)} should not survive`);
  }
});

check('a non-integer anchor is dropped, leaving the epoch-year default', () => {
  const c = packs.cleanCalendar({
    months: [{ name: 'One', days: 10 }],
    epoch: { year: 700 },
    yearNames: { cycle: ['Rat', 'Ox'], anchorYear: 'soon' },
  }, 'test');
  assert.ok(!('anchorYear' in c.yearNames));
  assert.strictEqual(cm.yearAnchor(c), 700, 'falls back to the epoch year');
});

// --- 6. caps -----------------------------------------------------------------

check('oversized input is truncated, not rejected — a world calendar is stored inline', () => {
  const many = n => Array.from({ length: n }, (_, i) => ({ name: `M${i}`, days: 10 }));
  const c = packs.cleanCalendar({
    months: many(500),
    weekdays: Array.from({ length: 500 }, (_, i) => `D${i}`),
    yearNames: { cycle: Array.from({ length: 500 }, (_, i) => `Y${i}`) },
    name: 'x'.repeat(500),
  }, 'test');
  assert.ok(c.months.length <= 60 && c.months.length > 0);
  assert.ok(c.weekdays.length <= 40);
  assert.ok(c.yearNames.cycle.length <= 120);
  assert.ok(c.name.length <= 80);
});

// --- 7. the round trip -------------------------------------------------------

check('a cleaned calendar is directly usable by the date math', () => {
  const c = packs.cleanCalendar(GOOD, 'test');
  // 30 + 1 + 30 = 61 days a year, but only 60 ride the 10-day week (Midwinter
  // is intercalary) — so every year starts on the same weekday.
  assert.strictEqual(cm.yearLength(c), 61);
  assert.strictEqual(cm.cycleYearLength(c), 60);
  assert.strictEqual(cm.weekdayOf(c, { era: 'dr', year: 1, month: 1, day: 1 }), 'First');
  assert.strictEqual(cm.weekdayOf(c, { era: 'dr', year: 9, month: 1, day: 1 }), 'First');
  assert.strictEqual(cm.weekdayOf(c, { era: 'dr', year: 1, month: 2, day: 1 }), null); // festival
  assert.strictEqual(cm.yearNameOf(c, 1369), 'Year of the Gauntlet');
  assert.strictEqual(cm.validateDate(c, { year: 1370, month: 3, day: 30 }).ok, true);
  assert.strictEqual(cm.validateDate(c, { year: 1370, month: 2, day: 2 }).ok, false); // 1-day month
});

check('cleaning is idempotent — a stored calendar re-cleans to itself', () => {
  const once  = packs.cleanCalendar(GOOD, 'test');
  const twice = packs.cleanCalendar(once, 'test');
  assert.deepStrictEqual(twice, once,
    'resolveWorldCalendar re-cleans on every read; a fixpoint keeps that free');
});


// --- 8. the baked-in default + the resolution chain ---------------------------
//
// Mirrors server.js resolveWorldCalendar. The chain is restated here rather than
// imported because server.js boots an Express app on require.

const BUILTIN = packs.cleanCalendar(packs.DEFAULT_CALENDAR, 'built-in');
const packCal = packs.cleanCalendar({ name: 'Pack Reckoning', months: [{ name: 'P', days: 20 }] }, 'pack');

function resolve(world, fromPack) {
  if (world && world.calendar) {
    const own = packs.cleanCalendar(world.calendar, 'world');
    if (own) return own;
  }
  if (world && world.calendarSource === 'builtin') return BUILTIN;
  return fromPack || BUILTIN;
}

check('the built-in default survives cleaning and has no errors or warnings', () => {
  assert.ok(BUILTIN, 'the baked-in default must be valid');
  const { errors, warnings } = cm.calendarIssues(BUILTIN);
  assert.deepStrictEqual(errors, [], 'the shipped default must not error');
  assert.deepStrictEqual(warnings, [], 'the shipped default must not even warn');
});

check("the default's arithmetic works out: 365 days, exactly 36 tendays", () => {
  assert.strictEqual(cm.yearLength(BUILTIN), 365);
  assert.strictEqual(cm.cycleYearLength(BUILTIN), 360);
  assert.strictEqual(cm.weekdays(BUILTIN).length, 10);
  assert.strictEqual(cm.cycleYearLength(BUILTIN) % cm.weekdays(BUILTIN).length, 0);
  // Every year therefore opens on the same weekday.
  const first = cm.weekdayOf(BUILTIN, { era: 'ce', year: 1, month: 1, day: 1 });
  for (const y of [2, 3, 17, 500, -40]) {
    assert.strictEqual(cm.weekdayOf(BUILTIN, { era: 'ce', year: y, month: 1, day: 1 }), first);
  }
});

check('resolution order: own → declared source → pack → built-in', () => {
  const own = { calendar: { name: 'Mine', months: [{ name: 'M', days: 10 }] } };
  assert.strictEqual(resolve(own, packCal).name, 'Mine');
  assert.strictEqual(resolve({ calendarSource: 'builtin' }, packCal).name, BUILTIN.name);
  assert.strictEqual(resolve({}, packCal).name, 'Pack Reckoning');
  assert.strictEqual(resolve({}, null).name, BUILTIN.name);
});

check('resolution NEVER returns null — every world has a calendar', () => {
  for (const w of [null, undefined, {}, { calendar: null }, { calendar: { months: [] } }, { calendarSource: 'nonsense' }]) {
    assert.ok(resolve(w, null), `resolve(${JSON.stringify(w)}) must not be null`);
  }
});

check('a broken own-calendar falls through instead of breaking the world', () => {
  assert.strictEqual(resolve({ calendar: { months: [] } }, packCal).name, 'Pack Reckoning');
});

// --- 9. errors block, warnings do not ----------------------------------------

check('errors fire only on genuinely broken arithmetic', () => {
  const codes = c => cm.calendarIssues(c).errors.map(e => e.code);
  assert.deepStrictEqual(codes({ months: [] }), ['no-months']);
  assert.ok(codes({ months: [{ name: 'X', days: 0 }] }).includes('bad-days'));
  assert.ok(codes({ months: [{ name: 'X', days: 1.5 }] }).includes('bad-days'));
  assert.ok(codes({ months: [{ name: '', days: 5 }] }).includes('blank-month'));
  assert.ok(codes({ months: [{ name: 'X', days: 5 }], eras: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }).includes('dupe-era'));
  assert.ok(codes({ months: [{ name: 'X', days: 5 }], eras: [{ id: 'a', label: 'A' }], epoch: { era: 'zz' } }).includes('epoch-era'));
});

check('an uneven week WARNS but never blocks — Earth and the old pack both fail it', () => {
  // 335-day year (the calendar this repo shipped) under a 7-day week.
  const old335 = { months: Array.from({ length: 11 }, (_, i) => ({ name: `M${i}`, days: 30 })).concat([{ name: 'Last', days: 5 }]),
                   weekdays: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] };
  const r = cm.calendarIssues(old335);
  assert.deepStrictEqual(r.errors, [], 'an uneven week must NOT block the save');
  assert.ok(r.warnings.some(w => w.code === 'week-drift'), 'but it should warn');
});

check('marking the remainder month as a festival clears the drift warning', () => {
  const months = Array.from({ length: 12 }, (_, i) => ({ name: `M${i}`, days: 28 }));
  months.push({ name: 'Fest', days: 4, intercalary: true });
  const r = cm.calendarIssues({ months, weekdays: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] });
  assert.deepStrictEqual(r.errors, []);
  assert.ok(!r.warnings.some(w => w.code === 'week-drift'), '336 counted days ÷ 7 = 48 whole weeks');
});

check('a GM short year (6 months of 20 days) is perfectly valid', () => {
  const shortYear = { months: Array.from({ length: 6 }, (_, i) => ({ name: `M${i}`, days: 20 })) };
  assert.deepStrictEqual(cm.calendarIssues(shortYear).errors, []);
  assert.strictEqual(cm.yearLength(shortYear), 120);
});

console.log(`\nworldCalendar: ${passed} checks passed.`);

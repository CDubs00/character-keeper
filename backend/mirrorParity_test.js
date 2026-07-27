// Mirror-parity harness: runs the SAME inputs through backend/calendarMath.js
// (CommonJS) and the frontend ESM mirror, asserting byte-identical results.
//
// The two files are kept in sync by hand, which is exactly the kind of
// convention that rots silently — the frontend copy had already drifted in its
// export names before this run. This makes drift a test failure instead of a
// display bug someone notices months later.

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

// The two copies live in different trees. The backend is CommonJS and requires
// directly; the frontend is ESM but sits under CRA, whose package.json has no
// "type": "module" — so Node would parse its .js as CommonJS and choke on the
// first `export`. Copying it to a .mjs in tmp makes the extension carry the
// module type. Plain file I/O: no eval, no new Function, no build step.
const BACKEND  = path.join(here, 'calendarMath.js');
const FRONTEND = path.join(here, '..', 'frontend', 'src', 'components', 'calendarMath.js');

if (!fs.existsSync(FRONTEND)) {
  console.error(`mirror parity: cannot find the frontend copy at ${FRONTEND}`);
  console.error('Fix the FRONTEND path above if your layout differs.');
  process.exit(1);
}

const shim = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'calmirror-')), 'calendarMath.mjs');
fs.copyFileSync(FRONTEND, shim);

const be = require(BACKEND);
const fe = await import(pathToFileURL(shim).href);

let checks = 0;
const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); checks++; };

// A battery of calendars covering every feature: irregular months, a 1-day
// month, multi-era, intercalary festivals, weekdays, and a year-name cycle.
const CALS = {
  plain: { epoch: { year: 1 }, months: [{ name: 'One', days: 31 }, { name: 'Two', days: 28 }, { name: 'Mid', days: 1 }, { name: 'Four', days: 30 }] },
  week:  { epoch: { year: 1 }, months: [{ name: 'One', days: 31 }, { name: 'Two', days: 28 }, { name: 'Three', days: 30 }], weekdays: ['Su', 'Mo', 'To', 'Wa', 'Th'] },
  fest:  { epoch: { year: 1 }, months: [{ name: 'A', days: 12 }, { name: 'B', days: 12 }, { name: 'C', days: 12 }, { name: 'Fest', days: 2, intercalary: true }], weekdays: ['A', 'B', 'C', 'D'] },
  multi: { epoch: { era: 'AF', year: 1 }, eras: [{ id: 'BF', label: 'Before', abbr: 'BF' }, { id: 'AF', label: 'After', abbr: 'AF' }], months: [{ name: 'One', days: 10 }, { name: 'Two', days: 10 }] },
  zod:   { epoch: { year: 1 }, months: [{ name: 'One', days: 10 }], yearNames: { cycle: ['Rat', 'Ox', 'Tiger', 'Rabbit', 'Dragon', 'Snake', 'Horse', 'Goat', 'Monkey', 'Rooster', 'Dog', 'Pig'], anchorYear: 2020 } },
  empty: { months: [] },
};

for (const [name, cal] of Object.entries(CALS)) {
  eq(fe.yearLength(cal), be.yearLength(cal), `${name}: yearLength`);
  eq(fe.cycleYearLength(cal), be.cycleYearLength(cal), `${name}: cycleYearLength`);
  eq(fe.yearAnchor(cal), be.yearAnchor(cal), `${name}: yearAnchor`);

  // Walk a wide span INCLUDING pre-epoch days — the floor-mod territory.
  for (let abs = -200; abs <= 200; abs++) {
    const d = be.fromAbsoluteDays(cal, abs);
    eq(fe.fromAbsoluteDays(cal, abs), d, `${name}: fromAbsoluteDays(${abs})`);
    if (!d) continue;
    eq(fe.toAbsoluteDays(cal, d), be.toAbsoluteDays(cal, d), `${name}: toAbsoluteDays`);
    eq(fe.toCycleDays(cal, d), be.toCycleDays(cal, d), `${name}: toCycleDays`);
    eq(fe.weekdayOf(cal, d), be.weekdayOf(cal, d), `${name}: weekdayOf @${abs}`);
    eq(fe.formatDate(cal, d), be.formatDate(cal, d), `${name}: formatDate`);
    eq(fe.validateDate(cal, d), be.validateDate(cal, d), `${name}: validateDate`);
    eq(fe.eraIndex(cal, d.era), be.eraIndex(cal, d.era), `${name}: eraIndex`);
  }

  // Year names across a wide, sign-crossing range.
  for (let y = -100; y <= 2100; y += 7) {
    eq(fe.yearNameOf(cal, y), be.yearNameOf(cal, y), `${name}: yearNameOf(${y})`);
  }

  // Comparator + diff on assorted pairs.
  const pairs = [
    [{ era: 'BF', year: 999, month: 2, day: 10 }, { era: 'AF', year: 1, month: 1, day: 1 }],
    [{ year: 1, month: 1, day: 1 }, { year: 5, month: 2, day: 3 }],
    [{ year: -3, month: 1, day: 1 }, { year: 2, month: 1, day: 1 }],
  ];
  for (const [a, b] of pairs) {
    eq(Math.sign(fe.compareDates(cal, a, b)), Math.sign(be.compareDates(cal, a, b)), `${name}: compareDates`);
    eq(fe.diffDays(cal, a, b), be.diffDays(cal, a, b), `${name}: diffDays`);
  }

  // Junk inputs must degrade identically, not diverge.
  for (const junk of [null, undefined, {}, { year: 1.5, month: 1, day: 1 }, { year: 1, month: 99, day: 1 }]) {
    eq(fe.weekdayOf(cal, junk), be.weekdayOf(cal, junk), `${name}: weekdayOf(junk)`);
    eq(fe.formatDate(cal, junk), be.formatDate(cal, junk), `${name}: formatDate(junk)`);
    eq(fe.validateDate(cal, junk), be.validateDate(cal, junk), `${name}: validateDate(junk)`);
  }
}

// The editor conveniences the frontend adds on top must agree with the shared view.
eq(fe.calMonths(CALS.plain), be.months(CALS.plain), 'calMonths ≡ months');
eq(fe.calEras(CALS.multi), be.eras(CALS.multi), 'calEras ≡ eras');
eq(fe.calWeekdays(CALS.week), be.weekdays(CALS.week), 'calWeekdays ≡ weekdays');
eq(fe.calYearCycle(CALS.zod), be.yearCycle(CALS.zod), 'calYearCycle ≡ yearCycle');

// calendarIssues must agree too — it is the rule set the editor blocks saves on.
for (const [name, cal] of Object.entries(CALS)) {
  eq(fe.calendarIssues(cal), be.calendarIssues(cal), `${name}: calendarIssues`);
}
for (const broken of [{ months: [] }, { months: [{ name: 'X', days: 0 }] },
  { months: [{ name: 'M', days: 5 }], eras: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }], epoch: { era: 'zz' } }]) {
  eq(fe.calendarIssues(broken), be.calendarIssues(broken), 'calendarIssues on broken input');
}

fs.rmSync(path.dirname(shim), { recursive: true, force: true });
// calendarIssues must agree too — it is the rule set the editor blocks saves on.
for (const [name, cal] of Object.entries(CALS)) {
  eq(fe.calendarIssues(cal), be.calendarIssues(cal), `${name}: calendarIssues`);
}
for (const broken of [{ months: [] }, { months: [{ name: 'X', days: 0 }] },
  { months: [{ name: 'M', days: 5 }], eras: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }], epoch: { era: 'zz' } }]) {
  eq(fe.calendarIssues(broken), be.calendarIssues(broken), 'calendarIssues on broken input');
}

fs.rmSync(path.dirname(shim), { recursive: true, force: true });
console.log(`mirror parity: ${checks} comparisons, backend ≡ frontend.`);

/**
 * packs.js — Lore pack manager (the "Keep" side's answer to sheets.js)
 *
 * A *pack* is to lore what a *bundle* is to a character sheet: a drop-in folder
 * that declares content the core never hardcodes. Where a bundle declares the
 * fields of a character sheet, a pack declares the **lore categories** of a
 * world (Locations, NPCs, Factions, …) and the fields each category carries.
 *
 * This mirrors sheets.js deliberately — same "seed on first boot, never
 * overwrite" mechanic, same defensive parsing — just a new noun. Packs live at
 * `<DATA_DIR>/packs/<packId>/` (under the existing /data mount, so no compose
 * change) and are seeded from a copy baked into the image on first boot.
 *
 * The core stays system-agnostic: it renders whatever the category schema
 * declares and never grows game-specific knowledge. New categories = new pack,
 * not new code.
 */

const fs   = require('fs');
const path = require('path');

// Where live (user-editable) packs live, under the data mount.
function packsDir(dataDir) {
  return process.env.PACKS_DIR || path.join(dataDir, 'packs');
}

// Where the built-in seed packs live. In Docker the Dockerfile copies repo
// `packs/` to /app/seed-packs; in local dev we fall back to the repo's packs/
// folder next to the backend so the default pack seeds without any env setup.
function seedPacksDir() {
  return process.env.SEED_PACKS_DIR || path.join(__dirname, '..', 'packs');
}

// The hardcoded fallback category set. This is the *last* line of defence: if
// the default pack is missing AND broken on disk, a world still opens with a
// sane lore structure instead of an empty rail. Kept in sync with the shipped
// default pack's categories.json.
//
// `organizations` was folded into `factions` — one umbrella for guilds, cults,
// governments and courts, rather than two categories nobody could tell apart.
// A live pack keeps whatever categories.json it already has (packs seed once and
// are never overwritten), so an existing install is unaffected.
const FALLBACK_CATEGORIES = [
  { id: 'locations',     label: 'Locations',     icon: 'map-pin',  fields: baseFields() },
  { id: 'npcs',          label: 'NPCs',          icon: 'user',     fields: baseFields() },
  { id: 'factions',      label: 'Factions',      icon: 'flag',     fields: baseFields() },
  { id: 'deities',       label: 'Deities',       icon: 'star',     fields: baseFields() },
  { id: 'events',        label: 'Events',        icon: 'calendar', fields: baseFields() },
];

function baseFields() {
  return [
    { key: 'subtitle', label: 'Subtitle',    type: 'text' },
    { key: 'body',     label: 'Description',  type: 'textarea', fog: true },
  ];
}

// Copy any built-in pack that isn't already in the live packs dir. Never
// overwrites one the user already has, so edits and drop-ins persist — exactly
// like seedBundles() in sheets.js.
function seedPacks(dataDir) {
  const target  = packsDir(dataDir);
  const seedDir = seedPacksDir();
  if (!fs.existsSync(seedDir)) return;
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(seedDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;           // packs are folders
    const dest = path.join(target, entry.name);
    if (fs.existsSync(dest)) continue;            // already there — leave it alone
    fs.cpSync(path.join(seedDir, entry.name), dest, { recursive: true });
    console.log(`[packs] Seeded built-in pack: ${entry.name}`);
  }
}

// Boot-time entry point, called once from server.js like sheets.scanBundles().
function scanPacks(dataDir) {
  seedPacks(dataDir);
  const dir = packsDir(dataDir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log('[packs] Created packs directory');
  }
}

// ---------------------------------------------------------------------------
// Defensive category loading
//
// Packs are the owner's own today (trusted), but the loader is built hostile-
// ready: we validate the shape, ignore unknown keys, and fall back + log on any
// breakage rather than trusting arbitrary JSON. When packs become shareable
// this is already the safe path.
// ---------------------------------------------------------------------------

// `calendar-date` (§4.11) lets a category declare an in-world date field (the
// Events category uses `start`/`end`). Its value is a structured
// { era, year, month, day } object validated against the world's calendar on
// save — never a formatted string. Degrades to absent/read-only if the pack has
// no calendar.json.
const ALLOWED_FIELD_TYPES = new Set(['text', 'textarea', 'calendar-date']);
const ID_RE = /^[a-z0-9-]{1,60}$/;

// The BAKED-IN default calendar — the last resort in the resolution chain, so a
// world ALWAYS has a usable calendar (world's own → its declared source → pack →
// this). §4.11 originally returned null for "no calendar" on the grounds that an
// invented calendar is worse than none. That was right when nobody could edit it:
// a wrong calendar was an unfixable silent lie. Now the GM can edit or replace it,
// so this is a starting point rather than a lie, and "every world has a calendar"
// removes a whole class of degraded-state handling.
//
// Deliberately built so the arithmetic works out: 12 months x 30 days = 360 days
// riding the week, which is exactly 36 tendays, so every year starts on the same
// weekday. The 5-day Midyear festival is intercalary — it sits OUTSIDE the week
// and absorbs the remainder, which is the trick real fantasy calendars use. Total
// year: 365 days.
const DEFAULT_CALENDAR = {
  name: 'Common reckoning',
  epoch: { era: 'ce', year: 1 },
  eras: [{ id: 'ce', label: 'Common Era', abbr: 'CE' }],
  months: [
    { name: 'Deepwinter',  days: 30 },
    { name: 'Thawing',     days: 30 },
    { name: 'Seedtime',    days: 30 },
    { name: 'Blooming',    days: 30 },
    { name: 'Highsun',     days: 30 },
    { name: 'Sunpeak',     days: 30 },
    { name: 'Midyear',     days: 5, intercalary: true },   // the festival block
    { name: 'Harvesting',  days: 30 },
    { name: 'Fading',      days: 30 },
    { name: 'Firstfrost',  days: 30 },
    { name: 'Longnight',   days: 30 },
    { name: 'Starfall',    days: 30 },
    { name: 'Yearsend',    days: 30 },
  ],
  weekdays: ['Sunsday', 'Moonsday', 'Toilsday', 'Waterday', 'Thundsday',
             'Fireday', 'Starday', 'Stoneday', 'Windsday', 'Restday'],
  yearNames: null,
};

// Calendar size ceilings. A world's own calendar is stored INLINE on the world
// record, and worlds.json is read whole on every world lookup — so these bound
// the hot path against a GM pasting something enormous. Generous enough that no
// real calendar hits them (Harptos has 12 months; the sexagenary cycle has 60).
const MAX_MONTHS     = 60;
const MAX_ERAS       = 40;
const MAX_WEEKDAYS   = 40;
const MAX_YEAR_NAMES = 120;

// Sanitize a single field definition. Returns a clean field object or null if
// it's unusable (so the caller can drop it).
function cleanField(f) {
  if (!f || typeof f !== 'object') return null;
  if (typeof f.key !== 'string' || !ID_RE.test(f.key)) return null;
  const type = ALLOWED_FIELD_TYPES.has(f.type) ? f.type : 'text';
  return {
    key:   f.key,
    label: typeof f.label === 'string' ? f.label.slice(0, 80) : f.key,
    type,
    // fog only means anything on a textarea; store the boolean either way.
    fog:   f.fog === true,
  };
}

// Sanitize a single category definition. Returns a clean category or null.
function cleanCategory(c) {
  if (!c || typeof c !== 'object') return null;
  if (typeof c.id !== 'string' || !ID_RE.test(c.id)) return null;
  const fields = Array.isArray(c.fields)
    ? c.fields.map(cleanField).filter(Boolean)
    : [];
  const out = {
    id:     c.id,
    label:  typeof c.label === 'string' ? c.label.slice(0, 60) : c.id,
    icon:   typeof c.icon === 'string' ? c.icon.slice(0, 40) : 'file',
    fields,
  };
  // Schema hook only (CLAUDE.md §4e): a category MAY declare an optional
  // `references` field pointing at reference-tier (stamped) entries for inline
  // stat-block cards. The reference tier doesn't exist yet, so we DON'T build any
  // UI or resolution — we just carry the declaration through untouched so the
  // loader "doesn't choke on it" and NPCs/Deities stay structurally ready.
  if (Array.isArray(c.references)) out.references = c.references;
  return out;
}

// Resolve a packId to its category array. Falls back to the built-in default
// set on any missing/broken pack and logs — a world never opens category-less.
function loadCategories(dataDir, packId) {
  const safe = typeof packId === 'string' && ID_RE.test(packId) ? packId : 'default';
  const file = path.join(packsDir(dataDir), safe, 'categories.json');

  if (!fs.existsSync(file)) {
    console.warn(`[packs] categories.json missing for pack '${safe}' — using fallback set`);
    return FALLBACK_CATEGORIES;
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.warn(`[packs] categories.json for pack '${safe}' is invalid JSON (${e.message}) — using fallback set`);
    return FALLBACK_CATEGORIES;
  }

  if (!Array.isArray(raw)) {
    console.warn(`[packs] categories.json for pack '${safe}' is not an array — using fallback set`);
    return FALLBACK_CATEGORIES;
  }

  const cleaned = raw.map(cleanCategory).filter(Boolean);
  if (cleaned.length === 0) {
    console.warn(`[packs] pack '${safe}' produced no valid categories — using fallback set`);
    return FALLBACK_CATEGORIES;
  }
  return cleaned;
}

// ---------------------------------------------------------------------------
// Defensive calendar loading (§4.11)
//
// A pack MAY declare an in-world calendar in `packs/<packId>/calendar.json`. It's
// OPTIONAL: a pack without one simply has no calendar (calendar-date fields then
// degrade to read-only). Loaded like categories.json but with a crucial
// difference — on missing/broken we return NULL, never a fallback calendar. A
// wrong invented calendar would silently mis-date every Event; "no calendar" is
// the honest, safe result. Broken files are logged; a plain missing file is the
// normal optional-absent case and stays quiet.
// ---------------------------------------------------------------------------

// Clean one month: { name, days, intercalary? } with days a positive int.
// Returns null if unusable.
//
// `intercalary: true` marks a festival month that sits OUTSIDE the week cycle
// (see calendarMath). It is omitted rather than stored as false, so a plain
// month stays byte-identical to what earlier versions wrote.
function cleanMonth(m) {
  if (!m || typeof m !== 'object') return null;
  const days = Number.isInteger(m.days) ? m.days : (Number.isInteger(Number(m.days)) ? Number(m.days) : null);
  if (!Number.isInteger(days) || days < 1) return null;
  const out = { name: typeof m.name === 'string' && m.name.trim() ? m.name.trim().slice(0, 60) : 'Month', days };
  if (m.intercalary === true) out.intercalary = true;
  return out;
}

// Clean one era: { id, label, abbr }. id must pass ID_RE. Returns null if unusable.
function cleanEra(e) {
  if (!e || typeof e !== 'object') return null;
  if (typeof e.id !== 'string' || !ID_RE.test(e.id)) return null;
  return {
    id:    e.id,
    label: typeof e.label === 'string' ? e.label.slice(0, 60) : e.id,
    abbr:  typeof e.abbr === 'string' ? e.abbr.slice(0, 12) : e.id,
  };
}

// Validate + normalize a raw calendar object into the shape calendarMath expects,
// or null if it is unusable. `label` only tags the log lines with where the data
// came from ("pack 'default'" / "world 'brinemark-x1'").
//
// This is the ONE validator for calendars. A GM-authored calendar (PUT
// /api/worlds/:id/calendar) and a pack's calendar.json both come through here, so
// the two can never drift on what they accept — the same reason cleanCategoryConfig
// validates against the real category list rather than trusting the client.
//
// CAPS mirror the rest of the loader. Sizes are bounded because a world calendar
// is stored inline on the world record in worlds.json, which is read whole on
// every world lookup: a paste can't bloat the hot path.
function cleanCalendar(raw, label) {
  const where = label ? ` (${label})` : '';

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    console.warn(`[packs] calendar${where} is not an object — no calendar`);
    return null;
  }

  // Months are the required spine: without at least one, the calendar is unusable.
  const monthsRaw = Array.isArray(raw.months) ? raw.months : [];
  const monthsClean = monthsRaw.slice(0, MAX_MONTHS).map(cleanMonth).filter(Boolean);
  if (monthsClean.length === 0) {
    console.warn(`[packs] calendar${where} has no valid months — no calendar`);
    return null;
  }

  // v1 explicitly does NOT support leap rules — ignore + log rather than half-implement.
  if ('leap' in raw) {
    console.warn(`[packs] calendar${where} declares 'leap' — ignored (no leap support in v1)`);
  }

  const eras = Array.isArray(raw.eras) ? raw.eras.slice(0, MAX_ERAS).map(cleanEra).filter(Boolean) : [];
  const weekdays = Array.isArray(raw.weekdays)
    ? raw.weekdays.slice(0, MAX_WEEKDAYS).filter(w => typeof w === 'string' && w.trim()).map(w => w.trim().slice(0, 40))
    : [];

  const epoch = {};
  if (raw.epoch && typeof raw.epoch === 'object') {
    if (Number.isInteger(raw.epoch.year)) epoch.year = raw.epoch.year;
    if (typeof raw.epoch.era === 'string' && eras.some(e => e.id === raw.epoch.era)) epoch.era = raw.epoch.era;
  }

  // Cyclical year names, zodiac-style: a repeating list anchored to a year, so
  // year + cycleLength always carries the same name. Sparse per-year naming
  // ("1369 = Year of the Gauntlet") is deliberately NOT supported — a cycle
  // covers the asked-for case for the price of one array, and an unbounded
  // year→name map on an inline record is exactly the bloat the caps above avoid.
  // An empty/garbage cycle drops the whole block rather than storing a stub.
  let yearNames = null;
  if (raw.yearNames && typeof raw.yearNames === 'object' && !Array.isArray(raw.yearNames)) {
    const cycle = Array.isArray(raw.yearNames.cycle)
      ? raw.yearNames.cycle.slice(0, MAX_YEAR_NAMES)
          .filter(n => typeof n === 'string' && n.trim())
          .map(n => n.trim().slice(0, 60))
      : [];
    if (cycle.length) {
      yearNames = { cycle };
      if (Number.isInteger(raw.yearNames.anchorYear)) yearNames.anchorYear = raw.yearNames.anchorYear;
    }
  }

  return {
    name:   typeof raw.name === 'string' ? raw.name.slice(0, 80) : 'Calendar',
    epoch,
    eras,                       // [] ⇒ a single implicit era (no selector shown)
    months: monthsClean,
    weekdays,                   // [] ⇒ no weekday shown (never invented)
    yearNames,                  // null ⇒ no year-name cycle (never invented)
  };
}

function loadCalendar(dataDir, packId) {
  const safe = typeof packId === 'string' && ID_RE.test(packId) ? packId : 'default';
  const file = path.join(packsDir(dataDir), safe, 'calendar.json');

  if (!fs.existsSync(file)) return null;   // optional — the common "no calendar" case

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.warn(`[packs] calendar.json for pack '${safe}' is invalid JSON (${e.message}) — no calendar`);
    return null;
  }
  return cleanCalendar(raw, `pack '${safe}'`);
}

// ---------------------------------------------------------------------------
// Per-world category overrides (display-only rename + hide)
//
// A world may rename a lore category ("Deities" → "Powers") or hide one entirely
// ("Events") for ITS OWN rail — without touching the shared pack. The override
// lives on the world record as `categoryConfig` (app-owned), keyed by category
// id. It is DISPLAY-ONLY: the category `id` never changes, so every entry's
// `categoryId` and all `[[wiki]]` link resolution keep working, and hiding is
// non-destructive (entries stay on disk and stay resolvable; the category is
// just dropped from the rail).
// ---------------------------------------------------------------------------

// Merge a world's overrides onto its pack categories FOR RENDERING. Returns every
// category (hidden ones included, flagged) so the customize UI can list them all.
// Never changes `id`. Tolerates a missing/garbage `config`.
function applyCategoryConfig(categories, config) {
  const cfg = config && typeof config === 'object' ? config : {};
  return (Array.isArray(categories) ? categories : []).map(c => {
    const o = cfg[c.id] && typeof cfg[c.id] === 'object' ? cfg[c.id] : {};
    const override = typeof o.label === 'string' && o.label.trim() ? o.label.trim() : null;
    return {
      ...c,
      label:     override || c.label,   // shown label: override, else pack base
      baseLabel: c.label,               // pack original, always preserved for the UI
      hidden:    o.hidden === true,
    };
  });
}

// Validate client-supplied overrides against the world's REAL (un-merged)
// categories, mirroring cleanCategory/cleanField's defensive posture. Drops
// unknown ids; trims + caps labels to the 60-char ceiling; drops a label equal to
// the base (or empty) so a no-op override isn't stored; coerces `hidden` to a
// boolean; omits an override that ends up carrying nothing.
function cleanCategoryConfig(raw, categories) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const byId = new Map((Array.isArray(categories) ? categories : []).map(c => [c.id, c]));
  const out = {};
  for (const id of Object.keys(cfg)) {
    const base = byId.get(id);
    if (!base) continue;                              // unknown id — drop
    const o = cfg[id] && typeof cfg[id] === 'object' ? cfg[id] : {};
    const entry = {};
    if (typeof o.label === 'string') {
      const label = o.label.trim().slice(0, 60);
      if (label && label !== base.label) entry.label = label;   // else no-op — drop
    }
    if (o.hidden === true) entry.hidden = true;       // false is the default — omit
    if (Object.keys(entry).length) out[id] = entry;   // omit empty overrides
  }
  return out;
}

module.exports = {
  scanPacks, loadCategories, loadCalendar, cleanCalendar, packsDir, FALLBACK_CATEGORIES,
  DEFAULT_CALENDAR,
  applyCategoryConfig, cleanCategoryConfig,
};

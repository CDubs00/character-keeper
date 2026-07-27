/**
 * systemRef.js — the STAMPED system-reference tier (Wave C).
 *
 * The fourth tier. World / Campaign / Session are system-agnostic; this one is
 * not — every entry carries a `systemId` stamp naming the ruleset it was written
 * for. That stamp is what makes the other three detachable: swap SWADE for 5e and
 * the lore, the campaign and the session log are untouched, and only this tier
 * needs re-entering.
 *
 * WHERE THE FIELD SHAPES COME FROM — the load-bearing decision:
 *
 *   The CHARACTER-SHEET BUNDLE already declares them. `savage-pathfinder/
 *   schema.json` ships `emptyEdge`, `emptyPower`, `emptyWeapon`, … because the
 *   sheet needs them to add a row. An Edge in the compendium and an Edge on a
 *   character sheet have the SAME shape, so declaring it twice would guarantee
 *   drift. There is deliberately NO parallel "compendium" manifest block.
 *
 *   So: a bundle names which of its `empty*` blocks are shared reference
 *   (`sysrefTypes`), and this module turns each one into a category definition in
 *   EXACTLY the shape packs.js produces for lore categories. That shape-identity
 *   is not cosmetic — it is why serializeEntryForRole, the fog stripper and the
 *   generic entry form all work on system entries with zero new code.
 *
 * Core stays system-agnostic. Nothing here knows what an Edge is; it knows that
 * the bundle declared a block called `emptyEdge` with string-valued keys, and it
 * renders what it was told. New system = new bundle, not new code.
 */

const sheets = require('./sheets');

// Field keys here may contain underscores (`power_points`), unlike pack-authored
// category keys which are hyphen-only. These keys come from a bundle's `empty*`
// block and are never used as a path segment or an id — only as an object key in
// `entry.fields` and a form input name — so the looser set is safe and it avoids
// mangling a bundle's own vocabulary.
const KEY_RE  = /^[a-z0-9_-]{1,60}$/i;
const TYPE_RE = /^[a-z0-9-]{1,60}$/;

// The field types a bundle may declare. Deliberately the same two the lore side
// supports, so the shared entry form needs no new input kind.
const FIELD_TYPES = new Set(['text', 'textarea']);

// Keys whose value is prose rather than a stat. Generic English words, not game
// terms. This is only a DEFAULT GUESS: a bundle that uses different words (a
// Pathfinder feat's `benefit`, a GURPS advantage's `effects`) declares them in
// `sysrefFields` and the guess is overridden. Without that escape hatch this list
// would be exactly the kind of core hardcoding that forces "new system = new
// code", since the author's only fix would be to get a word added here.
const PROSE_KEYS = new Set([
  'description', 'notes', 'effect', 'effects', 'summary', 'text', 'body',
  'details', 'special', 'abilities', 'trappings', 'requirements',
]);

// NOTE: there is deliberately no auto-appended "GM notes" field. An earlier cut
// added one to every type so a GM always had somewhere fog-capable to write. It
// was redundant: ||fog|| works inside the DESCRIPTION (and any other prose field
// the bundle declares), so a GM annotates the statblock in place — beside the
// thing being annotated — instead of in a second box at the bottom. Fog capability
// is now purely the bundle's declaration, which is also what makes `fog: false` in
// `sysrefFields` mean something. Every SHIPPED bundle is asserted to declare at
// least one fog-capable field per type (see systemRef_test.js).

// One field-presentation override from a bundle's `sysrefFields`. Accepts either
// the shorthand `"benefit": "textarea"` or the full
// `"benefit": { type, fog, label }`. Returns null for anything unusable, so a
// malformed override degrades to the derived default rather than breaking a type.
function cleanFieldOverride(raw) {
  if (typeof raw === 'string') {
    return FIELD_TYPES.has(raw) ? { type: raw } : null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  if (FIELD_TYPES.has(raw.type)) out.type = raw.type;
  if (typeof raw.fog === 'boolean') out.fog = raw.fog;      // `false` must be honoured
  if (typeof raw.label === 'string' && raw.label.trim()) out.label = raw.label.slice(0, 80);
  return Object.keys(out).length ? out : null;
}

// Apply a type's overrides to its derived fields. Overrides may only RESHAPE a
// field the empty* block already declares — they can't invent one. The shape is
// the bundle's single source of truth (that is the whole §5 decision); letting a
// presentation map add fields would quietly create a second, competing one.
function applyFieldOverrides(fields, overrides, typeId) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return fields;
  const known = new Set(fields.map(f => f.key));
  for (const key of Object.keys(overrides)) {
    if (!known.has(key)) {
      console.warn(`[sysref] sysrefFields.${typeId}.${key} is not a field of ${emptyKeyFor(typeId)} — ignored`);
    }
  }
  return fields.map((f) => {
    const ov = cleanFieldOverride(overrides[f.key]);
    if (!ov) return f;
    const next = { ...f, ...ov };
    // Fog is only meaningful on a textarea: a stat line is one value, and a `||`
    // in it is a typo far more often than a secret. If a bundle asks for fog
    // without asking for a textarea, honour the intent and promote the field.
    if (next.fog && next.type !== 'textarea') next.type = 'textarea';
    return next;
  });
}

// 'edge' → 'Edge'; 'gm_notes' → 'Gm notes'. Presentation only.
function titleCase(key) {
  const spaced = String(key).replace(/[_-]+/g, ' ').trim();
  return spaced ? spaced[0].toUpperCase() + spaced.slice(1) : '';
}

// Naive English plural for the rail label ('Edge' → 'Edges', 'Ability' →
// 'Abilities'). A bundle can override any of this by declaring `sysrefLabels`.
function pluralize(word) {
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  return `${word}s`;
}

// `emptyEdge` → 'edge'. Returns null for anything that isn't an empty* block.
function typeIdFromKey(key) {
  const m = /^empty([A-Za-z0-9]+)$/.exec(key);
  if (!m) return null;
  const id = m[1].replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  return TYPE_RE.test(id) ? id : null;
}

// 'edge' → 'emptyEdge'; 'special-ability' → 'emptySpecialAbility'.
function emptyKeyFor(typeId) {
  const camel = String(typeId)
    .split('-')
    .map((part, i) => (i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('');
  return `empty${camel.charAt(0).toUpperCase()}${camel.slice(1)}`;
}

// Turn one `empty*` block into the field list for that type.
//
// Only scalar-valued keys become fields: a nested object or array has no generic
// editor, and inventing one would be the first crack in "core knows no game
// rules". A bundle wanting a structured sub-record flattens it in its own
// `empty*` block. `name` is skipped because every entry carries an implicit
// name — exactly as a lore category does.
function fieldsFromEmpty(empty) {
  const fields = [];
  if (!empty || typeof empty !== 'object' || Array.isArray(empty)) return fields;
  for (const [key, value] of Object.entries(empty)) {
    if (key === 'name') continue;
    if (!KEY_RE.test(key)) continue;                      // unusable as a field key
    if (value !== null && typeof value === 'object') continue;   // no generic editor
    const prose = PROSE_KEYS.has(key.toLowerCase());
    fields.push({
      key,
      label: titleCase(key),
      type:  prose ? 'textarea' : 'text',
      // Prose fields carry fog; a stat line ("d6", "3/6/12") has no use for it
      // and a fog delimiter there is far more likely to be a typo than intent.
      fog:   prose,
    });
  }
  return fields;
}

// Which type ids this schema offers — ONLY what `sysrefTypes` declares.
//
// There used to be a fallback that derived types from every `empty*` block when a
// bundle declared none, so an older bundle would "still get something". It was
// removed: it meant EVERY sheet bundle implicitly offered a compendium, so
// "systems with a package" described all of them and the system picker listed
// every sheet in the app. It also produced junk — the 5e sheet yielded
// `Resources`, `Treasures`, `Allies` (per-character bookkeeping) and pluralised
// `Equipment` to `Equipments`.
//
// One rule now: a bundle offers a system reference IFF it declares `sysrefTypes`.
// Declaring is cheap, explicit, and it makes "has a package" a real distinction.
function typeIdsFor(schema) {
  if (!schema || !Array.isArray(schema.sysrefTypes)) return [];
  return schema.sysrefTypes.filter(t => typeof t === 'string' && TYPE_RE.test(t));
}

// Does this bundle declare a system package at all? The one question the system
// picker asks, so it lists only bundles a world can actually be stamped with.
function declaresPackage(schema) {
  return typesFromSchema(schema).length > 0;
}

// Build the category-shaped type list for one bundle schema. Pure — takes the
// parsed schema, returns an array. Exported for the tests, which must not need a
// data dir or a registry on disk.
function typesFromSchema(schema) {
  if (!schema || typeof schema !== 'object') return [];
  const labels = (schema.sysrefLabels && typeof schema.sysrefLabels === 'object')
    ? schema.sysrefLabels
    : {};
  const icons = (schema.sysrefIcons && typeof schema.sysrefIcons === 'object')
    ? schema.sysrefIcons
    : {};
  // Per-type field presentation overrides — the author's escape hatch from the
  // PROSE_KEYS guess below.
  const overrides = (schema.sysrefFields && typeof schema.sysrefFields === 'object')
    ? schema.sysrefFields
    : {};

  const out = [];
  const seen = new Set();
  for (const typeId of typeIdsFor(schema)) {
    if (seen.has(typeId)) continue;
    const empty = schema[emptyKeyFor(typeId)];
    // A declared type with no matching empty* block has no shape. Skipping it is
    // the fail-closed answer: an entry form with no fields would let a GM author
    // a record that silently holds nothing.
    if (!empty || typeof empty !== 'object' || Array.isArray(empty)) {
      console.warn(`[sysref] type '${typeId}' declared but ${emptyKeyFor(typeId)} is missing — skipped`);
      continue;
    }
    seen.add(typeId);
    const fields = applyFieldOverrides(fieldsFromEmpty(empty), overrides[typeId], typeId);
    out.push({
      id:    typeId,
      label: typeof labels[typeId] === 'string'
        ? labels[typeId].slice(0, 60)
        : pluralize(titleCase(typeId)),
      // 'file' is the frontend's generic fallback glyph. Naming it explicitly
      // beats a plausible-sounding default like 'book' that no icon map has —
      // that just looks like a broken lookup. Bundles pick from the documented
      // glyph list (CLAUDE.md §4.12); an unknown name falls back to this anyway.
      icon:  typeof icons[typeId] === 'string' ? icons[typeId].slice(0, 40) : 'file',
      fields,
    });
  }
  // DECLARATION ORDER IS PRESERVED — deliberately not sorted. `sysrefTypes` is an
  // ordered list, and a rulebook's order is meaningful (Skills → Edges →
  // Hindrances → gear → Powers → Bestiary mirrors how the book and the character
  // sheet are laid out). Alphabetising threw that away and put the Bestiary
  // second. A bundle that wants alphabetical simply declares it that way.
  return out;
}

// Resolve a world's primarySystemId to its type list. Defensive in the house
// style (loadCategories/loadCalendar): a missing or broken bundle returns null —
// "this world has no system" — rather than an invented fallback. A wrong
// compendium schema is worse than none, and unlike categories there is no honest
// default: nobody's rules are the generic rules.
function loadSystemTypes(dataDir, systemId) {
  if (!systemId || typeof systemId !== 'string') return null;
  let schema;
  try {
    schema = sheets.loadSchema(dataDir, systemId);
  } catch (e) {
    console.warn(`[sysref] bundle '${systemId}' not loadable (${e.message}) — world has no system reference`);
    return null;
  }
  const types = typesFromSchema(schema);
  if (types.length === 0) {
    console.warn(`[sysref] bundle '${systemId}' declares no usable reference types`);
    return null;
  }
  return types;
}

module.exports = {
  typesFromSchema, loadSystemTypes, fieldsFromEmpty, typeIdsFor,
  applyFieldOverrides, cleanFieldOverride, declaresPackage,
  PROSE_KEYS, FIELD_TYPES,
};

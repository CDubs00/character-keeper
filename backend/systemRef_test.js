// backend/systemRef_test.js
//
// Tests for the stamped system-reference tier's schema derivation (Wave C). No
// test framework — plain `assert`, run with `node systemRef_test.js`, exit
// non-zero on first failure. Matches loreAccess_test.js / calendarMath_test.js.
//
// What matters here is that the tier stays SYSTEM-AGNOSTIC in core and
// SHAPE-IDENTICAL to a lore category:
//   1. Types and their fields come from the bundle's own `empty*` blocks.
//   2. The output is exactly the shape packs.js emits, so serializeEntryForRole,
//      canSee and the fog stripper work on system entries with no new code —
//      which is verified here against the REAL functions, not a mirror.
//   3. Fog capability comes from the BUNDLE's own prose fields — core appends
//      nothing. Every shipped bundle is asserted to declare at least one, so a GM
//      annotation on a shared statblock always has somewhere to live.
//   4. `[[sys:…]]` links parse into a namespace and round-trip byte-identically.

const assert = require('assert');
const { typesFromSchema, fieldsFromEmpty, typeIdsFor, declaresPackage } = require('./systemRef');
const { serializeEntryForRole, canSee, stripFog, parseBody } = require('./loreAccess');

let passed = 0;
function check(msg, fn) {
  fn();
  passed++;
  console.log(`  ok  ${msg}`);
}

// A miniature bundle schema. Deliberately NOT a real ruleset: the point is that
// core derives from whatever the bundle declares.
const SCHEMA = {
  emptyCharacter: { info: {}, skills: [] },      // per-character, never reference
  emptySession:   { date: '', notes: '' },       // per-character sidecar
  emptyEdge:      { name: '', description: '' },
  emptyWeapon:    { name: '', damage: '', rof: '', notes: '' },
  emptySkill:     { name: '', attribute: 'Agility', die: { die: 'd4' }, description: '' },
  sysrefTypes:  ['edge', 'weapon', 'skill'],
  sysrefLabels: { edge: 'Edges' },
};

console.log('\nsystemRef');

// --- 1. derivation ----------------------------------------------------------

check('declared sysrefTypes are honoured verbatim', () => {
  assert.deepStrictEqual(typeIdsFor(SCHEMA), ['edge', 'weapon', 'skill']);
});

// The single rule, and the reason the old fallback was removed: it derived types
// from every empty* block when a bundle declared none, which meant EVERY sheet
// bundle implicitly offered a compendium. "Systems with a package" then described
// all of them, the picker listed every character sheet in the app, and the derived
// junk included per-character bookkeeping (Resources, Treasures, Allies).
check('a bundle with no sysrefTypes offers NO system — declare or nothing', () => {
  const { sysrefTypes, ...noDecl } = SCHEMA;
  assert.deepStrictEqual(typeIdsFor(noDecl), []);
  assert.deepStrictEqual(typesFromSchema(noDecl), []);
  assert.strictEqual(declaresPackage(noDecl), false);
  assert.strictEqual(declaresPackage(SCHEMA), true);
});

check('declaresPackage is false for junk, never throws', () => {
  for (const bad of [null, undefined, 'nope', 42, [], {}, { sysrefTypes: 'edge' }]) {
    assert.strictEqual(declaresPackage(bad), false, JSON.stringify(bad));
  }
});

check('a declared type whose empty* block is missing does not count as a package', () => {
  assert.strictEqual(declaresPackage({ sysrefTypes: ['ghost'] }), false);
});

check('fields come from the empty block; name is implicit and skipped', () => {
  const keys = fieldsFromEmpty(SCHEMA.emptyWeapon).map(f => f.key);
  assert.deepStrictEqual(keys, ['damage', 'rof', 'notes']);
});

check('non-scalar values are skipped — core invents no editor for them', () => {
  const keys = fieldsFromEmpty(SCHEMA.emptySkill).map(f => f.key);
  assert.ok(!keys.includes('die'), 'the nested die object must not become a field');
  assert.deepStrictEqual(keys, ['attribute', 'description']);
});

check('a declared type with no empty block is skipped, not shipped field-less', () => {
  const types = typesFromSchema({ ...SCHEMA, sysrefTypes: ['edge', 'ghost'] });
  assert.deepStrictEqual(types.map(t => t.id), ['edge']);
});

// Rail order is the bundle author's call. Core sorted alphabetically at first,
// which put the Bestiary second and ignored the fact that `sysrefTypes` is an
// ORDERED list mirroring how the rulebook and the character sheet are laid out.
// The fixture's declared order is deliberately NOT alphabetical by id or label,
// so a re-introduced sort fails here.
check('declaration order is preserved, not alphabetised', () => {
  const ids = typesFromSchema({
    emptySkill: { name: '', description: '' },
    emptyEdge:  { name: '', description: '' },
    emptyAmmo:  { name: '', description: '' },
    sysrefTypes: ['skill', 'edge', 'ammo'],
    sysrefLabels: { skill: 'Zeta', edge: 'Alpha', ammo: 'Mu' },
  }).map(t => t.id);
  assert.deepStrictEqual(ids, ['skill', 'edge', 'ammo']);
});

check('sysrefLabels override, others fall back to a pluralised title', () => {
  const byId = Object.fromEntries(typesFromSchema(SCHEMA).map(t => [t.id, t.label]));
  assert.strictEqual(byId.edge,   'Edges');      // declared
  assert.strictEqual(byId.weapon, 'Weapons');    // derived
});

check('garbage schemas fail closed to an empty list, never throw', () => {
  for (const bad of [null, undefined, 'nope', 42, [], {}]) {
    assert.deepStrictEqual(typesFromSchema(bad), [], `typesFromSchema(${JSON.stringify(bad)})`);
  }
});

// --- 2. shape-identity with lore categories ---------------------------------

check('output is category-shaped: { id, label, icon, fields[{key,label,type,fog}] }', () => {
  for (const t of typesFromSchema(SCHEMA)) {
    assert.deepStrictEqual(Object.keys(t).sort(), ['fields', 'icon', 'id', 'label']);
    for (const f of t.fields) {
      assert.deepStrictEqual(Object.keys(f).sort(), ['fog', 'key', 'label', 'type']);
      assert.ok(['text', 'textarea'].includes(f.type), `unexpected field type ${f.type}`);
      assert.strictEqual(typeof f.fog, 'boolean');
    }
  }
});

// --- 3. fog ------------------------------------------------------------------

check('a declared prose field is fog-capable', () => {
  for (const t of typesFromSchema(SCHEMA)) {
    assert.ok(t.fields.some(f => f.fog), `type '${t.id}' has nowhere to write GM-only notes`);
  }
});

// Core appends NOTHING. A bundle whose type is all stat lines gets exactly those
// fields and no fog — the GM's answer is to declare a description (or mark a field
// fog via sysrefFields), not to receive a bolted-on box they didn't ask for.
check('core adds no fields of its own — the empty* block is the whole shape', () => {
  const [t] = typesFromSchema({ emptyToken: { name: '', code: '' }, sysrefTypes: ['token'] });
  assert.deepStrictEqual(t.fields.map(f => f.key), ['code']);
  assert.ok(!t.fields.some(f => f.key === 'gm_notes'), 'no auto-appended GM notes field');
});

check('stat lines are NOT fog-capable — a || there is a typo, not a secret', () => {
  const weapon = typesFromSchema(SCHEMA).find(t => t.id === 'weapon');
  assert.strictEqual(weapon.fields.find(f => f.key === 'damage').fog, false);
  assert.strictEqual(weapon.fields.find(f => f.key === 'notes').fog,  true);
});

// The real reason the shapes must match: the live serializer must strip fog from
// a system entry with no code of its own. Exercises the REAL function.
check('serializeEntryForRole strips fog from a system entry for a read member', () => {
  const types = typesFromSchema(SCHEMA);
  const entry = {
    id: 'ankheg-abc12', worldId: 'w1', systemId: 'swade', categoryId: 'weapon',
    name: 'Bite', visibility: 'shared',
    fields: { damage: 'Str+d6', notes: 'Nasty. ||Actually a construct.||' },
  };
  const asPlayer = serializeEntryForRole(entry, 'read', types);
  assert.strictEqual(asPlayer.fields.notes, 'Nasty. ');
  assert.strictEqual(asPlayer.fields.damage, 'Str+d6');
  assert.strictEqual(serializeEntryForRole(entry, 'owner', types), entry, 'GM gets it raw');
  assert.strictEqual(serializeEntryForRole(entry, 'coGM', types), entry, 'coGM gets it raw');
});

check('an unknown type fails CLOSED — every string field is stripped', () => {
  const entry = {
    categoryId: 'from-a-system-no-longer-installed', name: 'Orphan', visibility: 'shared',
    fields: { damage: 'Str+d6 ||secret||' },
  };
  assert.strictEqual(serializeEntryForRole(entry, 'read', []).fields.damage, 'Str+d6 ');
});

check('per-entry visibility governs system entries exactly as it governs lore', () => {
  assert.strictEqual(canSee('read',  'hidden'), false, 'an unpublished monster stays GM-only');
  assert.strictEqual(canSee('read',  'shared'), true);
  assert.strictEqual(canSee('coGM',  'hidden'), true);
  assert.strictEqual(canSee(null,    'shared'), false);
});

// --- 4. the sys: link namespace ---------------------------------------------

const linksIn = s => parseBody(s).filter(t => t.type === 'link');

check('[[sys:X]] parses into the sys namespace with X as the target', () => {
  const [l] = linksIn('Fight the [[sys:Ankheg]].');
  assert.strictEqual(l.ns, 'sys');
  assert.strictEqual(l.target, 'Ankheg');
  assert.strictEqual(l.display, 'Ankheg', 'the prefix is addressing, not display text');
  assert.strictEqual(l.name, 'sys:Ankheg', 'the raw name is preserved for round-tripping');
});

check('an ordinary link is unchanged — ns null, target === name', () => {
  const [l] = linksIn('Ask [[Durnan]].');
  assert.strictEqual(l.ns, null);
  assert.strictEqual(l.target, 'Durnan');
  assert.strictEqual(l.name, 'Durnan');
});

check('an unknown prefix is NOT a namespace — closed set, not any word+colon', () => {
  const [l] = linksIn('See [[Chapter 3: The Fall]] and [[loot: the vault]].');
  assert.strictEqual(l.ns, null, 'a colon inside a title must not become a namespace');
  assert.strictEqual(l.target, 'Chapter 3: The Fall');
  assert.strictEqual(linksIn('[[loot: the vault]]')[0].ns, null);
});

check('stripFog round-trips a sys link byte-identically', () => {
  for (const s of ['a [[sys:Ankheg]] b', '[[sys:Fear|the fear power]]', 'plain [[Durnan]]']) {
    assert.strictEqual(stripFog(s), s, `round-trip of ${s}`);
  }
});

check('a fogged sys link is dropped WHOLE — the monster name never leaks', () => {
  assert.strictEqual(stripFog('Beware ||[[sys:Ankheg]]|| tonight.'), 'Beware  tonight.');
});

// --- 5. field-presentation overrides (`sysrefFields`) ------------------------
//
// The escape hatch from the PROSE_KEYS guess. Without it, an author whose system
// names a prose field something the list doesn't know (Pathfinder's `benefit`,
// GURPS's `effects`) would get a one-line input they cannot widen and cannot fog
// — and their only fix would be to get a word added to core, which is precisely
// the "new system = new code" failure this tier exists to avoid.

check('an override promotes a guessed stat field to prose, with fog', () => {
  const [t] = typesFromSchema({
    emptyFeat: { name: '', benefit: '', prereq: '' },
    sysrefTypes: ['feat'],
    sysrefFields: { feat: { benefit: { type: 'textarea', fog: true } } },
  });
  const benefit = t.fields.find(f => f.key === 'benefit');
  assert.strictEqual(benefit.type, 'textarea');
  assert.strictEqual(benefit.fog, true);
  assert.strictEqual(t.fields.find(f => f.key === 'prereq').type, 'text', 'others untouched');
});

check('the string shorthand works', () => {
  const [t] = typesFromSchema({
    emptyFeat: { name: '', benefit: '' },
    sysrefTypes: ['feat'], sysrefFields: { feat: { benefit: 'textarea' } },
  });
  assert.strictEqual(t.fields.find(f => f.key === 'benefit').type, 'textarea');
});

check('fog:false is honoured — an author can take fog OFF a prose field', () => {
  const [t] = typesFromSchema({
    emptyItem: { name: '', description: '' },
    sysrefTypes: ['item'], sysrefFields: { item: { description: { fog: false } } },
  });
  assert.strictEqual(t.fields.find(f => f.key === 'description').fog, false);
});

check('asking for fog on a text field promotes it to a textarea', () => {
  const [t] = typesFromSchema({
    emptyItem: { name: '', price: '' },
    sysrefTypes: ['item'], sysrefFields: { item: { price: { fog: true } } },
  });
  const price = t.fields.find(f => f.key === 'price');
  assert.strictEqual(price.type, 'textarea', 'fog is meaningless on a one-line stat');
});

check('an override may RELABEL but never INVENT a field', () => {
  const [t] = typesFromSchema({
    emptyItem: { name: '', description: '' },
    sysrefTypes: ['item'],
    sysrefFields: { item: { description: { label: 'Effect' }, ghost: 'textarea' } },
  });
  assert.strictEqual(t.fields.find(f => f.key === 'description').label, 'Effect');
  assert.ok(!t.fields.some(f => f.key === 'ghost'), 'the empty* block is the only source of shape');
});

check('garbage overrides fall back to the derived default, never throw', () => {
  for (const bad of [null, 'nope', 42, [], { type: 'richtext' }, {}]) {
    const [t] = typesFromSchema({
      emptyItem: { name: '', price: '' },
      sysrefTypes: ['item'], sysrefFields: { item: { price: bad } },
    });
    assert.strictEqual(t.fields.find(f => f.key === 'price').type, 'text', String(JSON.stringify(bad)));
  }
});

// --- 6. the drop-in guarantee ------------------------------------------------
//
// A third-party bundle for a system this codebase has never heard of must yield
// a complete, correctly-presented compendium with NO change to core. This
// fixture is Pathfinder-1e-shaped on purpose — a system deliberately NOT shipped
// — so the test fails if anything about the derivation starts depending on the
// bundles that are shipped. It is a FIXTURE, not content: nothing here is a
// bundle, and no rules text is reproduced.
const THIRD_PARTY = {
  emptyCharacter: { info: {}, skills: [] },
  emptySession:   { date: '', notes: '' },
  emptyFeat:      { name: '', type: '', prerequisites: '', benefit: '', normal: '' },
  emptyMonster:   { name: '', cr: '', ac: '', hp: '', melee: '', description: '' },
  emptyMagicItem: { name: '', aura: '', price: '', description: '' },
  sysrefTypes:  ['monster', 'feat', 'magic-item'],
  sysrefLabels: { monster: 'Bestiary', 'magic-item': 'Magic Items' },
  sysrefIcons:  { monster: 'skull' },
  sysrefFields: { feat: { benefit: { type: 'textarea', fog: true }, normal: 'textarea' } },
};

check('an unknown third-party bundle drops in with no core change', () => {
  const types = typesFromSchema(THIRD_PARTY);
  const byId = Object.fromEntries(types.map(t => [t.id, t]));
  // multi-word type ids resolve to their camelCase empty* block
  assert.strictEqual(byId['magic-item'].label, 'Magic Items');
  // an undeclared label is pluralised from the id, not left blank
  assert.strictEqual(byId.feat.label, 'Feats');
  // an undeclared icon falls back to the frontend's generic glyph, not a
  // plausible-sounding name no icon map has
  assert.strictEqual(byId.feat.icon, 'file');
  // the author's presentation wins over core's guess
  assert.strictEqual(byId.feat.fields.find(f => f.key === 'benefit').type, 'textarea');
  assert.strictEqual(byId.feat.fields.find(f => f.key === 'normal').type,  'textarea');
  // per-character blocks never leak into the compendium
  assert.ok(!types.some(t => ['character', 'session'].includes(t.id)));
  // fog comes from what the author declared — the feat's benefit, the others'
  // descriptions — not from anything core bolted on
  for (const t of types) assert.ok(t.fields.some(f => f.fog), t.id);
  assert.ok(!types.some(t => t.fields.some(f => f.key === 'gm_notes')));
});

// --- 7. the SHIPPED bundles --------------------------------------------------
//
// A bundle is a character SHEET, a SYSTEM, or both. Most ship as sheet-only and
// that is a valid, expected state — so this does NOT assert that every bundle
// declares a package. What it asserts is the conditional: IF a bundle declares
// one, it must be usable, so picking it in World Settings yields a working System
// rail rather than a 400 or an empty section. Reads the real files, so a bundle
// edited into an unusable state fails here instead of in the UI.
const fs = require('fs');
const path = require('path');
const BUNDLES = path.join(__dirname, '..', 'bundles');

for (const folder of fs.readdirSync(BUNDLES)) {
  const file = path.join(BUNDLES, folder, 'schema.json');
  if (!fs.existsSync(file)) continue;
  check(`shipped bundle '${folder}' — sheet-only, or a usable compendium`, () => {
    const schema = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(schema.sysrefTypes)) return;   // sheet-only bundle — nothing to check
    const types = typesFromSchema(schema);
    assert.ok(types.length > 0,
      `${folder} declares sysrefTypes but yields no usable types`);
    for (const t of types) {
      assert.ok(t.fields.length > 0, `${folder}/${t.id} has no fields`);
      // Core no longer injects a fog field, so this is a real assertion about the
      // BUNDLE: every type must declare somewhere a GM can write ||secrets|| on a
      // statblock players can read.
      assert.ok(t.fields.some(f => f.fog), `${folder}/${t.id} declares no fog-capable field`);
      // A statblock with every field on one line is unusable at the table.
      assert.ok(t.fields.some(f => f.type === 'textarea'), `${folder}/${t.id} has no prose field`);
    }
  });
}

console.log(`\nsystemRef: ${passed} checks passed.`);

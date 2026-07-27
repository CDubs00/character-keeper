// backend/loreAccess.test.js
//
// Access-gate tests. No test framework (the backend ships none) — plain `assert`
// run with `node loreAccess.test.js`, exit non-zero on first fail.
//
// The model under test has THREE INDEPENDENT AXES (see loreAccess.js header):
//   A. capability  — member role: read < propose < coGM < owner
//   B. secrecy     — entry visibility: shared | hidden
//   C. fog         — raw ||fog|| goes to GMs (owner + coGM) only, always
// The point of most of these checks is that the axes stay independent: granting
// someone edit rights must never widen what they can SEE, and an entry's secrecy
// must never depend on anyone's capability.
//
// Covers:
//   1. canSee — full role × visibility truth table, and fail-closed on junk.
//   2. Capability predicates, incl. the owner-only structural boundary.
//   3. A read member's listing: shared only, fog-free; assets gated identically.
//   4. Fog clearance is GM-only and does NOT ride on capability.
//   5. The proposal-approval hazard: a proposer's base is always fog-stripped.
//   6. serializeEntryForRole fails CLOSED on an unknown category.
//   7. stripFog preserves unfogged links, drops fogged ones whole.
//   8. Migration from the old four-state model fails closed.

const assert = require('assert');
const {
  ROLES, ROLE_RANK, DEFAULT_ROLE, isGM,
  canEditLore, canProposeEdits, canManageWorld,
  VISIBILITY_STATES, DEFAULT_VISIBILITY, canSee,
  seesRawFog, stripFog, serializeEntryForRole,
  migrateRole, migrateVisibility,
} = require('./loreAccess');

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

// --- 1. canSee truth table ---------------------------------------------------
// GMs see both states. propose/read see `shared` only — and see IDENTICAL sets,
// because `propose` is about submitting edits, not about seeing more.
const EXPECT = {
  owner:   { shared: true,  hidden: true  },
  coGM:    { shared: true,  hidden: true  },
  propose: { shared: true,  hidden: false },
  read:    { shared: true,  hidden: false },
};

check('canSee covers every role × visibility pair', () => {
  for (const role of ROLES) {
    for (const vis of VISIBILITY_STATES) {
      assert.strictEqual(
        canSee(role, vis), EXPECT[role][vis],
        `canSee('${role}', '${vis}') should be ${EXPECT[role][vis]}`,
      );
    }
  }
});

check('read and propose see EXACTLY the same entries (capability ≠ secrecy)', () => {
  for (const vis of VISIBILITY_STATES) {
    assert.strictEqual(canSee('read', vis), canSee('propose', vis),
      `propose must not see more than read at visibility '${vis}'`);
  }
});

check('canSee fails closed on unknown role / visibility', () => {
  assert.strictEqual(canSee('read', 'bogus'), false);      // unknown visibility → hidden
  assert.strictEqual(canSee('read', undefined), false);
  assert.strictEqual(canSee('stranger', 'shared'), false); // unknown role → rank 0
  assert.strictEqual(canSee(undefined, 'shared'), false);  // non-member
  assert.strictEqual(canSee('write', 'shared'), false);    // RETIRED tier → no access
  assert.strictEqual(canSee('owner', 'bogus'), true);      // GMs still see all
  assert.strictEqual(canSee('coGM', 'bogus'), true);
});

check('defaults fail closed', () => {
  assert.strictEqual(DEFAULT_ROLE, 'read');
  assert.strictEqual(DEFAULT_VISIBILITY, 'hidden');
  assert.strictEqual(canSee(DEFAULT_ROLE, DEFAULT_VISIBILITY), false,
    'a new member must not see a new entry by default');
});

// --- 2. capability predicates ------------------------------------------------
check('isGM / canEditLore: owner + coGM only', () => {
  assert.strictEqual(isGM('owner'), true);
  assert.strictEqual(isGM('coGM'), true);
  assert.strictEqual(isGM('propose'), false);
  assert.strictEqual(isGM('read'), false);
  for (const r of ROLES) assert.strictEqual(canEditLore(r), isGM(r));
  assert.strictEqual(canEditLore('write'), false);   // retired tier
});

check('canProposeEdits: propose and up', () => {
  assert.strictEqual(canProposeEdits('read'), false);
  assert.strictEqual(canProposeEdits('propose'), true);
  assert.strictEqual(canProposeEdits('coGM'), true);
  assert.strictEqual(canProposeEdits('owner'), true);
  assert.strictEqual(canProposeEdits('stranger'), false);
});

check('canManageWorld: OWNER only — a coGM cannot lock the owner out', () => {
  assert.strictEqual(canManageWorld('owner'), true);
  assert.strictEqual(canManageWorld('coGM'), false,
    'structural powers are owner-only for recoverability');
  assert.strictEqual(canManageWorld('propose'), false);
  assert.strictEqual(canManageWorld('read'), false);
});

check('ROLE_RANK orders members only — never compared to visibility', () => {
  assert.ok(ROLE_RANK.read < ROLE_RANK.propose);
  assert.ok(ROLE_RANK.propose < ROLE_RANK.coGM);
  assert.ok(ROLE_RANK.coGM < ROLE_RANK.owner);
  for (const vis of VISIBILITY_STATES) {
    assert.strictEqual(ROLE_RANK[vis], undefined,
      `visibility '${vis}' must not appear in the member rank table`);
  }
});

// --- 3. a read member's listing ----------------------------------------------
const CATEGORY = { id: 'locations', fields: [
  { key: 'subtitle', type: 'text' },
  { key: 'body', type: 'textarea', fog: true },
]};
const CATEGORIES = [CATEGORY];

const ENTRIES = [
  { id: 'a', categoryId: 'locations', name: 'Public Square', visibility: 'shared',
    fields: { subtitle: 'Open to all',
              body: 'A fountain ||and a hidden trapdoor|| stands here. See [[Durnan]].' } },
  { id: 'b', categoryId: 'locations', name: 'GM Vault', visibility: 'hidden',
    fields: { subtitle: 'secret', body: 'Loot ||worth 5000gp||.' } },
];

// The route's pipeline: filter by canSee, then serialize with the REAL function.
// This deliberately calls the shipped code rather than restating it — an earlier
// version of this file hand-mirrored the strip loop with a hardcoded category that
// always resolved, so it could never catch a missing-category fail-open.
function listFor(role) {
  return ENTRIES.filter(e => canSee(role, e.visibility))
                .map(e => serializeEntryForRole(e, role, CATEGORIES));
}

check('read member sees ONLY the shared entry — hidden omitted even by name', () => {
  const rows = listFor('read');
  assert.deepStrictEqual(rows.map(r => r.id), ['a']);
  assert.ok(!rows.map(r => r.name).includes('GM Vault'));
});

check("read member's body is fog-free, unfogged link PRESERVED", () => {
  const body = listFor('read')[0].fields.body;
  assert.ok(!body.includes('||'), 'no fog delimiters remain');
  assert.ok(!body.includes('hidden trapdoor'), 'fogged text dropped whole');
  // Not fogged = meant to be followed. Reachability of the TARGET is a separate
  // canSee decision made when they navigate.
  assert.strictEqual(body, 'A fountain  stands here. See [[Durnan]].');
});

check('propose member sees the same rows as read, equally stripped', () => {
  assert.deepStrictEqual(listFor('propose').map(r => r.id), listFor('read').map(r => r.id));
  assert.strictEqual(listFor('propose')[0].fields.body, listFor('read')[0].fields.body);
});

check('coGM sees both entries with RAW fog; owner likewise', () => {
  for (const role of ['coGM', 'owner']) {
    const rows = listFor(role);
    assert.deepStrictEqual(rows.map(r => r.id).sort(), ['a', 'b'], `${role} sees all`);
    assert.ok(rows.find(r => r.id === 'a').fields.body.includes('||and a hidden trapdoor||'),
      `${role} keeps raw fog`);
  }
});

check('lore-asset gate matches the owning entry', () => {
  const assetAllowed = (role, entry) => canSee(role, entry.visibility);
  const byId = Object.fromEntries(ENTRIES.map(e => [e.id, e]));
  assert.strictEqual(assetAllowed('read', byId.a), true);
  assert.strictEqual(assetAllowed('read', byId.b), false);
  assert.strictEqual(assetAllowed('propose', byId.b), false);
  assert.strictEqual(assetAllowed('coGM', byId.b), true);
});

// --- 4. fog clearance does not ride on capability ----------------------------
check('seesRawFog is GM-only and independent of edit capability', () => {
  assert.strictEqual(seesRawFog('owner'), true);
  assert.strictEqual(seesRawFog('coGM'), true);
  assert.strictEqual(seesRawFog('propose'), false);
  assert.strictEqual(seesRawFog('read'), false);
  assert.strictEqual(seesRawFog('write'), false,
    'the retired write tier must NOT resurrect fog clearance');
  // The invariant, stated directly: nobody who cannot edit lore sees fog, and
  // everybody who can, does.
  for (const r of ROLES) assert.strictEqual(seesRawFog(r), canEditLore(r));
});

// --- 5. the proposal-approval hazard -----------------------------------------
check('a proposer\'s base is ALWAYS fog-stripped — blind approval would erase fog', () => {
  const served = listFor('propose')[0].fields.body;
  assert.ok(!served.includes('||'), 'proposer never receives raw fog');
  const edited = served.replace('A fountain', 'A grand fountain');
  // Saving this wholesale would drop the trapdoor secret. Approval must diff
  // against the RAW stored entry, sighted, by a GM.
  assert.ok(!edited.includes('hidden trapdoor'));
  // Contrast: a GM edits the raw body and the fog survives untouched.
  const gmServed = listFor('coGM').find(r => r.id === 'a').fields.body;
  const gmEdited = gmServed.replace('A fountain', 'A grand fountain');
  assert.strictEqual(gmEdited,
    'A grand fountain ||and a hidden trapdoor|| stands here. See [[Durnan]].');
});

// --- 6. serializeEntryForRole fails closed on an unknown category ------------
check('unknown category fails CLOSED — every string field is stripped', () => {
  const orphan = { id: 'z', categoryId: 'category-was-deleted', visibility: 'shared',
    fields: { subtitle: 'A ||secret|| subtitle',
              body: 'Body with ||a buried secret|| in it.', count: 7 } };
  const out = serializeEntryForRole(orphan, 'read', CATEGORIES);
  assert.ok(!out.fields.subtitle.includes('||'));
  assert.ok(!out.fields.subtitle.includes('secret'));
  assert.ok(!out.fields.body.includes('buried secret'));
  assert.strictEqual(out.fields.count, 7, 'non-string fields pass through untouched');
});

check('unknown category still returns RAW fog to GMs', () => {
  const orphan = { id: 'z', categoryId: 'nope', visibility: 'shared',
    fields: { body: 'Keep ||this|| raw.' } };
  for (const r of ['owner', 'coGM']) {
    assert.strictEqual(serializeEntryForRole(orphan, r, CATEGORIES).fields.body,
      'Keep ||this|| raw.');
  }
});

check('missing / empty categories list also fails closed', () => {
  const e = { id: 'z', categoryId: 'locations', fields: { body: 'x ||y|| z' } };
  assert.ok(!serializeEntryForRole(e, 'read', []).fields.body.includes('||'));
  assert.ok(!serializeEntryForRole(e, 'read', undefined).fields.body.includes('||'));
});

// --- 7. link preservation vs. fogged links -----------------------------------
check('stripFog preserves an unfogged link, plain and display-aliased', () => {
  assert.strictEqual(stripFog('Ask [[Durnan]] about it.'), 'Ask [[Durnan]] about it.');
  assert.strictEqual(stripFog('Domains: [[Life Domain|Light]].'),
    'Domains: [[Life Domain|Light]].');
});

check('stripFog drops a FOGGED link whole — name and all', () => {
  const out = stripFog('Go to ||[[Hidden Fortress]]|| next.');
  assert.strictEqual(out, 'Go to  next.');
  assert.ok(!out.includes('Hidden Fortress'), 'fogged link name must not leak');
  assert.ok(!out.includes('[['), 'no link syntax survives inside fog');
});

check('stripFog keeps an unfogged link while dropping adjacent fog', () => {
  assert.strictEqual(stripFog('[[Durnan]] hides ||the key|| well'),
    '[[Durnan]] hides  well');
});

// --- 8. migration fails closed -----------------------------------------------
check('migrateRole: write DOWNGRADES to propose (never auto-promoted to coGM)', () => {
  assert.strictEqual(migrateRole('write'), 'propose',
    'promoting write to coGM would silently hand out fog clearance');
  assert.strictEqual(migrateRole('propose'), 'propose');
  assert.strictEqual(migrateRole('read'), 'read');
  assert.strictEqual(migrateRole('owner'), 'owner');
  assert.strictEqual(migrateRole('coGM'), 'coGM');
  assert.strictEqual(migrateRole('junk'), 'read');
  assert.strictEqual(migrateRole(undefined), 'read');
});

check('migrateVisibility: only old `read` opens up; everything else stays hidden', () => {
  assert.strictEqual(migrateVisibility('read'), 'shared');
  assert.strictEqual(migrateVisibility('shared'), 'shared');
  assert.strictEqual(migrateVisibility('propose'), 'hidden',
    'old propose meant MORE secret than read — must not widen');
  assert.strictEqual(migrateVisibility('write'), 'hidden');
  assert.strictEqual(migrateVisibility('hidden'), 'hidden');
  assert.strictEqual(migrateVisibility('junk'), 'hidden');
  assert.strictEqual(migrateVisibility(undefined), 'hidden');
});

check('post-migration, no old-tier member can see an old restricted entry', () => {
  // The end-to-end property the two migrations exist to guarantee.
  for (const oldRole of ['read', 'propose', 'write']) {
    for (const oldVis of ['propose', 'write', 'hidden']) {
      assert.strictEqual(canSee(migrateRole(oldRole), migrateVisibility(oldVis)), false,
        `${oldRole} must not gain sight of an old '${oldVis}' entry`);
    }
  }
});

console.log(`\nloreAccess: ${passed} checks passed.`);

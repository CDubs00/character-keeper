// backend/campaignAccess.test.js
//
// Wave A — the campaign overview gate. Plain `assert`, run with
// `node campaignAccess.test.js`; exits non-zero on first failure.
//
// A campaign has its OWN role axis (owner | player), deliberately separate from
// the world's (owner | coGM | propose | read). The checks below exist to keep the
// two from being conflated, and to pin the three ways a player's payload must
// differ from the GM's:
//   1. no joinCode  — it is a bearer credential
//   2. no raw ||fog|| in the prose
//   3. roster carries character names only, never owner usernames

const assert = require('assert');
const {
  CAMPAIGN_ROLES, CAMPAIGN_STATUSES, DEFAULT_CAMPAIGN_STATUS, CAMPAIGN_TEXT_FIELDS,
  seesRawCampaignFog, serializeCampaignForRole,
} = require('./loreAccess');

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

const CAMPAIGN = {
  id: 'camp1', name: 'The Salt Road', status: 'active',
  sheetId: 'swade-1', sheetName: 'Savage Worlds',
  worldId: 'brinemark', ownedBy: 'gmuser', createdAt: '2026-05-01T00:00:00.000Z',
  joinCode: 'HMZPUE',
  premise:   'A trade road is being throttled ||by the Warden captain himself||.',
  situation: 'The party is at [[Hollowford Waystation]] with ||the forged ledger||.',
  threads:   '- Who holds Warden seals?\n- ||Adler is the inside man.||',
};

const DERIVED = {
  characterCount: 2,
  sessionCount: 0,
  lastPlayed: null,
  roster: [
    { id: 'c1', name: 'Bram Tuckett',  owner: 'alice' },
    { id: 'c2', name: 'Kestrel Thorne', owner: 'bob'  },
  ],
};

const asOwner  = () => serializeCampaignForRole(CAMPAIGN, 'owner',  DERIVED);
const asPlayer = () => serializeCampaignForRole(CAMPAIGN, 'player', DERIVED);

// --- 1. fail closed ----------------------------------------------------------
check('an unknown role gets NOTHING (caller must 404)', () => {
  for (const role of [null, undefined, 'read', 'coGM', 'propose', 'admin', 'write', '']) {
    assert.strictEqual(serializeCampaignForRole(CAMPAIGN, role, DERIVED), null,
      `role '${role}' must not resolve`);
  }
});

check('world roles are NOT campaign roles', () => {
  // The axes are separate: a world coGM with no character here is a stranger to
  // this campaign. If this ever passes, the two ledgers have been conflated.
  assert.deepStrictEqual(CAMPAIGN_ROLES, ['player', 'owner']);
  for (const worldRole of ['read', 'propose', 'coGM']) {
    assert.strictEqual(serializeCampaignForRole(CAMPAIGN, worldRole, DERIVED), null);
  }
});

check('a missing campaign resolves to null for every role', () => {
  for (const role of CAMPAIGN_ROLES) {
    assert.strictEqual(serializeCampaignForRole(null, role, DERIVED), null);
    assert.strictEqual(serializeCampaignForRole(undefined, role, DERIVED), null);
  }
});

// --- 2. the join code is a credential ---------------------------------------
check('player payload carries NO joinCode', () => {
  const p = asPlayer();
  assert.ok(!('joinCode' in p), 'joinCode must be absent, not null');
  assert.ok(!JSON.stringify(p).includes('HMZPUE'), 'the code must not appear anywhere');
});

check('owner payload keeps the joinCode', () => {
  assert.strictEqual(asOwner().joinCode, 'HMZPUE');
});

// --- 3. fog -------------------------------------------------------------------
check('seesRawCampaignFog: owner only', () => {
  assert.strictEqual(seesRawCampaignFog('owner'), true);
  assert.strictEqual(seesRawCampaignFog('player'), false);
  // No coGM on a campaign: co-GM is a WORLD role, and a standalone campaign
  // (worldId null) has no world to hold that grant.
  assert.strictEqual(seesRawCampaignFog('coGM'), false);
});

check('player prose is fog-free in EVERY text field', () => {
  const p = asPlayer();
  for (const k of CAMPAIGN_TEXT_FIELDS) {
    assert.ok(!p[k].includes('||'), `${k} still has fog delimiters`);
  }
  assert.ok(!p.premise.includes('Warden captain'), 'fogged text dropped whole');
  assert.ok(!p.situation.includes('forged ledger'));
  assert.ok(!p.threads.includes('Adler is the inside man'));
});

check('player keeps unfogged [[links]] in prose', () => {
  // Not fogged = meant to be followed, same rule as lore. Reachability of the
  // target is a separate decision made when they navigate.
  assert.ok(asPlayer().situation.includes('[[Hollowford Waystation]]'));
});

check('owner prose keeps raw fog untouched', () => {
  const o = asOwner();
  for (const k of CAMPAIGN_TEXT_FIELDS) assert.strictEqual(o[k], CAMPAIGN[k]);
});

check('a fogged [[sys:X]] reference is dropped whole, name and all', () => {
  const c = { ...CAMPAIGN, premise: 'They seek ||[[sys:Blade of Ruin]]|| in secret.' };
  const p = serializeCampaignForRole(c, 'player', DERIVED);
  assert.ok(!p.premise.includes('Blade of Ruin'), 'the item name must not leak');
  assert.ok(!p.premise.includes('[['), 'no link syntax survives inside fog');
});

// --- 4. roster ---------------------------------------------------------------
check('player roster is names only — no owner usernames, no ids', () => {
  const r = asPlayer().derived.roster;
  assert.strictEqual(r.length, 2);
  for (const c of r) assert.deepStrictEqual(Object.keys(c), ['name']);
  const blob = JSON.stringify(asPlayer());
  assert.ok(!blob.includes('alice') && !blob.includes('bob'),
    'owner usernames must not reach a player');
});

check('owner roster carries ids and owner usernames', () => {
  const r = asOwner().derived.roster;
  assert.strictEqual(r[0].owner, 'alice');
  assert.strictEqual(r[0].id, 'c1');
});

// --- 5. derived block defaults ------------------------------------------------
check('derived block is present and typed even when the route passes nothing', () => {
  const o = serializeCampaignForRole(CAMPAIGN, 'owner', undefined);
  assert.deepStrictEqual(o.derived,
    { characterCount: 0, sessionCount: 0, lastPlayed: null, roster: [] });
});

check('sessionCount / lastPlayed exist now so Wave B changes no shapes', () => {
  for (const role of CAMPAIGN_ROLES) {
    const out = serializeCampaignForRole(CAMPAIGN, role, DERIVED);
    assert.ok('sessionCount' in out.derived);
    assert.ok('lastPlayed' in out.derived);
  }
});

check('junk in the derived block is coerced, not trusted', () => {
  const o = serializeCampaignForRole(CAMPAIGN, 'owner',
    { characterCount: 'lots', roster: 'nope', sessionCount: 1.5 });
  assert.strictEqual(o.derived.characterCount, 0);
  assert.strictEqual(o.derived.sessionCount, 0);
  assert.deepStrictEqual(o.derived.roster, []);
});

// --- 6. status + shape --------------------------------------------------------
check('status falls back to active for pre-status campaigns', () => {
  assert.strictEqual(CAMPAIGN_STATUSES.join(), 'active,archived');
  assert.strictEqual(DEFAULT_CAMPAIGN_STATUS, 'active');
  const legacy = { ...CAMPAIGN }; delete legacy.status;
  assert.strictEqual(serializeCampaignForRole(legacy, 'player', DERIVED).status, 'active');
  assert.strictEqual(
    serializeCampaignForRole({ ...CAMPAIGN, status: 'bogus' }, 'player', DERIVED).status,
    'active', 'an unrecognised status must not pass through');
});

check('a standalone campaign (worldId null) serializes fine', () => {
  const solo = { ...CAMPAIGN, worldId: undefined };
  for (const role of CAMPAIGN_ROLES) {
    assert.strictEqual(serializeCampaignForRole(solo, role, DERIVED).worldId, null);
  }
});

check('missing prose fields become empty strings, not undefined', () => {
  const bare = { id: 'x', name: 'Bare', ownedBy: 'gmuser' };
  for (const role of CAMPAIGN_ROLES) {
    const out = serializeCampaignForRole(bare, role, DERIVED);
    for (const k of CAMPAIGN_TEXT_FIELDS) assert.strictEqual(out[k], '');
  }
});

check('the payload is an allowlist — no unexpected key rides along', () => {
  const sneaky = { ...CAMPAIGN, secretNote: 'gm only', members: ['alice'] };
  const p = serializeCampaignForRole(sneaky, 'player', DERIVED);
  assert.ok(!('secretNote' in p) && !('members' in p),
    'serializer must pick fields explicitly, never spread the record');
  assert.strictEqual(p.role, 'player', 'the viewer role is echoed for the UI');
});

console.log(`\ncampaignAccess: ${passed} checks passed.`);

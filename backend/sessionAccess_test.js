// backend/sessionAccess_test.js
//
// The prep/record boundary. Plain `assert`, run with `node sessionAccess_test.js`;
// exits non-zero on first failure. Same convention as campaignAccess_test.js.
//
// The property under test is STRUCTURAL, not a filter: prep must never appear in
// a player payload under ANY input, including inputs nobody intended — a session
// with prep and no record, a corrupt visibility value, a hand-added key. That is
// why several of these tests walk the payload generically rather than asserting
// on named fields: a prep field added in six months is caught by the same test.

const assert = require('assert');
const {
  SESSION_SCENE_FIELDS, SESSION_RECORD_FIELDS, DEFAULT_SESSION_VISIBILITY,
  canSeeSession, sessionVisibility,
  serializeSessionForRole, serializeSessionsForRole, sessionStatsForRole,
} = require('./loreAccess');

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

// A session with a distinctive marker in EVERY GM-only place, so a leak anywhere
// shows up as that string appearing in a player payload.
const SECRET = 'THE-BUTLER-DID-IT';
const full = (over = {}) => ({
  id: 'sess-1',
  number: 3,
  title: 'The counting house',
  date: '2026-02-14',
  inWorldDate: { era: 'ce', year: 1492, month: 2, day: 3 },
  visibility: 'shared',
  scenes: [{
    name: `${SECRET} the vault heist`, gmNote: `${SECRET} the factor is bribed`,
    cinematic: `${SECRET} torchlight`, location: `${SECRET} the vault`,
    whoThere: `${SECRET} the factor`, moveItForward: `${SECRET} midnight deadline`,
    dialog: `${SECRET} "who goes there"`, skillChecks: `${SECRET} lockpicking`,
    bigClue: `${SECRET} the debt`,
  }],
  record: {
    recap: 'You broke into the counting house.',
    happened: `They found a ledger. ||${SECRET} it was forged by the factor||`,
    clues: 'The seal was broken.',
    loot: 'A silver key.',
  },
  nextTime: `${SECRET} the factor flees north`,
  cast: ['char-a', 'npc-b'],
  loreRefs: ['entry-x'],
  encounters: [{ name: 'Night watch', notes: `${SECRET} they are bribed`, status: 'ready' }],
  createdAt: '2026-02-01T00:00:00Z',
  updatedAt: '2026-02-15T00:00:00Z',
  ...over,
});

// Walk every string anywhere in a payload — the generic leak detector.
function allStrings(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach(x => allStrings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach(x => allStrings(x, out));
  return out;
}

// --- 1. the boundary ---------------------------------------------------------

check('a player payload contains no prep text ANYWHERE in the object tree', () => {
  const out = serializeSessionForRole(full(), 'player');
  const leaked = allStrings(out).filter(s => s.includes(SECRET));
  assert.deepStrictEqual(leaked, [], `prep leaked into the player payload: ${leaked}`);
});

check('a player payload has no prep-side KEYS at all, not even emptied ones', () => {
  const out = serializeSessionForRole(full(), 'player');
  for (const k of ['scenes', 'nextTime', 'cast', 'loreRefs', 'encounters', 'visibility']) {
    assert.ok(!(k in out), `player payload must not carry the key "${k}"`);
  }
  assert.deepStrictEqual(Object.keys(out).sort(),
    ['date', 'id', 'inWorldDate', 'number', 'record', 'title'].sort());
});

check('every declared scene field is absent from the player payload', () => {
  const out = serializeSessionForRole(full(), 'player');
  const keys = new Set(allStrings(Object.keys(out)));
  for (const f of SESSION_SCENE_FIELDS) assert.ok(!keys.has(f), `${f} reached the player`);
});

check('the GM sees scenes in full, fog raw', () => {
  const out = serializeSessionForRole(full(), 'owner');
  assert.ok(out.scenes[0].whoThere.includes(SECRET));
  assert.ok(out.nextTime.includes(SECRET));
  assert.ok(out.encounters[0].notes.includes(SECRET));
  assert.ok(out.record.happened.includes('||'), 'the GM keeps raw fog markers');
});

// --- 2. fog inside the record ------------------------------------------------

check('fog inside a SHARED record is stripped for players but the prose survives', () => {
  const out = serializeSessionForRole(full(), 'player');
  assert.ok(!out.record.happened.includes(SECRET), 'fogged span must be dropped');
  assert.ok(!out.record.happened.includes('||'), 'no fog markers reach a player');
  assert.ok(out.record.happened.includes('They found a ledger'), 'unfogged prose survives');
});

check('an unfogged [[link]] in a record is preserved for players', () => {
  const s = full({ record: { recap: 'See [[The Vault]] and ||[[Secret Door]]||', happened: '', clues: '', loot: '' } });
  const out = serializeSessionForRole(s, 'player');
  assert.ok(out.record.recap.includes('[[The Vault]]'), 'a plain link is followable');
  assert.ok(!out.record.recap.includes('Secret Door'), 'a fogged link is dropped name and all');
});

// --- 3. visibility gates the record, and defaults closed ---------------------

check('visibility defaults to hidden, so a half-written record is never live', () => {
  assert.strictEqual(DEFAULT_SESSION_VISIBILITY, 'hidden');
  const s = full(); delete s.visibility;
  assert.strictEqual(sessionVisibility(s), 'hidden');
  assert.strictEqual(serializeSessionForRole(s, 'player'), null);
  assert.ok(serializeSessionForRole(s, 'owner'), 'the GM still sees their own draft');
});

check('a corrupt visibility value fails CLOSED', () => {
  for (const bad of ['public', 'SHARED', '', null, 0, {}, ['shared']]) {
    const s = full({ visibility: bad });
    assert.strictEqual(serializeSessionForRole(s, 'player'), null, `visibility ${JSON.stringify(bad)} must not expose`);
  }
});

check('an unknown role gets nothing', () => {
  for (const role of ['coGM', 'read', 'admin', '', null, undefined]) {
    assert.strictEqual(serializeSessionForRole(full(), role), null);
  }
});

check('a world coGM is a stranger to a campaign — no session access', () => {
  // Campaign roles are their own axis; coGM is a WORLD role and must not resolve.
  assert.strictEqual(canSeeSession(full(), 'coGM'), false);
});

// --- 4. ordering is by number, never by date ---------------------------------

check('the log orders by number even when in-world dates jump backwards', () => {
  const sessions = [
    { id: 'c', number: 12, visibility: 'shared', date: '2026-01-01', record: {} },  // a flashback
    { id: 'a', number: 4,  visibility: 'shared', date: '2026-06-01', record: {} },
    { id: 'b', number: 5,  visibility: 'shared', date: '2026-07-01', record: {} },
  ];
  const out = serializeSessionsForRole(sessions, 'player');
  assert.deepStrictEqual(out.map(s => s.number), [4, 5, 12],
    'sorting by date would file session 12 between 4 and 5');
});

check('sessions a player may not see are DROPPED, not blanked', () => {
  const sessions = [
    { id: 'a', number: 1, visibility: 'shared', record: {} },
    { id: 'b', number: 2, visibility: 'hidden', record: {} },
    { id: 'c', number: 3, visibility: 'shared', record: {} },
  ];
  const out = serializeSessionsForRole(sessions, 'player');
  assert.deepStrictEqual(out.map(s => s.id), ['a', 'c']);
  assert.strictEqual(serializeSessionsForRole(sessions, 'owner').length, 3);
});

// --- 5. derived stats must not leak the unpublished backlog ------------------

check('a player\u2019s session count covers only what they can see', () => {
  const sessions = [
    { id: 'a', number: 1, visibility: 'shared', date: '2026-01-01' },
    { id: 'b', number: 2, visibility: 'hidden', date: '2026-09-09' },
    { id: 'c', number: 3, visibility: 'shared', date: '2026-02-02' },
  ];
  assert.strictEqual(sessionStatsForRole(sessions, 'owner').sessionCount, 3);
  assert.strictEqual(sessionStatsForRole(sessions, 'player').sessionCount, 2,
    'counting hidden sessions tells a player how much unpublished material exists');
});

check('lastPlayed is the latest date THIS role can see', () => {
  const sessions = [
    { id: 'a', number: 1, visibility: 'shared', date: '2026-01-01' },
    { id: 'b', number: 2, visibility: 'hidden', date: '2026-09-09' },
  ];
  assert.strictEqual(sessionStatsForRole(sessions, 'owner').lastPlayed, '2026-09-09');
  assert.strictEqual(sessionStatsForRole(sessions, 'player').lastPlayed, '2026-01-01',
    'a hidden session\u2019s date would reveal that the GM has prepped ahead');
});

check('an empty or absent log is not an error', () => {
  for (const v of [[], null, undefined, 'nonsense', {}]) {
    assert.deepStrictEqual(serializeSessionsForRole(v, 'player'), []);
    assert.deepStrictEqual(sessionStatsForRole(v, 'player'), { sessionCount: 0, lastPlayed: null });
  }
});

// --- 6. malformed records degrade rather than crash --------------------------

check('a session missing its groups still serializes', () => {
  const bare = { id: 'x', number: 1, visibility: 'shared' };
  const p = serializeSessionForRole(bare, 'player');
  const o = serializeSessionForRole(bare, 'owner');
  for (const f of SESSION_RECORD_FIELDS) assert.strictEqual(p.record[f], '');
  assert.deepStrictEqual(o.scenes, []);
  assert.deepStrictEqual(o.encounters, []);
});

check('a non-string prep/record value cannot smuggle an object through', () => {
  const s = full({ record: { recap: { evil: SECRET }, happened: ['x', SECRET], clues: 5, loot: null } });
  const out = serializeSessionForRole(s, 'player');
  for (const f of SESSION_RECORD_FIELDS) {
    assert.strictEqual(typeof out.record[f], 'string', `${f} must always be a string`);
  }
  assert.deepStrictEqual(allStrings(out).filter(x => x.includes(SECRET)), []);
});

check('an encounter status is coerced to ready|run, never passed through', () => {
  const s = full({ encounters: [{ name: 'A', status: 'DROP TABLE' }, { name: 'B', status: 'run' }] });
  const out = serializeSessionForRole(s, 'owner');
  assert.deepStrictEqual(out.encounters.map(e => e.status), ['ready', 'run']);
});

console.log(`\nsessionAccess: ${passed} checks passed.`);

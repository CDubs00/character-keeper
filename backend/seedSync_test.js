// backend/seedSync_test.js — the shipped-content reconciler.
//
// The whole value of seedSync is a promise about what it will NOT do: it must
// never overwrite something the user wrote. So most of these checks assert the
// negative — that a file survived — which is exactly the property a careless
// refactor would silently break.
//
// Plain-node asserts, matching the backend's other suites. Run with
// `node seedSync_test.js`.

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { syncSeedDir, compareVersions } = require('./seedSync');

let ok = 0;
function is(actual, expected, msg) {
  assert.deepStrictEqual(actual, expected, `${msg}\n  got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
  ok++;
  console.log(`  ok   ${msg}`);
}

// ── scratch world ───────────────────────────────────────────────────────────
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'seedsync-'));
const SEED = path.join(ROOT, 'seed');
const LIVE = path.join(ROOT, 'data', 'packs');
const DATA = path.join(ROOT, 'data');
fs.mkdirSync(DATA, { recursive: true });

function writeSeed(name, version, files) {
  const dir = path.join(SEED, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ packId: name, version }, null, 2));
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
}
const live  = (name, rel) => path.join(LIVE, name, rel);
const read  = (name, rel) => fs.readFileSync(live(name, rel), 'utf8');
const sync  = () => syncSeedDir('packs', SEED, LIVE, DATA);
const version = (name) => JSON.parse(read(name, 'manifest.json')).version;

console.log('\nseedSync');

// ── version compare ─────────────────────────────────────────────────────────
is(compareVersions('1.1.0', '1.0.0'),  1, '1.1.0 is newer than 1.0.0');
is(compareVersions('1.0.0', '1.1.0'), -1, '1.0.0 is older than 1.1.0');
is(compareVersions('1.0.0', '1.0.0'),  0, 'equal versions compare equal');
is(compareVersions('1.10.0', '1.9.0'), 1, 'segments compare NUMERICALLY, not as strings');
is(compareVersions('1.2', '1.2.0'),    0, 'a missing segment reads as zero');
// Conservative by design: an unparseable version yields "no update" rather than
// a guess, because guessing wrong here overwrites user content.
is(compareVersions('1.0.0', 'beta'),   0, 'an unparseable version never triggers an update');

// ── first boot: plain seed ──────────────────────────────────────────────────
writeSeed('default', '1.0.0', { 'categories.json': 'V1', 'assets/icon.svg': 'ICON1' });
is(sync().seeded, ['default'], 'a folder not present is seeded');
is(read('default', 'categories.json'), 'V1', 'seeded content lands');
is(read('default', 'assets/icon.svg'), 'ICON1', 'nested files are seeded too');
is(fs.existsSync(path.join(DATA, 'seed-ledger.json')), true, 'the ledger is written');

// ── same version: no-op ─────────────────────────────────────────────────────
fs.writeFileSync(live('default', 'categories.json'), 'USER EDIT');
is(sync().updated, [], 'a same-version boot does nothing');
is(read('default', 'categories.json'), 'USER EDIT', 'a same-version boot never touches files');

// ── newer version, file USER-MODIFIED: held back ────────────────────────────
writeSeed('default', '1.1.0', { 'categories.json': 'V2', 'assets/icon.svg': 'ICON1' });
is(sync().conflicts, ['default'], 'an update over a user-modified file reports a conflict');
is(read('default', 'categories.json'), 'USER EDIT', 'THE USER EDIT SURVIVES — the core promise');
is(read('default', 'categories.json.new'), 'V2', 'the shipped version is parked as .new, never lost');
is(version('default'), '1.0.0',
   'the manifest is NOT bumped on a partial update, so the reconcile retries next boot');

// ── the retry really does happen ────────────────────────────────────────────
is(sync().conflicts, ['default'], 'the held-back update is re-reported on the next boot');

// ── user reverts their edit: the update then flows ──────────────────────────
// The ledger records what we WOULD have written, so a file that comes back into
// line with the shipped copy becomes eligible again without manual intervention.
fs.writeFileSync(live('default', 'categories.json'), 'V1');
is(sync().updated, ['default'], 'once the edit is reverted the update applies');
is(read('default', 'categories.json'), 'V2', 'the pristine file is updated');
is(version('default'), '1.1.0', 'a clean run bumps the manifest');

// ── newer version, file PRISTINE: straight update ───────────────────────────
writeSeed('default', '1.2.0', { 'categories.json': 'V3', 'assets/icon.svg': 'ICON2', 'calendar.json': 'CAL' });
is(sync().updated, ['default'], 'a pristine folder updates cleanly');
is(read('default', 'categories.json'), 'V3', 'a file we last wrote is replaced');
is(read('default', 'assets/icon.svg'), 'ICON2', 'nested files update too');
is(read('default', 'calendar.json'), 'CAL', 'a newly shipped file is added');
is(fs.existsSync(live('default', 'categories.json.new')), true,
   'the earlier .new is left alone — we never delete anything the user might want');

// ── user-authored files and folders are untouchable ─────────────────────────
fs.writeFileSync(live('default', 'mine.json'), 'MINE');
fs.mkdirSync(path.join(LIVE, 'my-own-pack'), { recursive: true });
fs.writeFileSync(path.join(LIVE, 'my-own-pack', 'categories.json'), 'CUSTOM');
writeSeed('default', '1.3.0', { 'categories.json': 'V4', 'assets/icon.svg': 'ICON2' });
sync();
is(read('default', 'mine.json'), 'MINE', 'a file the user added inside a seeded folder is untouched');
is(fs.readFileSync(path.join(LIVE, 'my-own-pack', 'categories.json'), 'utf8'), 'CUSTOM',
   'a pack the user authored is never touched — it is not in the seed at all');

// ── a file dropped from the seed stays put ──────────────────────────────────
// Removing content on upgrade could break a world mid-campaign; a stale extra
// file is the lesser evil.
is(read('default', 'calendar.json'), 'CAL', 'a file the seed no longer ships is left in place');

// ── SEED_FORCE overrides a user modification ────────────────────────────────
fs.writeFileSync(live('default', 'categories.json'), 'USER EDIT AGAIN');
writeSeed('default', '1.4.0', { 'categories.json': 'V5', 'assets/icon.svg': 'ICON2' });
is(sync().conflicts, ['default'], 'without the flag, the edit is still protected');
process.env.SEED_FORCE = 'default';
is(sync().updated, ['default'], 'SEED_FORCE applies the update anyway');
is(read('default', 'categories.json'), 'V5', 'SEED_FORCE overwrites — the documented escape hatch');
delete process.env.SEED_FORCE;

// ── OS junk is never shipped ────────────────────────────────────────────────
// A dev machine's packs/ doubles as the seed dir, so a stray .DS_Store would
// otherwise be copied into every user's data volume as pack content.
fs.writeFileSync(path.join(SEED, 'default', '.DS_Store'), 'JUNK');
writeSeed('default', '1.3.1', { 'categories.json': 'V4', 'assets/icon.svg': 'ICON2' });
sync();
is(fs.existsSync(live('default', '.DS_Store')), false, 'OS droppings are not seeded');

// ── known-hash bootstrap: an install that predates the ledger ───────────────
// The case every existing user is in. No ledger, and a file that differs from
// what we're shipping — but it matches a version we DID ship once, so it's an
// old pristine copy, not an edit, and must update with no force flag.
{
  const KDATA = path.join(ROOT, 'legacy');
  const KLIVE = path.join(KDATA, 'packs');
  fs.mkdirSync(path.join(KLIVE, 'default'), { recursive: true });
  // An install carrying "OLD SHIPPED" with no ledger at all.
  fs.writeFileSync(path.join(KLIVE, 'default', 'categories.json'), 'OLD SHIPPED');
  fs.writeFileSync(path.join(KLIVE, 'default', 'manifest.json'),
    JSON.stringify({ packId: 'default', version: '1.0.0' }));

  const crypto = require('crypto');
  const h = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const hashesFile = path.join(ROOT, 'known.json');
  fs.writeFileSync(hashesFile, JSON.stringify({
    'packs/default/categories.json': [h('OLD SHIPPED'), h('EVEN OLDER')],
  }));
  process.env.SEED_HASHES_FILE = hashesFile;
  delete require.cache[require.resolve('./seedSync')];
  const fresh = require('./seedSync');

  writeSeed('default', '2.0.0', { 'categories.json': 'NEW SHIPPED' });
  is(fresh.syncSeedDir('packs', SEED, KLIVE, KDATA).updated, ['default'],
     'a pre-ledger install whose file matches a version we shipped updates with NO force flag');
  is(fs.readFileSync(path.join(KLIVE, 'default', 'categories.json'), 'utf8'), 'NEW SHIPPED',
     'the stale shipped file is brought current');

  // ...but a genuine edit on the same pre-ledger install is still protected,
  // because its bytes match no release of ours.
  fs.writeFileSync(path.join(KLIVE, 'default', 'categories.json'), 'HAND EDITED');
  writeSeed('default', '2.1.0', { 'categories.json': 'NEWER SHIPPED' });
  is(fresh.syncSeedDir('packs', SEED, KLIVE, KDATA).conflicts, ['default'],
     'a hand-edited file on the SAME install is still held back');
  is(fs.readFileSync(path.join(KLIVE, 'default', 'categories.json'), 'utf8'), 'HAND EDITED',
     'the edit survives — the bootstrap loosens nothing for files we never shipped');

  delete process.env.SEED_HASHES_FILE;
  delete require.cache[require.resolve('./seedSync')];
}

// ── a lost ledger fails SAFE ────────────────────────────────────────────────
// Every file becomes unknown-provenance, so nothing is overwritten. Failing
// toward "do nothing" is the only acceptable direction for this feature.
fs.unlinkSync(path.join(DATA, 'seed-ledger.json'));
fs.writeFileSync(live('default', 'categories.json'), 'PRECIOUS');
writeSeed('default', '1.5.0', { 'categories.json': 'V6', 'assets/icon.svg': 'ICON2' });
is(sync().conflicts, ['default'], 'with no ledger, every differing file is treated as user-modified');
is(read('default', 'categories.json'), 'PRECIOUS', 'a lost ledger never costs the user a file');

// ── a missing seed dir is a no-op, not a crash ──────────────────────────────
is(syncSeedDir('packs', path.join(ROOT, 'nope'), LIVE, DATA),
   { seeded: [], updated: [], conflicts: [] }, 'a missing seed dir is a clean no-op');

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`\nseedSync: ${ok} checks passed.`);

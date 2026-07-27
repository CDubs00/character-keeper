// backend/sysrefRoutes_test.mjs — Wave C route-level integration test.
//
// Boots the REAL server on a throwaway data dir and drives the system-reference
// routes over HTTP as three identities: the owning GM, a `read` member, and a
// stranger. systemRef_test.js covers the module in isolation; this covers the
// thing that actually protects players — the GUARD CHAIN — and it is deliberately
// end-to-end because every past mistake in this area was a wiring mistake, not a
// logic one. Run with `node sysrefRoutes_test.mjs`.
//
// .mjs because it needs top-level await; the backend is otherwise CommonJS.
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'wavec-'));
fs.mkdirSync(path.join(DATA, 'characters'), { recursive: true });
const PORT = 4600 + Math.floor(Math.random()*300);
const BASE = `http://127.0.0.1:${PORT}`;
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const srv = spawn('node', ['server.js'], {
  cwd: path.join(REPO, 'backend'),
  env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT),
         BUNDLES_DIR: path.join(REPO, 'bundles'),
         SEED_PACKS_DIR: path.join(REPO, 'packs'),
         SESSION_SECRET: 'x'.repeat(40), CSRF_ENFORCE: 'false', NODE_ENV: 'test' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
srv.stdout.on('data', d => { log += d; });
srv.stderr.on('data', d => { log += d; });

const sleep = ms => new Promise(r => setTimeout(r, ms));
for (let i = 0; i < 60; i++) {
  try { await fetch(`${BASE}/api/session`); break; } catch { await sleep(200); }
}

process.on('uncaughtException', e => { srv.kill(); console.error(e); process.exit(1); });
let fails = 0, ok = 0;
function is(actual, expected, msg) {
  const good = JSON.stringify(actual) === JSON.stringify(expected);
  if (good) { ok++; console.log(`  ok   ${msg}`); }
  else { fails++; console.log(`  FAIL ${msg}\n       got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`); }
}

// One cookie jar per identity. Cookies MERGE — a response that sets only
// XSRF-TOKEN must not evict connect.sid, which is exactly the bug that made
// every authenticated call 401 on the first run of this harness.
const jars = {};
async function req(who, method, url, body) {
  const jar = jars[who] || (jars[who] = new Map());
  const headers = { 'Content-Type': 'application/json' };
  if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const r = await fetch(BASE + url, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  for (const c of (r.headers.getSetCookie?.() || [])) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
  let json = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, body: json };
}

const PW = 'correct-horse-battery-staple-42';
await req('gm', 'POST', '/api/setup', { username: 'gmuser', password: PW });
await req('gm', 'POST', '/api/login', { username: 'gmuser', password: PW });
await req('gm', 'POST', '/api/users', { username: 'player', password: PW, role: 'player' });
await req('gm', 'POST', '/api/users', { username: 'stranger', password: PW, role: 'player' });
await req('player', 'POST', '/api/login', { username: 'player', password: PW });
await req('stranger', 'POST', '/api/login', { username: 'stranger', password: PW });

const world = (await req('gm', 'POST', '/api/worlds', { name: 'Test World' })).body;

console.log('\nWave C route smoke');

// Put the player in the ledger at `read`. There is no "add member" route by
// design — membership is auto-granted by the campaign-join hook (§4.7) — so the
// harness writes the ledger entry the join hook would have written. Tier CHANGES
// below go through the real route.
function setMember(tier) {
  const f = path.join(DATA, 'worlds.json');
  const worlds = JSON.parse(fs.readFileSync(f, 'utf8'));
  const w = worlds.find(x => x.id === world.id);
  w.members = { player: { tier, grantedAt: new Date().toISOString() } };
  fs.writeFileSync(f, JSON.stringify(worlds, null, 2));
}
setMember('read');

// --- stamping ---------------------------------------------------------------
const reg = JSON.parse(fs.readFileSync(path.join(DATA, 'sheets-registry.json'), 'utf8'));
const swade = reg.find(r => r.folder === 'savage-pathfinder');
is((await req('gm', 'GET', `/api/worlds/${world.id}/system`)).body, { systemId: null, types: [] },
   'a fresh world has no system — a normal state, not an error');
is((await req('gm', 'PUT', `/api/worlds/${world.id}/system`, { systemId: 'no-such-bundle' })).status, 400,
   'an unknown bundle is rejected');
const set = await req('gm', 'PUT', `/api/worlds/${world.id}/system`, { systemId: swade.sheetId });
is(set.status, 200, 'the SWADE bundle stamps the world');
// Compared against the BUNDLE's own sysrefTypes rather than a literal list: the
// property under test is that the server preserves declaration order (a rulebook's
// order is meaningful — §4.12), not which types SWADE happens to declare today.
// Pinning the literal made every legitimate bundle edit look like a regression. A
// server-side sort still fails this, which is the point.
const swadeDeclared = JSON.parse(
  fs.readFileSync(path.join(REPO, 'bundles', 'savage-pathfinder', 'schema.json'), 'utf8'),
).sysrefTypes;
is(set.body.types.map(t => t.id).join(','), swadeDeclared.join(','),
   'the bundle\'s declared reference types come back IN DECLARATION ORDER');
is((await req('player', 'PUT', `/api/worlds/${world.id}/system`, { systemId: swade.sheetId })).status, 403,
   'a read member cannot re-stamp the world (structural = owner-only)');

// --- GET /api/systems: only bundles that DECLARE a package ------------------
const systems = (await req('gm', 'GET', '/api/systems')).body;
is(Array.isArray(systems), true, 'the systems catalogue answers');
is(systems.some(s => s.sheetId === swade.sheetId), true, 'a bundle with sysrefTypes is offered');
is(systems.every(s => s.types > 0), true, 'every offered system reports at least one category');
// Every shipped bundle declares one, so the catalogue should match the registry's
// enabled rows exactly — the assertion that matters is that it is FILTERED at all,
// which the unit tests cover for a bundle with no sysrefTypes.
is((await req('player', 'GET', '/api/systems')).status, 403, 'a non-GM cannot read the catalogue');

// --- entries ----------------------------------------------------------------
const hidden = (await req('gm', 'POST', `/api/worlds/${world.id}/sysref`,
  { categoryId: 'creature', name: 'Grix the Molder', fields: { toughness: '9', gm_notes: 'boss' } })).body;
is(hidden.visibility, 'hidden', 'a new system entry defaults to hidden, like lore');
is(hidden.systemId, swade.sheetId, 'the stamp comes from the world, not the body');

const shared = (await req('gm', 'POST', `/api/worlds/${world.id}/sysref`, {
  categoryId: 'weapon', name: 'Ashvine Carbine', visibility: 'shared',
  fields: { damage: '2d6', notes: 'Reliable. ||Jams on a raise.||', bogus: 'smuggled' },
})).body;
is(shared.fields.bogus, undefined, 'an undeclared field key is dropped (allowlist, not spread)');

// stamp forgery
const forged = (await req('gm', 'POST', `/api/worlds/${world.id}/sysref`,
  { categoryId: 'edge', name: 'Forged', systemId: 'some-other-system', worldId: 'elsewhere' })).body;
is(forged.systemId, swade.sheetId, 'a body-supplied systemId is ignored');
is(forged.worldId, world.id, 'a body-supplied worldId is ignored');

// --- what the member actually receives --------------------------------------
const list = (await req('player', 'GET', `/api/worlds/${world.id}/sysref`)).body;
is(list.map(e => e.name), ['Ashvine Carbine'],
   'the read member sees only the shared entry — the unpublished boss is absent, name and all');
is(list[0].fields.notes, 'Reliable. ',
   'fog is stripped from a system entry for a non-GM');
is((await req('player', 'GET', `/api/worlds/${world.id}/sysref/${hidden.id}`)).status, 404,
   'fetching a hidden entry by id 404s (not 403 — never confirm it exists)');
is((await req('player', 'POST', `/api/worlds/${world.id}/sysref`, { categoryId: 'edge', name: 'Nope' })).status, 403,
   'a read member cannot create');
is((await req('player', 'PUT', `/api/worlds/${world.id}/sysref/${shared.id}`, { name: 'Hacked' })).status, 403,
   'a read member cannot edit');
is((await req('player', 'DELETE', `/api/worlds/${world.id}/sysref/${shared.id}`)).status, 403,
   'a read member cannot delete');
is((await req('stranger', 'GET', `/api/worlds/${world.id}/sysref`)).status, 404,
   'a non-member 404s on the whole tier');
is((await req('stranger', 'GET', `/api/worlds/${world.id}/system`)).status, 404,
   'a non-member cannot even read the world\'s system stamp');

// --- coGM --------------------------------------------------------------------
is((await req('gm', 'PUT', `/api/worlds/${world.id}/members/player`, { tier: 'coGM' })).status, 200,
   'the owner promotes the member to coGM through the real route');
const asCoGM = (await req('player', 'GET', `/api/worlds/${world.id}/sysref`)).body;
is(asCoGM.length, 3, 'a coGM sees every entry including hidden ones');
is(asCoGM.find(e => e.id === shared.id).fields.notes, 'Reliable. ||Jams on a raise.||',
   'a coGM receives RAW fog, so an edit round-trip cannot erase it');
is((await req('player', 'PUT', `/api/worlds/${world.id}/sysref/${shared.id}`, { name: 'Ashvine Carbine mk2' })).status, 200,
   'a coGM can edit');
is((await req('player', 'DELETE', `/api/worlds/${world.id}/sysref/${shared.id}`)).status, 403,
   'but deleting stays owner-only');

// --- the stamp survives a system swap ---------------------------------------
const other = reg.find(r => r.folder === 'dnd5e24') || reg.find(r => r.sheetId !== swade.sheetId);
if (other) {
  await req('gm', 'PUT', `/api/worlds/${world.id}/system`, { systemId: other.sheetId });
  const after = (await req('gm', 'GET', `/api/worlds/${world.id}/sysref`)).body;
  is(after.find(e => e.id === hidden.id).systemId, swade.sheetId,
     'existing entries keep their ORIGINAL stamp after the world is re-stamped');
}

// --- cleanup on world delete -------------------------------------------------
await req('gm', 'DELETE', `/api/worlds/${world.id}`);
is(fs.existsSync(path.join(DATA, 'sysref', world.id)), false,
   'deleting a world sweeps its system-reference tree');

srv.kill();
console.log(`\n${ok} passed, ${fails} failed`);
if (fails) { console.log('\n--- server log ---\n' + log.slice(-3000)); }
process.exit(fails ? 1 : 0);

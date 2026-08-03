// backend/worldShare_test.mjs — external world share links (read-only).
//
// Boots the REAL server on a throwaway data dir and drives the share prefix over
// HTTP with NO session at all, because that is the only way to test what actually
// protects the world here: the gate chain. The share path is an internal URL
// rewrite onto the ordinary world routes, so the risk isn't the filtering logic
// (§4.8's canSee/stripFog, already covered by loreAccess_test) — it's the WIRING:
// which methods, which paths, and which tier the reader is pinned to.
//
// .mjs because it needs top-level await; the backend is otherwise CommonJS.
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'wshare-'));
fs.mkdirSync(path.join(DATA, 'characters'), { recursive: true });
const PORT = 4900 + Math.floor(Math.random() * 300);
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
  try { json = await r.json(); } catch { /* html or empty */ }
  return { status: r.status, body: json };
}
// The share reader: no cookie jar, no session, ever.
async function anon(method, url) {
  const r = await fetch(BASE + url, { method, redirect: 'manual' });
  let json = null;
  try { json = await r.json(); } catch { /* the SPA catch-all serves html */ }
  return { status: r.status, body: json };
}

const PW = 'correct-horse-battery-staple-42';
await req('gm', 'POST', '/api/setup', { username: 'gmuser', password: PW });
await req('gm', 'POST', '/api/login', { username: 'gmuser', password: PW });
await req('gm', 'POST', '/api/users', { username: 'player', password: PW, role: 'player' });
await req('player', 'POST', '/api/login', { username: 'player', password: PW });

const world = (await req('gm', 'POST', '/api/worlds', { name: 'Share World' })).body;

console.log('\nWorld share links');

// --- who may mint one --------------------------------------------------------
is((await req('player', 'POST', `/api/worlds/${world.id}/shares`, { expiresInDays: 7 })).status, 403,
   'a non-GM cannot create a share link');
{
  // A ledger member is not the owner. Sharing a world outward is the owner's
  // call alone, so even a co-GM must not be able to mint a public link.
  const f = path.join(DATA, 'worlds.json');
  const worlds = JSON.parse(fs.readFileSync(f, 'utf8'));
  worlds.find(w => w.id === world.id).members = { player: { tier: 'coGM', grantedAt: new Date().toISOString() } };
  fs.writeFileSync(f, JSON.stringify(worlds, null, 2));
}
await req('gm', 'PATCH', '/api/users/player', { role: 'gm' });
await req('player', 'POST', '/api/login', { username: 'player', password: PW });
is((await req('player', 'POST', `/api/worlds/${world.id}/shares`, { expiresInDays: 7 })).status, 403,
   'even a co-GM cannot create a share link — owner only');

const share = (await req('gm', 'POST', `/api/worlds/${world.id}/shares`, { expiresInDays: 7 })).body;
is(typeof share.token === 'string' && share.token.length >= 32, true, 'the owner gets an unguessable token');
is(share.permission, 'view', 'a world link is always view-only');
{
  // The route takes no permission argument at all, so asking for one changes nothing.
  const forged = (await req('gm', 'POST', `/api/worlds/${world.id}/shares`, { permission: 'edit', expiresInDays: 1 })).body;
  is(forged.permission, 'view', 'a body-supplied permission:edit is ignored');
  await req('gm', 'DELETE', `/api/worlds/${world.id}/shares/${forged.token}`);
}

const S = `/api/share/world/${share.token}`;

// --- content: exactly what a `read` member sees ------------------------------
const cats = (await req('gm', 'GET', `/api/worlds/${world.id}/categories`)).body;
const catId = cats[0].id;
const shared = (await req('gm', 'POST', `/api/worlds/${world.id}/lore`, {
  categoryId: catId, name: 'The Open Gate', visibility: 'shared',
  fields: { body: 'A busy gate. ||The watch captain is a doppelganger.||' },
})).body;
const secret = (await req('gm', 'POST', `/api/worlds/${world.id}/lore`, {
  categoryId: catId, name: 'The Sealed Vault', visibility: 'hidden', fields: { body: 'nobody knows' },
})).body;

const list = await anon('GET', `${S}/lore`);
is(list.status, 200, 'an anonymous reader can list lore through the link');
is(list.body.map(e => e.id), [shared.id], 'a hidden entry is absent entirely — not even its name');
is(/doppelganger/.test(JSON.stringify(list.body)), false, '||fog|| is stripped before it leaves the server');
is((await anon('GET', `${S}/lore/${secret.id}`)).status, 404, 'fetching a hidden entry directly 404s');
is((await anon('GET', `${S}/lore/${shared.id}`)).status, 200, 'a shared entry reads fine');

const w = (await anon('GET', S)).body;
is(w.role, 'read', 'the reader is pinned to the lowest tier');
is(w.members, undefined, 'the members ledger is stripped');
is(w.shares, undefined, 'the token list is stripped — a reader cannot mint another link');

// --- the allowlist -----------------------------------------------------------
for (const [suffix, what] of [
  ['/campaigns', 'campaigns (they carry join codes)'],
  [`/lore/${shared.id}/history`, 'version history'],
  [`/lore/${shared.id}/assets`, 'the asset manifest'],
  ['/members', 'the members ledger'],
  ['/proposals', 'the proposals queue'],
  ['/assets', 'the world file list'],
  ['/shares', 'the share-token list'],
]) {
  const r = await anon('GET', `${S}${suffix}`);
  is(r.status === 404 || r.status === 401 || r.status === 403, true, `blocked: ${what}`);
}

// --- no writes ---------------------------------------------------------------
for (const [method, suffix] of [['POST', '/lore'], ['PUT', `/lore/${shared.id}`], ['DELETE', `/lore/${shared.id}`], ['PUT', '/calendar']]) {
  is((await anon(method, `${S}${suffix}`)).status, 403, `${method} ${suffix || '/'} is refused — the link is read-only`);
}

// --- bad and expired tokens --------------------------------------------------
is((await anon('GET', '/api/share/world/' + 'z'.repeat(64))).status, 404, 'an unknown token 404s');
{
  const f = path.join(DATA, 'worlds.json');
  const worlds = JSON.parse(fs.readFileSync(f, 'utf8'));
  const s = worlds.find(x => x.id === world.id).shares.find(x => x.token === share.token);
  s.expiresAt = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(f, JSON.stringify(worlds, null, 2));
  is((await anon('GET', S)).status, 410, 'an expired link reports 410, not 404');
  s.expiresAt = new Date(Date.now() + 86400000).toISOString();
  fs.writeFileSync(f, JSON.stringify(worlds, null, 2));
}

// --- revoke ------------------------------------------------------------------
is((await req('gm', 'GET', `/api/worlds/${world.id}/shares`)).body.length, 1, 'the owner sees one active link');
await req('gm', 'DELETE', `/api/worlds/${world.id}/shares/${share.token}`);
is((await anon('GET', S)).status, 404, 'a revoked link stops working immediately');

srv.kill();
console.log(`\n${ok} passed, ${fails} failed`);
if (fails) { console.log('\n--- server log ---\n' + log.slice(-3000)); }
process.exit(fails ? 1 : 0);

// backend/diceMacros_test.mjs — dice-tray macro sidecar, route level.
//
// Boots the REAL server on a throwaway data dir and drives the macro routes
// over HTTP as the character's owner and as a stranger. End-to-end rather than
// unit, for the reason sysrefRoutes_test.mjs gives: a route that was never
// wired is invisible to a unit test AND to the client (the SPA catch-all hands
// back index.html and the fetch just quietly does nothing) — which is exactly
// how §4j's category-config PUT shipped broken.
//
// Run with `node diceMacros_test.mjs`.
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'macros-'));
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
  try { json = await r.json(); } catch { /* index.html from the SPA catch-all */ }
  return { status: r.status, body: json };
}

const PW = 'correct-horse-battery-staple-42';
await req('owner', 'POST', '/api/setup', { username: 'owneruser', password: PW });
await req('owner', 'POST', '/api/login', { username: 'owneruser', password: PW });
await req('owner', 'POST', '/api/users', { username: 'stranger', password: PW, role: 'player' });
await req('stranger', 'POST', '/api/login', { username: 'stranger', password: PW });

// Characters are created by PUT with a client-minted id (there is no POST
// /api/characters) — the id is the filename, so the client owns it.
const char = { id: 'testchar1' };
await req('owner', 'PUT', `/api/characters/${char.id}`, { id: char.id, name: 'Rook' });

console.log('\nDice macro routes');

// --- default state -----------------------------------------------------------
is((await req('owner', 'GET', `/api/characters/${char.id}/macros`)).body, [],
   'a character with no macros returns an empty list, not a 404');

// --- round trip --------------------------------------------------------------
// Two pages holding DIFFERENT numbers of macros — pages are not a fixed-size
// grid, which is the whole point of the storage shape.
const put = await req('owner', 'PUT', `/api/characters/${char.id}/macros`, {
  pages: [
    { macros: [{ id: 'aaa', name: 'Sword', notation: '2d6+3' },
               { id: 'bbb', name: 'Dodge', notation: '1d20' }] },
    { macros: [{ id: 'ccc', name: 'Fireball', notation: '8d6' }] },
  ],
});
is(put.status, 200, 'PUT reaches a real route (not the SPA catch-all)');
is(put.body.map(p => p.macros.length), [2, 1], 'pages keep their own macro counts');
is((await req('owner', 'GET', `/api/characters/${char.id}/macros`)).body[0].macros[0],
   { id: 'aaa', name: 'Sword', notation: '2d6+3' }, 'a macro round-trips intact');

// --- storage layout ----------------------------------------------------------
is(fs.existsSync(path.join(DATA, 'characters', 'owneruser', `${char.id}.macros.json`)), true,
   'macros land in the ${id}.macros.json sidecar');

// --- normalisation -----------------------------------------------------------
const dirty = await req('owner', 'PUT', `/api/characters/${char.id}/macros`, {
  pages: [{ macros: [
    { name: '  Padded  ', notation: '  1d4  ' },          // trimmed, id minted
    { name: 'No notation', notation: '   ' },              // dropped
    { name: 'x'.repeat(80), notation: '1d6' },             // name capped
    'garbage',                                             // dropped
  ] }],
});
const cleaned = dirty.body[0].macros;
is(cleaned.length, 2, 'macros with no notation, and non-objects, are dropped');
is([cleaned[0].name, cleaned[0].notation], ['Padded', '1d4'], 'name and notation are trimmed');
is(typeof cleaned[0].id === 'string' && cleaned[0].id.length > 0, true,
   'a missing id is minted server-side');
is(cleaned[1].name.length, 40, 'an over-long name is capped');

// --- bad payloads ------------------------------------------------------------
is((await req('owner', 'PUT', `/api/characters/${char.id}/macros`, { pages: 'nope' })).status, 400,
   'a non-array pages payload is rejected');
is((await req('owner', 'GET', `/api/characters/${char.id}/macros`)).body[0].macros.length, 2,
   'a rejected save leaves the stored macros untouched');

// --- authorization -----------------------------------------------------------
// Macros are the owner's private shortcuts, same posture as the roll log.
// 403 (not the worlds side's 404): requireCharOwner is the character-side guard
// and the app's existing convention there is to refuse, not to hide existence.
is((await req('stranger', 'GET', `/api/characters/${char.id}/macros`)).status, 403,
   'a stranger cannot read another user\'s macros');
is((await req('stranger', 'PUT', `/api/characters/${char.id}/macros`, { pages: [] })).status, 403,
   'a stranger cannot write another user\'s macros');
is((await req('anon', 'GET', `/api/characters/${char.id}/macros`)).status, 401,
   'an unauthenticated request is rejected');

// --- cleanup on character delete --------------------------------------------
await req('owner', 'DELETE', `/api/characters/${char.id}`);
is(fs.existsSync(path.join(DATA, 'characters', 'owneruser', `${char.id}.macros.json`)), false,
   'deleting a character sweeps its macro sidecar');

srv.kill();
console.log(`\n${ok} passed, ${fails} failed`);
if (fails) { console.log('\n--- server log ---\n' + log.slice(-3000)); }
process.exit(fails ? 1 : 0);

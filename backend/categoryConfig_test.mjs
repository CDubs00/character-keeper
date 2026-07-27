// backend/categoryConfig_test.mjs — §4j per-world category rename/hide, over HTTP.
//
// Written after a live bug: `PUT /api/worlds/:id/categories/config` was NEVER
// IMPLEMENTED, while the frontend and the api.js wrapper for it both existed and
// the section was documented as BUILT. The PUT fell through to the SPA catch-all,
// got index.html back, and the UI silently did nothing (and flickered, as
// fetchWithRetry retried the un-parseable response).
//
// The lesson this file encodes: a route's absence is invisible to unit tests and
// to the client, so the guarantee has to be exercised end-to-end. It also pins the
// REPLACE-not-merge semantics, which is what makes un-hiding possible at all —
// merging would keep a stale `{hidden:true}` forever and a category could be
// hidden but never shown again.
//
// Run with `node categoryConfig_test.mjs`.
import { spawn } from 'child_process'; import fs from 'fs'; import os from 'os'; import path from 'path';
import { fileURLToPath } from 'url';
const REPO=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const DATA=fs.mkdtempSync(path.join(os.tmpdir(),'cat-')); const PORT=4900+Math.floor(Math.random()*200);
const BASE=`http://127.0.0.1:${PORT}`;
const srv=spawn('node',['server.js'],{cwd:REPO+'/backend',env:{...process.env,DATA_DIR:DATA,PORT:String(PORT),
  BUNDLES_DIR:REPO+'/bundles',SEED_PACKS_DIR:REPO+'/packs',SESSION_SECRET:'x'.repeat(40),CSRF_ENFORCE:'false',NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
let log=''; srv.stdout.on('data',d=>log+=d); srv.stderr.on('data',d=>log+=d);
process.on('uncaughtException',e=>{srv.kill();console.error(e);console.log(log.slice(-1500));process.exit(1)});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
for(let i=0;i<60;i++){try{await fetch(BASE+'/api/x');break}catch{await sleep(200)}}
const jar=new Map();
async function q(m,u,b){const h={'Content-Type':'application/json'};if(jar.size)h.Cookie=[...jar].map(([k,v])=>k+'='+v).join('; ');
 const r=await fetch(BASE+u,{method:m,headers:h,body:b?JSON.stringify(b):undefined});
 for(const c of (r.headers.getSetCookie?.()||[])){const[p]=c.split(';');const i=p.indexOf('=');jar.set(p.slice(0,i),p.slice(i+1));}
 let j=null;try{j=await r.json()}catch{} return {status:r.status,body:j};}
let ok=0,bad=0; const is=(a,e,m)=>{ if(JSON.stringify(a)===JSON.stringify(e)){ok++;console.log('  ok   '+m);} else {bad++;console.log('  FAIL '+m+'\n       got '+JSON.stringify(a)+' want '+JSON.stringify(e));}};
const PW='correct-horse-battery-staple-42';
await q('POST','/api/setup',{username:'gmuser',password:PW});
await q('POST','/api/login',{username:'gmuser',password:PW});
const w=(await q('POST','/api/worlds',{name:'W'})).body;
console.log('\nCategory config (§4j)');
const vis = async () => (await q('GET',`/api/worlds/${w.id}/categories`)).body.map(c=>c.id+(c.hidden?':HIDDEN':''));
// The baseline is READ from the pack rather than pinned to a literal list: what
// this suite tests is that hiding and un-hiding PERSIST, not which categories the
// default pack happens to ship. Pinning the list meant adding a category (planes,
// 2026-07-26) failed three checks that have nothing to do with category config.
// `withEventsHidden` keeps the assertions just as strict about ordering and about
// every OTHER category staying untouched.
const base = await vis();
const withEventsHidden = () => base.map(id => id === 'events' ? 'events:HIDDEN' : id);
is(base.every(id => !id.includes(':HIDDEN')), true, 'baseline: nothing hidden');
is(base.includes('events') && base.includes('deities'), true,
   'baseline: the categories this suite manipulates exist');

// hide events + rename deities
let r=await q('PUT',`/api/worlds/${w.id}/categories/config`,{config:{events:{hidden:true},deities:{label:'Powers'}}});
is(r.status,200,'the route exists and answers (it was missing entirely before)');
is(r.body.find(c=>c.id==='events').hidden,true,'save echoes events hidden');
is(r.body.find(c=>c.id==='deities').label,'Powers','save echoes the rename');
is(await vis(), withEventsHidden(), 'hide persists across a fresh GET');

// THE BUG: turn it back on
r=await q('PUT',`/api/worlds/${w.id}/categories/config`,{config:{events:{hidden:false},deities:{label:'Powers'}}});
is(r.body.find(c=>c.id==='events').hidden,false,'un-hiding echoes back visible');
is(await vis(), base, 'UN-HIDE PERSISTS — the reported bug');
is((await q('GET',`/api/worlds/${w.id}/categories`)).body.find(c=>c.id==='deities').label,'Powers',
   'the rename survived the un-hide (config replaced, not clobbered)');

// clearing everything removes the key entirely
await q('PUT',`/api/worlds/${w.id}/categories/config`,{config:{events:{hidden:false},deities:{label:''}}});
const stored=JSON.parse(fs.readFileSync(path.join(DATA,'worlds.json'),'utf8'))[0];
is('categoryConfig' in stored,false,'no overrides ⇒ the key is deleted, not left as {}');
is((await q('GET',`/api/worlds/${w.id}/categories`)).body.find(c=>c.id==='deities').label,'Deities','base label restored');

// junk + authz
is((await q('PUT',`/api/worlds/${w.id}/categories/config`,{config:{nope:{hidden:true},events:'junk'}})).status,200,'junk ids are dropped, not 500');
is(JSON.parse(fs.readFileSync(path.join(DATA,'worlds.json'),'utf8'))[0].categoryConfig,undefined,'…and nothing unknown was stored');
srv.kill(); console.log(`\n${ok} passed, ${bad} failed`); if(bad) console.log(log.slice(-1200));
process.exit(bad?1:0);

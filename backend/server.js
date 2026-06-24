const express   = require('express');
const fs        = require('fs');
const path      = require('path');
const crypto    = require('crypto');
const multer    = require('multer');
const session   = require('express-session');
const bcrypt    = require('bcrypt');
const rateLimit = require('express-rate-limit');
const helmet    = require('helmet');
const sheets    = require('./sheets');
const { loadSchema } = sheets;
const { validateUsername } = require('./validateUsername');
const pkg = require('./package.json');
const { zipSync } = require('fflate');

const app      = express();
const PORT     = process.env.PORT     || 3001;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const USERS_FILE      = path.join(DATA_DIR, 'users.json');
const CAMPAIGNS_FILE  = path.join(DATA_DIR, 'campaigns.json');
const CHARS_DIR       = path.join(DATA_DIR, 'characters');  // ← new





// App/config files that must never be treated as character data, even if they
// somehow land inside the characters tree (e.g. a misconfigured volume).
const RESERVED_JSON = new Set(['settings.json', 'users.json', 'campaigns.json', 'sheets-registry.json']);

// ---------------------------------------------------------------------------
// Attachments
//
// Non-portrait files a player can keep with a character (handouts, backstory
// PDFs, loot spreadsheets, maps). Gated behind the admin `allowAttachments`
// setting. Blobs live as flat siblings next to the character, named with a
// SERVER-generated token — `${id}.attach.<key>.<ext>` — so the user's original
// filename never touches the filesystem (no path traversal, no header
// injection). The human name, mime, size, sha-256 and upload metadata live in a
// manifest sidecar `${id}.attachments.json`.
//
// Security model is "store inert, serve guarded": an allowlist (NOT a denylist
// — denylists of "executable" extensions are endlessly bypassable), a magic-byte
// sniff so a renamed evil.exe→backstory.pdf is caught, and a download route that
// pins Content-Type from a fixed map + nosniff + forces a download for anything
// the browser could execute. Active-content image types (svg) and containers
// (zip/html/json) are deliberately absent.
// ---------------------------------------------------------------------------

// extension (no dot, lowercase) → mime served on download
const ATTACH_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  pdf: 'application/pdf',
  txt: 'text/plain', md: 'text/plain', csv: 'text/csv',
  doc:  'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls:  'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const ATTACH_EXTS = new Set(Object.keys(ATTACH_MIME));

// Types safe to hand back with `Content-Disposition: inline` (the client renders
// them — images in an <img>, pdf via pdf.js, text/csv/md as text). Everything
// else (the Office binaries) is forced to download. Even inline types are sent
// with nosniff and a pinned Content-Type so the browser can't be tricked into
// treating, say, a .txt as HTML.
const ATTACH_INLINE = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'pdf', 'txt', 'md', 'csv']);

const ATTACH_MAX_BYTES      = Number(process.env.ATTACH_MAX_BYTES)      || 25 * 1024 * 1024;  // per file
const ATTACH_MAX_PER_CHAR   = Number(process.env.ATTACH_MAX_PER_CHAR)   || 50;                // count cap
const ATTACH_MAX_TOTAL_BYTES= Number(process.env.ATTACH_MAX_TOTAL_BYTES)|| 250 * 1024 * 1024; // sum cap

// Leading-bytes signatures. Confirms the file really is what its extension
// claims. Text types (txt/md/csv) have no signature — they're inert text, so we
// accept them on the extension allowlist alone. Office Open XML (docx/xlsx) are
// zip containers ("PK\x03\x04"); legacy doc/xls are OLE compound files.
function sniffMagic(ext, buf) {
  if (!buf || buf.length < 4) return false;
  const hex = buf.slice(0, 8).toString('hex').toUpperCase();
  const ascii = buf.slice(0, 12).toString('latin1');
  switch (ext) {
    case 'png':  return hex.startsWith('89504E47');
    case 'jpg':
    case 'jpeg': return hex.startsWith('FFD8FF');
    case 'gif':  return ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a');
    case 'webp': return ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP';
    case 'pdf':  return ascii.startsWith('%PDF-');
    case 'docx':
    case 'xlsx': return hex.startsWith('504B0304') || hex.startsWith('504B0506') || hex.startsWith('504B0708');
    case 'doc':
    case 'xls':  return hex.startsWith('D0CF11E0A1B11AE1');
    case 'txt':
    case 'md':
    case 'csv':  return true; // inert text — nothing to verify
    default:     return false;
  }
}

// Strip anything that could break out of a Content-Disposition header, and
// provide an RFC 5987 encoding for non-ASCII names so "naïve résumé.pdf" works.
function dispositionFilename(name) {
  const ascii = String(name || 'file').replace(/[\r\n"\\]/g, '_').replace(/[^\x20-\x7E]/g, '_');
  const utf8  = encodeURIComponent(String(name || 'file')).replace(/['()]/g, escape);
  return `filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

// Built-in sidecar paths that apply to EVERY character regardless of bundle, so
// no bundle author has to declare them. `attachments` is the manifest; keeping
// it out of the main envelope (like sessions) means the roster read stays cheap
// and autosave can't race the upload endpoints. See getSidecarPaths below.
const BUILTIN_SIDECARS = ['attachments'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getUsers() {
  if (!fs.existsSync(USERS_FILE)) return [];
  return JSON.parse(fs.readFileSync(USERS_FILE));
}

// ---------------------------------------------------------------------------
// First-launch admin bootstrap
//
// If INITIAL_ADMIN_USERNAME and INITIAL_ADMIN_PASSWORD are both set and that
// user doesn't already exist, create them as an admin on startup. Lets a fresh
// deployment come up with a working login without exec-ing into the container.
// Idempotent: once the user exists, it's never touched again, so leaving the
// env vars in place across restarts is harmless.
//
// If no users exist AND no bootstrap vars are set, log a loud warning so a
// fresh install doesn't silently come up with no way to log in.
// ---------------------------------------------------------------------------
function seedInitialAdmin() {
  const username = String(process.env.INITIAL_ADMIN_USERNAME || '').trim();
  const password = String(process.env.INITIAL_ADMIN_PASSWORD || '');
  const users = getUsers();

  if (username && password) {
    if (users.find(u => u.username === username)) return;  // already created
    users.push({
      username,
      password: bcrypt.hashSync(password, 10),
      admin:  true,
      gm:     false,
      player: false,
    });
    saveUsers(users);
    console.log(`[auth] Created initial admin "${username}" from INITIAL_ADMIN_* env vars`);
    console.log('[auth] You can remove INITIAL_ADMIN_PASSWORD from the container config now.');
    return;
  }

  if (users.length === 0) {
    console.warn('[auth] No users exist and no INITIAL_ADMIN_* env vars set.');
    console.warn('[auth] Set those vars and restart, or run: node adduser.js <username> <password> --admin');
  }
}

function getCampaigns() {
  if (!fs.existsSync(CAMPAIGNS_FILE)) return [];
  return JSON.parse(fs.readFileSync(CAMPAIGNS_FILE));
}

function saveCampaigns(campaigns) {
  fs.writeFileSync(CAMPAIGNS_FILE, JSON.stringify(campaigns, null, 2));
}

function requireAuth(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

// Character / campaign ids are slug-suffix or 12-char tokens. Reject anything
// with path separators, dots, or other surprises before it reaches the
// filesystem. Use as: if (!safeId(req.params.id)) return res.status(400)...
function safeId(id) {
  return typeof id === 'string' && /^[a-z0-9-]{1,80}$/i.test(id);
}

// Minimum password policy, shared by setup, admin-create, and password reset.
// Length beats composition rules (NIST 800-63B), so we set a floor and otherwise
// stay out of the way — long passphrases are encouraged. Returns an error string,
// or null when the password passes. Bump MIN_PASSWORD_LENGTH to raise the floor.
const MIN_PASSWORD_LENGTH = 10;
function passwordError(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  return null;
}

// Reject malformed ids before any route touches the filesystem. safeId() bars
// path separators and dots, so charPath()/portraitPath() can't be tricked into
// writing outside the user's folder. As middleware it must sit BEFORE the handler
// (and before multer) so a bad id never reaches disk.
function validId(req, res, next) {
  if (!safeId(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
  next();
}

function requireGM(req, res, next) {
  if (!req.session?.user?.gm && !req.session?.user?.admin) {
    return res.status(403).json({ error: 'GM role required' });
  }
  next();
}

// Owner-or-admin guard for routes that MUTATE a character (uploads, attachment
// add/delete). Resolves the character once and stashes it on req.foundChar so
// the handler doesn't look it up again. Place it AFTER validId and BEFORE any
// multer middleware, so an unauthorized request never buffers an upload.
// (The portrait endpoint predates this and should be retrofitted with it.)
function requireCharOwner(req, res, next) {
  const found = findCharFile(req.params.id);
  if (!found) return res.status(404).json({ error: 'Not found' });
  if (!req.session.user.admin && found.username !== req.session.user.username) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  req.foundChar = found;
  next();
}

// Cryptographically secure token — share/edit links grant access, so these
// must not be guessable. Math.random() is predictable; crypto.randomBytes is not.
// Charset is URL-safe (no punctuation that needs escaping in a link).
function generateToken(length = 32) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(length);
  let token = '';
  for (let i = 0; i < length; i++) token += chars[bytes[i] % chars.length];
  return token;
}

function generateJoinCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  const bytes = crypto.randomBytes(6);
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[bytes[i] % chars.length];
  return code;
}

// ---------------------------------------------------------------------------
// File paths — characters now live in /data/characters/:username/
// ---------------------------------------------------------------------------

// Returns the directory for a user's characters
function userCharDir(username) {
  return path.join(CHARS_DIR, username);
}


function slugify(name) {
  return (name || 'character')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

// Ensures user char directory exists
function ensureUserCharDir(username) {
  const dir = userCharDir(username);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Recursively find all character JSON files under CHARS_DIR
//
// "Character file" means `${id}.json` where id passes safeId() — a-z 0-9 dash,
// no dots. Sidecar files like `${id}.sessions.json` have an extra dot in the
// stem and are deliberately excluded here, so the roster, share-token scan, and
// every other consumer of this helper see only true character envelopes.
function findAllCharFiles() {
  const results = [];
  if (!fs.existsSync(CHARS_DIR)) return results;
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.json') && !RESERVED_JSON.has(entry.name)) {
        const stem = entry.name.slice(0, -5);  // strip .json
        if (!safeId(stem)) continue;            // skips ${id}.sessions.json and friends
        results.push(full);
      }
    }
  }
  walk(CHARS_DIR);
  return results;
}

// Find a single character file by ID, scanning recursively
function findCharFile(id) {
  if (!fs.existsSync(CHARS_DIR)) return null;
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const result = walk(full);
        if (result) return result;
      } else if (entry.isFile() && entry.name === `${id}.json`) {
        // Derive username from the path: CHARS_DIR/username/...
        const rel      = path.relative(CHARS_DIR, full);
        const username = rel.split(path.sep)[0];
        return { filePath: full, username };
      }
    }
    return null;
  }
  return walk(CHARS_DIR);
}

// Get char path for a known owner
function charPath(username, id) {
  return path.join(userCharDir(username), `${id}.json`);
}

// Portrait path for a known owner
function portraitPath(username, id, ext) {
  return path.join(userCharDir(username), `${id}.portrait${ext}`);
}

// All of a character's files live in the owner's dir, named `${id}.<role>`:
// `${id}.json` is the character itself, `${id}.portrait.<ext>` is the portrait,
// `${id}.sessions.json` is the (optional) sidecar for session notes, and
// anything we add later follows the same prefix. Because ids can't contain a
// dot (see safeId), `${id}.` is an unambiguous boundary — a longer id's files
// start with extra id chars, never a dot, so they can't be mistaken for this
// character's. Returns [{ full, suffix, zipName }] — suffix is the raw piece
// after `${id}.` (used by rename/delete to reconstruct under a new id), zipName
// is the friendly name used inside the export ZIP.
function collectCharacterFiles(username, id) {
  const dir = userCharDir(username);
  if (!fs.existsSync(dir)) return [];
  const prefix = `${id}.`;
  return fs.readdirSync(dir)
    .filter(name => name.startsWith(prefix))
    .map(name => {
      const suffix  = name.slice(prefix.length);                       // "json" | "portrait.png" | "sessions.json"
      const zipName = suffix === 'json' ? 'character.json' : suffix;   // friendlier filename inside the ZIP
      return { full: path.join(dir, name), suffix, zipName };
    });
}

// ---------------------------------------------------------------------------
// Attachment storage helpers
//
// Blob lives at `${id}.attach.<key>.<ext>`; the manifest is the `attachments`
// sidecar at `${id}.attachments.json`. The manifest is the source of truth for
// what exists and its metadata — the blobs are dumb bytes named by token. We
// read/write the manifest directly here (the upload/delete endpoints own it),
// which is also why the PUT save reads `attachments` from disk rather than the
// client body (field ownership, same as shares/status).
// ---------------------------------------------------------------------------

function attachBlobPath(username, id, key, ext) {
  return path.join(userCharDir(username), `${id}.attach.${key}.${ext}`);
}

function readManifest(username, id) {
  const p = sidecarFilePath(username, id, 'attachments');
  if (!fs.existsSync(p)) return [];
  try {
    const v = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(v) ? v : [];
  } catch {
    return []; // a corrupt manifest shouldn't break the character
  }
}

function writeManifest(username, id, list) {
  fs.writeFileSync(sidecarFilePath(username, id, 'attachments'), JSON.stringify(list, null, 2));
}

// ---------------------------------------------------------------------------
// Sidecar storage
//
// A bundle can opt to keep some top-level character fields out of the main
// envelope by declaring `"sidecarPaths": ["sessions", ...]` in its schema.json.
// Each declared path lives in its own file alongside the character:
//
//     /data/characters/<user>/<id>.json            ← envelope (stats, gear, …)
//     /data/characters/<user>/<id>.sessions.json   ← sidecar value
//
// readCharFull() pulls everything back together, so the renderer sees the
// character exactly as it does today — sidecar paths just appear as plain
// top-level keys. writeCharSplit() peels them back apart on save.
//
// Why bother?
//   • The roster (GET /api/characters) reads every main file on every load.
//     Keeping multi-MB session journals out of the envelope keeps that fast
//     even as a campaign's history grows for years.
//   • Each sidecar is rewritten only when its data actually changes (well —
//     when the character is saved at all; same as today, but the main file
//     stays small so writes are cheaper too).
//   • The mechanism is fully bundle-driven. The server doesn't know "sessions"
//     means anything special — it just splits whatever the schema declares.
//
// Lazy migration: a legacy character with `sessions` still in the main file
// keeps working — readCharFull() returns the embedded value when no sidecar
// exists, and the next save peels it out. No migration script needed.
// ---------------------------------------------------------------------------

function getSidecarPaths(sheetId) {
  if (!sheetId) return [...BUILTIN_SIDECARS];
  try {
    const schema = loadSchema(DATA_DIR, sheetId);
    const declared = Array.isArray(schema?.sidecarPaths) ? schema.sidecarPaths : [];
    // Union built-ins (attachments) with whatever the bundle declared (sessions,
    // …), de-duped. Built-ins apply even when a bundle declares none.
    return [...new Set([...BUILTIN_SIDECARS, ...declared])];
  } catch {
    // Bundle missing, schema unparseable, etc. — degrade to built-ins only so
    // the character still loads/saves. A misconfigured bundle shouldn't brick
    // characters that were created under it.
    return [...BUILTIN_SIDECARS];
  }
}

function sidecarFilePath(username, id, key) {
  return path.join(userCharDir(username), `${id}.${key}.json`);
}

// ── Search path safety ──────────────────────────────────────────────────────
// A bundle's "searchable" map is author-controlled. Bundles are TRUSTED in the
// admin-installed model (only the operator can drop a bundle into /bundles),
// but these guards are trust-independent hygiene: they bound how much work the
// server will do on behalf of a search query regardless of how the bundle's
// shape, path declarations, or stored data look.
//
// SEARCH_MAX_DEPTH:  cap on dotted-path SEGMENTS in a single searchable entry.
//                    Stops absurdly nested declarations like "a.b.c.d.e.f.g.h".
// SEARCH_MAX_LEAVES: per-path cap on STRING LEAVES the resolver will visit
//                    during a single getSearchable() entry's walk (hardening
//                    #6). When a path hops through arrays, the leaf count
//                    multiplies — `inventory.items.notes` against a character
//                    with 10k items walks 10k leaves; with nested arrays it's
//                    worse. Real characters won't come close to 500; a hostile
//                    or buggy shape with a million entries gets stopped early.
//                    Path-depth caps (above) don't help here because the
//                    blow-up is WIDTH (array size), not depth.
const SEARCH_MAX_DEPTH  = 6;
const SEARCH_MAX_LEAVES = 500;
const UNSAFE_PATH_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

function isSafeSearchPath(path) {
  if (typeof path !== 'string') return false;
  const parts = path.split('.');
  if (parts.length === 0 || parts.length > SEARCH_MAX_DEPTH) return false;
  return parts.every(seg => seg.length > 0 && !UNSAFE_PATH_SEGMENTS.has(seg));
}

// Read a bundle's "searchable" map (dotted-path -> display label). Mirrors
// getSidecarPaths: a missing/garbled map degrades to {} so search still runs
// (name + sessions) for that character rather than erroring. Unsafe or
// malformed paths are silently dropped here, so the resolver only ever sees
// paths that already passed the safety check.
function getSearchable(sheetId) {
  if (!sheetId) return {};
  try {
    const schema = loadSchema(DATA_DIR, sheetId);
    const map = schema && schema.searchable;
    if (!map || typeof map !== 'object' || Array.isArray(map)) return {};
    const safe = {};
    for (const [path, label] of Object.entries(map)) {
      if (typeof label === 'string' && isSafeSearchPath(path)) safe[path] = label;
    }
    return safe;
  } catch {
    return {};
  }
}

// Read a character + merge any sidecar files. The returned shape is identical
// to what the renderer expects today; sidecar paths just appear as plain
// top-level keys. `found` is whatever findCharFile() returned.
function readCharFull(found) {
  const main  = JSON.parse(fs.readFileSync(found.filePath, 'utf8'));
  const paths = getSidecarPaths(main.sheetId);
  if (paths.length === 0) return main;

  for (const key of paths) {
    const sidecarPath = sidecarFilePath(found.username, main.id, key);
    if (fs.existsSync(sidecarPath)) {
      try {
        main[key] = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
      } catch (e) {
        // A corrupt sidecar shouldn't kill the load. Log and fall back to
        // whatever's in the main file (typically nothing, but a legacy file
        // may still have the embedded value).
        console.error(`[sidecar] Failed to parse ${sidecarPath}: ${e.message}`);
      }
    }
    // else: no sidecar yet — leave main[key] as-is (either the legacy embedded
    // value, or undefined for a fresh character).
  }
  return main;
}

// Write a character, splitting any declared sidecar paths into their own files.
// Returns the data that was written to the main envelope (without sidecar
// fields). Callers that need the merged shape for the response should compose
// it themselves; in practice we just re-read with readCharFull when the
// response actually needs to include the sidecar values.
function writeCharSplit(username, id, data) {
  ensureUserCharDir(username);
  const paths = getSidecarPaths(data.sheetId);

  // Shallow-clone before mutating so we don't surprise the caller.
  const main = { ...data };
  for (const key of paths) {
    const value = data[key];
    delete main[key];
    // Only write the sidecar if there's actually a value. A bundle that
    // declares `sidecarPaths: ["sessions"]` but has no sessions yet shouldn't
    // accumulate empty `[]` files just from being saved.
    if (value !== undefined && value !== null) {
      fs.writeFileSync(sidecarFilePath(username, id, key), JSON.stringify(value, null, 2));
    }
  }

  fs.writeFileSync(charPath(username, id), JSON.stringify(main, null, 2));
  return main;
}

// ---------------------------------------------------------------------------
// Roll log
//
// A lightweight, host-owned event log of dice rolls per character. Deliberately
// NOT one of the bundle-declared sidecarPaths above:
//   • It's owned by the dice tray (a host/core feature), so no bundle needs to
//     opt in via schema.json for it to work — every bundle with dice enabled
//     gets it automatically.
//   • It's append-only and fires on every roll. Routing it through the full
//     character read-modify-write (readCharFull/writeCharSplit) would mean a
//     full document round-trip per roll, and would race the sheet's own
//     debounced autosave (CharacterSheet.jsx) if both fired close together.
//
// Storage still follows the `${id}.<role>.json` convention, so it's picked up
// for free by collectCharacterFiles() — rename renames it, delete removes it,
// the legacy raw export includes it — and excluded from the roster scan by
// findAllCharFiles()'s safeId(stem) check, exactly like `${id}.sessions.json`.
//
// Newest-first, capped at ROLLS_MAX entries.
//
// `source` is reserved, not yet populated by anything: a future "roll from
// this field" trigger (e.g. a Sword Attack button on the sheet) can label an
// entry with the field's name without a schema or storage change.
// ---------------------------------------------------------------------------
const ROLLS_MAX = 50;

function rollsFilePath(username, id) {
  return path.join(userCharDir(username), `${id}.rolls.json`);
}

function readRolls(username, id) {
  const p = rollsFilePath(username, id);
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error(`[rolls] Failed to parse ${p}: ${e.message}`);
    return [];
  }
}

function appendRoll(username, id, entry) {
  const rolls = readRolls(username, id);
  rolls.unshift(entry);
  if (rolls.length > ROLLS_MAX) rolls.length = ROLLS_MAX;
  fs.writeFileSync(rollsFilePath(username, id), JSON.stringify(rolls, null, 2));
  return rolls;
}

// ---------------------------------------------------------------------------
// Express setup
// ---------------------------------------------------------------------------

const isProd = process.env.NODE_ENV === 'production';

// NPM (Nginx Proxy Manager) terminates TLS and forwards over http with
// X-Forwarded-* headers. Trust the first proxy hop so express-session sees the
// request as secure and express-rate-limit reads the real client IP.
app.set('trust proxy', 2);

// Security headers — addresses the ZAP "header not set" cluster (CSP,
// clickjacking, nosniff, HSTS) and hides X-Powered-By in one place.
//
// CSP rollout controls (env-gated so enforcement is a deploy flag you can flip
// and roll back instantly, not a code edit). Defaults reproduce today's exact
// behaviour: report-only, with 'unsafe-inline' still allowed in scriptSrc.
//
//   CSP_ENFORCE=true        → switch from Report-Only to enforced. Do this only
//                             AFTER watching the browser console (report-only)
//                             come back clean against your real bundles, and
//                             after the bundle-hardening pass (attribute
//                             allowlist / DOMPurify / off-origin blocking) lands.
//   CSP_INLINE_SCRIPT=false → drop 'unsafe-inline' from scriptSrc. Set this only
//                             after rebuilding the frontend with
//                             INLINE_RUNTIME_CHUNK=false (that env removes CRA's
//                             inlined runtime <script>, which is the only reason
//                             scriptSrc needs 'unsafe-inline' today). Verify in
//                             report-only first, then enforce.
//
// styleSrc keeps 'unsafe-inline' permanently: this app uses React inline styles
// throughout plus an injected <style> for bundle themes, which can't be nonce'd
// without a large refactor. styleSrc 'unsafe-inline' is far lower risk than the
// scriptSrc equivalent, so that's an acceptable resting state.
const cspEnforce      = process.env.CSP_ENFORCE === 'true';
const cspInlineScript = process.env.CSP_INLINE_SCRIPT !== 'false'; // default: allow
// scriptSrc components:
//   'self'              — our own bundled JS
//   'unsafe-inline'     — gated by CSP_INLINE_SCRIPT (CRA's inlined runtime chunk)
//   'wasm-unsafe-eval'  — required by dice-box. It uses ammo.js, a WebAssembly
//                         port of Bullet physics, and WebAssembly compilation is
//                         governed by script-src. This is NOT the broad
//                         'unsafe-eval': it permits WASM module compilation only,
//                         not eval()/new Function(). The wasm sandbox is its own
//                         thing — no direct DOM access. Adding it is the
//                         standard way to allow WebAssembly under a strict CSP.
const scriptSrc       = [
  "'self'",
  ...(cspInlineScript ? ["'unsafe-inline'"] : []),
  "'wasm-unsafe-eval'",
];

// CSP is REPORT-ONLY by default: this app uses React inline styles, an injected
// <style> element for bundle themes, and (from CRA) an inlined runtime script
// chunk — a strict enforced CSP would break those. Report-only lets you watch
// the browser console for violations without breaking anything. Drive the
// console to zero violations, then set CSP_ENFORCE=true (see the toggles above).
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    reportOnly: !cspEnforce,
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc,                                              // 'unsafe-inline' gated by CSP_INLINE_SCRIPT
      styleSrc:       ["'self'", "'unsafe-inline'"],          // permanent: React inline styles + bundle theme <style>
      fontSrc:        ["'self'", "data:"],                    // self-hosted fonts; Google Fonts intentionally dropped
      imgSrc:         ["'self'", "data:", "blob:"],
      connectSrc:     ["'self'"],
      objectSrc:      ["'none'"],
      baseUri:        ["'self'"],
      frameAncestors: ["'none'"],
      // dice-box instantiates its physics worker from a blob: URL (a Web Worker
      // bundled into the JS and spawned via URL.createObjectURL). Without an
      // explicit worker-src, the browser falls back to script-src, which doesn't
      // permit blob:. Allow blob: workers from our own origin only — narrow
      // surface, breaks dice rolls without it once CSP is enforced.
      workerSrc:      ["'self'", "blob:"],
    },
  },
  // HSTS only matters over HTTPS (prod, behind NPM). Browsers ignore it on
  // plain-http localhost anyway. You can also set this at NPM/Cloudflare.
  hsts: isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
}));

// SESSION_SECRET must be set in production — a hardcoded fallback would let
// anyone who has seen the source forge a valid session cookie. In dev we fall
// back to a random per-boot secret (logs everyone out on restart, but is safe).
let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  if (isProd) {
    console.error('FATAL: SESSION_SECRET must be set in production.');
    process.exit(1);
  }
  sessionSecret = crypto.randomBytes(32).toString('hex');
  console.warn('[auth] No SESSION_SECRET set — using a random dev secret (sessions reset on restart).');
}

app.use(express.json());
app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure:   isProd,   // HTTPS-only in prod (relies on trust proxy + X-Forwarded-Proto)
    httpOnly: true,     // not readable from JS — mitigates XSS cookie theft
    sameSite: 'lax',    // primary CSRF defense for cookie-based auth
    maxAge:   1000 * 60 * 60 * 24 * 7,
  },
}));

// ---------------------------------------------------------------------------
// CSRF — synchronizer-token defence, layered on top of sameSite=lax.
//
// sameSite=lax already blocks the main CSRF vector (a foreign site can't make
// the browser send our session cookie on a cross-site POST/PUT/DELETE). This
// adds belt-and-suspenders for the gaps lax doesn't fully cover (older browsers,
// same-registrable-domain siblings).
//
// Mechanism (two middlewares):
//   1. ISSUER: for any authenticated request, mint a per-session token (once)
//      and mirror it into a NON-httpOnly `XSRF-TOKEN` cookie so the SPA's JS can
//      read it. The session cookie itself stays httpOnly; this readable cookie
//      only carries the CSRF token, which isn't a secret in the way the session
//      id is (an XSS that can read it has already defeated CSRF defences anyway).
//   2. VALIDATOR: on state-changing methods, require an `X-CSRF-Token` header
//      that matches the session token. The frontend echoes the cookie back via a
//      global fetch interceptor (see index.js), so every same-origin mutation
//      carries it automatically.
//
// Enforcement is gated behind CSRF_ENFORCE so it can be smoke-tested and rolled
// back via a deploy var. The issuer always runs (harmless — just sets a cookie);
// only the validator's rejection is gated. Default OFF: deploying this changes
// nothing observable until you opt in. Flip CSRF_ENFORCE=true after verifying
// every mutating flow (save, rename, delete, archive, portrait, attachments,
// share create/delete, campaign join/leave, user admin, settings) still works.
//
// Exempt from validation:
//   • Safe methods (GET/HEAD/OPTIONS) — no state change.
//   • /api/login, /api/logout, /api/setup — auth bootstrap, called before a token
//     exists; login-CSRF impact is low and these stay covered by sameSite=lax.
//   • /api/share/* — used by UNAUTHENTICATED external share-link holders. They
//     have no session and no XSRF cookie; the URL token is the credential, so
//     there's no ambient-cookie CSRF surface here to defend.
// ---------------------------------------------------------------------------
const csrfEnforce = process.env.CSRF_ENFORCE === 'true';
const CSRF_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CSRF_EXEMPT_PATHS = [
  /^\/api\/login$/,
  /^\/api\/logout$/,
  /^\/api\/setup$/,
  /^\/api\/share\//,   // external, unauthenticated share-link writes
];

// Issuer: mint + expose the token for authenticated sessions. Runs for every
// request but only writes when a user is logged in, so anonymous visitors don't
// get a session row (preserves saveUninitialized:false semantics).
app.use((req, res, next) => {
  if (req.session?.user) {
    if (!req.session.csrfToken) req.session.csrfToken = generateToken(32);
    res.cookie('XSRF-TOKEN', req.session.csrfToken, {
      httpOnly: false,   // intentionally readable: the SPA echoes it in a header
      secure:   isProd,
      sameSite: 'lax',
      maxAge:   1000 * 60 * 60 * 24 * 7,
    });
  }
  next();
});

// Validator: reject state-changing requests without a matching token.
app.use((req, res, next) => {
  if (!csrfEnforce) return next();
  if (CSRF_SAFE_METHODS.has(req.method)) return next();
  if (CSRF_EXEMPT_PATHS.some(re => re.test(req.path))) return next();
  const sent = req.get('X-CSRF-Token');
  if (!sent || sent !== req.session?.csrfToken) {
    return res.status(403).json({ error: 'Invalid or missing CSRF token' });
  }
  next();
});

app.use(express.static(path.join(__dirname, 'frontend/build')));

// Serve portraits from the per-user subdirectories, but ONLY image files.
// Character JSON and portrait images share the same folder, so an unguarded
// static mount would expose /portraits/:user/:id.json (the full character file,
// including live share tokens) with no auth. This guard blocks everything that
// isn't an image extension before express.static can serve it.
app.use('/portraits', (req, res, next) => {
  if (!/\.(jpg|jpeg|png|webp|gif)$/i.test(req.path)) {
    return res.status(404).json({ error: 'Not found' });
  }
  next();
}, express.static(CHARS_DIR, {
  index: false,
  setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
}));

// CORS — only needed in dev when the React dev server runs on a different
// origin. Reflecting an arbitrary origin WITH credentials is a credential-theft
// hole, so gate on an explicit allowlist (comma-separated CORS_ORIGINS env var).
// In production the frontend is served from this same origin, so leave it unset.
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH');
    res.header('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Path-traversal guard for every route with an :id param (characters AND
// campaigns). Runs before the handler, so no id with a slash/dot/etc. ever
// reaches charPath() or the filesystem.
app.param('id', (req, res, next, id) => {
  if (!safeId(id)) return res.status(400).json({ error: 'Bad id' });
  next();
});

// Ensure directories exist
if (!fs.existsSync(DATA_DIR))  fs.mkdirSync(DATA_DIR,  { recursive: true });
if (!fs.existsSync(CHARS_DIR)) fs.mkdirSync(CHARS_DIR, { recursive: true });

// Bootstrap a first admin from env vars on a fresh install
seedInitialAdmin();

// Scan sheet bundles
sheets.scanBundles(DATA_DIR);
sheets.registerRoutes(app, DATA_DIR, requireAuth);

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

// Brute-force protection: cap login attempts per IP. Counts all attempts
// (not just failures) so a flood of guesses can't slip through.
const loginLimiter = rateLimit({
  windowMs: 30 * 60 * 1000,   // 30 minutes
  max:      10,               // per IP per window
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many login attempts. Try again later.' },
});

app.post('/api/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  const users = getUsers();
  const user  = users.find(u => u.username === username);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const match = await bcrypt.compare(password, user.password);
  if (!match)  return res.status(401).json({ error: 'Invalid credentials' });
  req.session.user = {
    username: user.username,
    admin:    user.admin    || false,
    gm:       user.gm       || false,
    player:   user.player   || false,
    theme:    user.theme  || getSettings().theme || 'tavern',
    sortBy:   user.sortBy || 'updatedAt',
  };
  res.json(req.session.user);
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
  res.json(req.session.user);
});

// PUT /api/me/preferences — a logged-in user updates their OWN preferences.
//   body: { theme, sortBy }
const VALID_SORT_BY = new Set(['updatedAt', 'name']);

app.put('/api/me/preferences', requireAuth, (req, res) => {
  const users = getUsers();
  const user  = users.find(u => u.username === req.session.user.username);
  if (!user) return res.status(404).json({ error: 'Not found' });

  if ('theme' in req.body) {
    const theme = String(req.body.theme || 'tavern');
    user.theme = theme;
    req.session.user.theme = theme;   // keep the live session in sync
  }

  if ('sortBy' in req.body) {
    // Anything outside the allowlist silently falls back to the default rather
    // than erroring — a stale client sending an old/typo'd value shouldn't be
    // able to wedge a bad value into users.json.
    const sortBy = VALID_SORT_BY.has(req.body.sortBy) ? req.body.sortBy : 'updatedAt';
    user.sortBy = sortBy;
    req.session.user.sortBy = sortBy;
  }

  saveUsers(users);
  res.json({ theme: req.session.user.theme, sortBy: req.session.user.sortBy });
});

// ---------------------------------------------------------------------------
// First-run setup (browser wizard)
//
// When zero users exist, the frontend shows a "create admin" screen instead of
// the login form. POST is gated on there being no users — once the first admin
// exists the window closes permanently and the endpoint returns 403. This is
// the ONLY unauthenticated write in the app; give it a second look in the audit.
// ---------------------------------------------------------------------------
const setupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      10,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many setup attempts. Try again later.' },
});

// GET /api/setup — one bit: is this a fresh, user-less install?
app.get('/api/setup', (req, res) => {
  res.json({ needsSetup: getUsers().length === 0 });
});

// POST /api/setup — create the first admin, but ONLY while no users exist.
app.post('/api/setup', setupLimiter, async (req, res) => {
  if (getUsers().length > 0) {
    return res.status(403).json({ error: 'Setup has already been completed' });
  }

  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  const usernameError = validateUsername(username);
  if (usernameError) {
    return res.status(400).json({ error: usernameError });
  }
  const pwErr = passwordError(password);
  if (pwErr) return res.status(400).json({ error: pwErr });

  const hash = await bcrypt.hash(password, 10);

  // Re-check AFTER the async hash: the window must still be open. Closes the
  // tiny single-process race where two requests both saw zero users.
  if (getUsers().length > 0) {
    return res.status(403).json({ error: 'Setup has already been completed' });
  }

  // First account on a personal instance gets every role so nothing is locked
  // away before the admin panel exists. Change to admin-only here if you prefer.
  saveUsers([{ username, password: hash, admin: true, gm: true, player: true }]);

  // Log them straight in so the wizard lands on the roster.
  req.session.user = { username, admin: true, gm: true, player: true, theme: 'tavern' };
  res.json(req.session.user);
});

// ---------------------------------------------------------------------------
// User management (admin only)
// ---------------------------------------------------------------------------

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function requireAdmin(req, res, next) {
  if (!req.session?.user?.admin) return res.status(403).json({ error: 'Admin role required' });
  next();
}

// Never send password hashes to the client.
const publicUser = (u) => ({ username: u.username, admin: !!u.admin, gm: !!u.gm, player: !!u.player });

// GET /api/users — list all users (no hashes)
app.get('/api/users', requireAuth, requireAdmin, (req, res) => {
  res.json(getUsers().map(publicUser));
});

// POST /api/users — create a user   body: { username, password, admin, gm, player }
app.post('/api/users', requireAuth, requireAdmin, async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });

    const usernameError = validateUsername(username);
  if (usernameError) return res.status(400).json({ error: usernameError });

  const users = getUsers();
  if (users.find(u => u.username === username)) {
    return res.status(409).json({ error: 'A user with that name already exists' });
  }

  const user = {
    username,
    password: await bcrypt.hash(password, 10),
    admin:  !!req.body.admin,
    gm:     !!req.body.gm,
    player: !!req.body.player,
  };
  users.push(user);
  saveUsers(users);
  res.json(publicUser(user));
});

// PATCH /api/users/:username — update roles and/or reset password
//   body may include any of: { admin, gm, player, password }
app.patch('/api/users/:username', requireAuth, requireAdmin, async (req, res) => {
  const users = getUsers();
  const user  = users.find(u => u.username === req.params.username);
  if (!user) return res.status(404).json({ error: 'Not found' });

  // Guard against self-lockout: an admin can't strip their own admin role.
  const self = req.params.username === req.session.user.username;
  if (self && 'admin' in req.body && !req.body.admin) {
    return res.status(400).json({ error: "You can't remove your own admin role" });
  }

  for (const role of ['admin', 'gm', 'player']) {
    if (role in req.body) user[role] = !!req.body[role];
  }
  if (req.body.password) {
    const pwErr = passwordError(String(req.body.password));
    if (pwErr) return res.status(400).json({ error: pwErr });
    user.password = await bcrypt.hash(String(req.body.password), 10);
  }

  saveUsers(users);
  res.json(publicUser(user));
});

// DELETE /api/users/:username
app.delete('/api/users/:username', requireAuth, requireAdmin, (req, res) => {
  if (req.params.username === req.session.user.username) {
    return res.status(400).json({ error: "You can't delete your own account" });
  }
  const users = getUsers();
  if (!users.find(u => u.username === req.params.username)) {
    return res.status(404).json({ error: 'Not found' });
  }
  saveUsers(users.filter(u => u.username !== req.params.username));
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// App settings (single shared file: app-chrome theme + external-link policy)
// ---------------------------------------------------------------------------

const SETTINGS_FILE    = path.join(DATA_DIR, 'settings.json');
const DEFAULT_SETTINGS = { theme: 'tavern', allowExternalLinks: false, allowAttachments: false };

function getSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE)) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(s) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
}

// Public — the renderer and app chrome read theme + link policy even on
// unauthenticated share pages.
app.get('/api/settings', (req, res) => res.json(getSettings()));

// Admin only — update theme and/or link policy.
app.put('/api/settings', requireAuth, requireAdmin, (req, res) => {
  const next = getSettings();
  if ('theme' in req.body)              next.theme = String(req.body.theme || 'tavern');
  if ('allowExternalLinks' in req.body) next.allowExternalLinks = !!req.body.allowExternalLinks;
  if ('allowAttachments' in req.body)   next.allowAttachments   = !!req.body.allowAttachments;
  saveSettings(next);
  res.json(next);
});

// Public — reports the running backend version so you can confirm what's
// actually deployed. Read from package.json at runtime, so bumping the
// version there is the only edit needed.
app.get('/api/version', (req, res) => res.json({ version: pkg.version }));

// ---------------------------------------------------------------------------
// Portrait upload
// ---------------------------------------------------------------------------

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // requireCharOwner runs BEFORE multer (see the route below) and guarantees
    // req.foundChar is the character the requester is allowed to write to. Write
    // into THAT owner's directory. The old code fell back to the session user or
    // 'unknown' when the lookup missed — which is exactly what let a non-owner's
    // upload land in someone else's folder. With the guard in front, foundChar
    // is always present and always the authorized owner.
    const owner = req.foundChar.username;
    const dir   = ensureUserCharDir(owner);
    req.portraitOwner = owner; // stash for filename callback
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${req.params.id}.portrait${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB cap
  fileFilter: (req, file, cb) => {
    const allowed = /\.(jpg|jpeg|png|webp|gif)$/i.test(file.originalname);
    cb(null, allowed);
  },
});

app.post('/api/characters/:id/portrait', requireAuth, validId, requireCharOwner, upload.single('portrait'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });

  const owner = req.portraitOwner || req.session.user.username;
  const portraitUrl = `/portraits/${owner}/${req.file.filename}`;

  // Clean up old portraits with different extensions
  const extensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
  extensions.forEach(ext => {
    const old = portraitPath(owner, req.params.id, ext);
    if (fs.existsSync(old) && old !== req.file.path) fs.unlinkSync(old);
  });

  // Update the character envelope's portrait field. requireCharOwner already
  // resolved and authorized the character, so req.foundChar is guaranteed.
  const found = req.foundChar;
  const char = JSON.parse(fs.readFileSync(found.filePath));
  char.portrait = portraitUrl;
  fs.writeFileSync(found.filePath, JSON.stringify(char, null, 2));

  res.json({ portrait: portraitUrl });
});

// GET portrait — redirect to the static file
app.get('/api/characters/:id/portrait', requireAuth, validId, (req, res) => {
  const found = findCharFile(req.params.id);
  if (!found) return res.status(404).json({ error: 'Character not found' });

  const extensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
  for (const ext of extensions) {
    const p = portraitPath(found.username, req.params.id, ext);
    if (fs.existsSync(p)) {
      return res.redirect(`/portraits/${found.username}/${req.params.id}.portrait${ext}`);
    }
  }
  res.status(404).json({ error: 'No portrait' });
});

// ---------------------------------------------------------------------------
// Attachments — non-portrait files kept with a character.
//   • upload / delete: owner-or-admin, and only when allowAttachments is on
//   • list / download:  mirrors character read visibility (owner, admin, or the
//                        GM of the character's campaign)
// ---------------------------------------------------------------------------

// Read visibility: identical rule to GET /api/characters/:id and export.
function canViewChar(req, found, char) {
  const u = req.session.user;
  if (u.admin || found.username === u.username) return true;
  if (u.gm) {
    const keys = campaignKeySet(getCampaigns().filter(c => c.ownedBy === u.username));
    return matchesCampaign(char.campaignId, keys);
  }
  return false;
}

// Cheap gate so a disabled-feature upload is rejected BEFORE multer buffers it.
function requireAttachmentsOn(req, res, next) {
  if (!getSettings().allowAttachments) return res.status(403).json({ error: 'Attachments are disabled' });
  next();
}

// Buffer in memory so we can magic-byte sniff and hash before anything hits
// disk. Per-file size cap here; count/total caps live in the handler.
const attachUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: ATTACH_MAX_BYTES },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).slice(1).toLowerCase();
    cb(null, ATTACH_EXTS.has(ext)); // drop disallowed extensions before buffering
  },
});

// List the manifest — OR, when ?sha=<hex> is supplied, answer the non-blocking
// duplicate pre-check. The client hashes the file in-browser (SubtleCrypto) and
// calls this first; a match drives the "already added" warning before it decides
// whether to upload.
app.get('/api/characters/:id/attachments', requireAuth, validId, (req, res) => {
  const found = findCharFile(req.params.id);
  if (!found) return res.status(404).json({ error: 'Not found' });
  const char = JSON.parse(fs.readFileSync(found.filePath));
  if (!canViewChar(req, found, char)) return res.status(403).json({ error: 'Forbidden' });

  const list = readManifest(found.username, req.params.id);

  if (req.query.sha) {
    const dupe = list.find(a => a.sha256 === String(req.query.sha).toLowerCase());
    return res.json({ duplicate: dupe ? { name: dupe.name, uploadedAt: dupe.uploadedAt } : null });
  }
  res.json({ attachments: list });
});

// Upload. Allowlist + magic-byte checked, count/size capped, blob written under a
// server token (original name is metadata only). The sha-256 duplicate is NOT
// blocked — we keep the file and report what it matched so the UI can say so.
app.post('/api/characters/:id/attachments',
  requireAuth, validId, requireAttachmentsOn, requireCharOwner, attachUpload.single('file'),
  (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });

    const { username } = req.foundChar;
    const id  = req.params.id;
    const ext = path.extname(req.file.originalname).slice(1).toLowerCase();

    if (!ATTACH_EXTS.has(ext))             return res.status(415).json({ error: 'File type not allowed' });
    if (!sniffMagic(ext, req.file.buffer)) return res.status(415).json({ error: "File contents don't match its type" });

    const list = readManifest(username, id);
    if (list.length >= ATTACH_MAX_PER_CHAR) {
      return res.status(413).json({ error: `Limit of ${ATTACH_MAX_PER_CHAR} files per character reached` });
    }
    const total = list.reduce((n, a) => n + (a.size || 0), 0);
    if (total + req.file.size > ATTACH_MAX_TOTAL_BYTES) {
      return res.status(413).json({ error: 'Storage limit for this character reached' });
    }

    const sha256      = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    const duplicateOf = list.find(a => a.sha256 === sha256) || null;

    let key;
    const used = new Set(list.map(a => a.key));
    do { key = generateToken(12); } while (used.has(key));

    ensureUserCharDir(username);
    fs.writeFileSync(attachBlobPath(username, id, key, ext), req.file.buffer);

    const entry = {
      key,
      name:       String(req.file.originalname).slice(0, 200),
      ext,
      mime:       ATTACH_MIME[ext],
      size:       req.file.size,
      sha256,
      uploadedAt: new Date().toISOString(),
      uploadedBy: req.session.user.username,
    };
    list.push(entry);
    writeManifest(username, id, list);

    res.json({
      attachment:  entry,
      attachments: list,
      duplicateOf: duplicateOf ? { name: duplicateOf.name, uploadedAt: duplicateOf.uploadedAt } : null,
    });
  });

// Download / view one attachment. Content-Type is PINNED from our map (never
// sniffed, never from the client), nosniff is always set, and only known-safe
// types are served inline — everything else is forced to download.
app.get('/api/characters/:id/attachments/:key', requireAuth, validId, (req, res) => {
  const key = req.params.key;
  if (!/^[A-Za-z0-9]{1,40}$/.test(key)) return res.status(400).json({ error: 'Bad key' });

  const found = findCharFile(req.params.id);
  if (!found) return res.status(404).json({ error: 'Not found' });
  const char = JSON.parse(fs.readFileSync(found.filePath));
  if (!canViewChar(req, found, char)) return res.status(403).json({ error: 'Forbidden' });

  const entry = readManifest(found.username, req.params.id).find(a => a.key === key);
  if (!entry) return res.status(404).json({ error: 'No such attachment' });

  const p = attachBlobPath(found.username, req.params.id, entry.key, entry.ext);
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'File missing' });

  const disposition = ATTACH_INLINE.has(entry.ext) ? 'inline' : 'attachment';
  res.setHeader('Content-Type', ATTACH_MIME[entry.ext] || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `${disposition}; ${dispositionFilename(entry.name)}`);
  res.setHeader('Content-Length', entry.size);
  const stream = fs.createReadStream(p);
  stream.on('error', () => { if (!res.headersSent) res.status(500).end(); else res.destroy(); });
  stream.pipe(res);
});

// Delete one attachment — owner-or-admin. Removes blob + manifest entry.
app.delete('/api/characters/:id/attachments/:key', requireAuth, validId, requireCharOwner, (req, res) => {
  const key = req.params.key;
  if (!/^[A-Za-z0-9]{1,40}$/.test(key)) return res.status(400).json({ error: 'Bad key' });

  const { username } = req.foundChar;
  const id   = req.params.id;
  const list = readManifest(username, id);
  const entry = list.find(a => a.key === key);
  if (!entry) return res.status(404).json({ error: 'No such attachment' });

  const p = attachBlobPath(username, id, entry.key, entry.ext);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  const next = list.filter(a => a.key !== key);
  writeManifest(username, id, next);

  res.json({ ok: true, attachments: next });
});

// ---------------------------------------------------------------------------
// Characters
// ---------------------------------------------------------------------------

app.get('/api/characters', requireAuth, (req, res) => {
  try {
    const now      = new Date();
    const username = req.session.user.username;

    // Visibility rule — ONE rule for everyone, admins included:
    //   • you OWN the character, OR
    //   • it's tagged to a campaign YOU own.
    // Admin is deliberately NOT a blanket "see everything" here. Admin powers
    // live in the admin panel (users, settings); a global view of every player's
    // character cluttered the roster and — with the old autosave bug — let an
    // admin accidentally fork someone else's sheet on save.
    const ownedCampaigns    = getCampaigns().filter(c => c.ownedBy === username);
    const ownedCampaignKeys = campaignKeySet(ownedCampaigns);

    const allFiles = findAllCharFiles();
    const chars = [];

    for (const filePath of allFiles) {
      const data       = JSON.parse(fs.readFileSync(filePath));
      const isOwner    = data.owner === username;
      const isCampChar = matchesCampaign(data.campaignId, ownedCampaignKeys);

      if (!isOwner && !isCampChar) continue;

      chars.push({
        id:             data.id,
        name:           data.info?.name || 'Unnamed',
        sheetId:        data.sheetId,
        sheetName:      data.sheetName,
        updatedAt:      data.updatedAt,
        owner:          data.owner,
        campaignId:     data.campaignId || null,
        status:         data.status || 'active',
        hasActiveShare: (data.shares || []).some(s => new Date(s.expiresAt) > now),
      });
    }

    res.json(chars);
  } catch (e) {
    console.error(e);
    res.json([]);
  }
});

// ---------------------------------------------------------------------------
// Search
//
// GET /api/search?q=...  — searches the caller's VISIBLE characters only. It
// reuses the exact /api/characters visibility gate (own + owned-campaign), so
// search can never surface a character the roster wouldn't. Matching is plain
// case-insensitive substring — never a constructed RegExp — so a crafted query
// can't cause catastrophic backtracking (ReDoS) or inject pattern syntax.
// ---------------------------------------------------------------------------

// Resolve a dotted path against a character, hopping THROUGH arrays. Returns one
// entry per string leaf: { value, item }. `item` is the nearest enclosing array
// element's `name` (so a hit can say WHICH edge/weapon/power matched); null for
// plain scalar paths like info.concept. Bounded to the object it's handed — it
// never follows anything outside the character.
//
// `budget` is a shared {remaining: N} counter threaded through every recursive
// call in one walk. When a hostile or buggy shape would cause us to walk more
// than SEARCH_MAX_LEAVES leaves, the resolver bails out and the path quietly
// returns whatever it found so far. The caller never needs to know — the cap
// is enforced silently. (We don't throw; a partial-result is more useful than
// a 500 error, and search is best-effort anyway.) A fresh budget is allocated
// per searchCharacter() entry below so paths are isolated from each other.
function resolveSearchPath(node, parts, item, budget) {
  if (budget && budget.remaining <= 0) return [];
  if (parts.length === 0) {
    if (typeof node === 'string') {
      if (budget) budget.remaining--;
      return [{ value: node, item }];
    }
    return [];
  }
  const [head, ...rest] = parts;
  if (UNSAFE_PATH_SEGMENTS.has(head)) return [];
  const next = node == null ? undefined : node[head];
  if (next == null) return [];
  if (Array.isArray(next)) {
    const out = [];
    for (const el of next) {
      if (budget && budget.remaining <= 0) break;
      const name = (el && typeof el === 'object' && typeof el.name === 'string') ? el.name : item;
      const sub  = resolveSearchPath(el, rest, name, budget);
      if (sub.length) out.push(...sub);
    }
    return out;
  }
  return resolveSearchPath(next, rest, item, budget);
}

// Window a ~100-char snippet around the first match so long note/description
// bodies don't ship wholesale (UX + data minimization). The client re-finds the
// term to highlight it, so we send plain text, not HTML.
function searchSnippet(text, needle) {
  const i = text.toLowerCase().indexOf(needle);
  if (i < 0) return text.slice(0, 120).trim();
  const start = Math.max(0, i - 40);
  const end   = Math.min(text.length, i + needle.length + 60);
  let s = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0)         s = '… ' + s;
  if (end < text.length) s = s + ' …';
  return s;
}

// Session-note subfields are a universal sidecar, not a bundle-declared field,
// so their labels live here rather than in the schema's searchable map.
const SESSION_FIELD_LABELS = {
  notes: 'Session Notes', todos: 'Session To-Do', loot: 'Session Loot',
  npcs:  'Session NPCs',  misc:  'Session Misc',
};

const SEARCH_MIN_LEN  = 2;    // 1-char queries match almost everything; skip them
const SEARCH_MAX_HITS = 200;  // cap payload on a very broad term

// All the hits for one (already-visibility-checked) character.
function searchCharacter(char, needle) {
  const raw = [];

  // 1) Name — always, regardless of bundle.
  if (typeof char.info?.name === 'string' && char.info.name.toLowerCase().includes(needle)) {
    raw.push({ label: 'Name', item: null, tier: 'field', snippet: char.info.name });
  }

  // 2) Bundle-declared fields (scalars + array hops).
  // Each searchable entry gets its OWN budget: one path that explodes in the
  // data shouldn't starve the others. SEARCH_MAX_LEAVES is generous enough
  // (500) that real characters never feel it; only pathological data does.
  const searchable = getSearchable(char.sheetId);
  for (const [p, label] of Object.entries(searchable)) {
    const budget = { remaining: SEARCH_MAX_LEAVES };
    for (const { value, item } of resolveSearchPath(char, p.split('.'), null, budget)) {
      if (value.toLowerCase().includes(needle)) {
        raw.push({ label, item, tier: 'field', snippet: searchSnippet(value, needle) });
      }
    }
  }

  // 3) Session notes — universal sidecar, already merged in by readCharFull.
  for (const s of (Array.isArray(char.sessions) ? char.sessions : [])) {
    for (const [k, label] of Object.entries(SESSION_FIELD_LABELS)) {
      const val = s[k];
      if (typeof val === 'string' && val.toLowerCase().includes(needle)) {
        raw.push({ label, item: s.date || null, tier: 'notes', snippet: searchSnippet(val, needle), date: s.date });
      }
    }
  }

  // Dedupe by (label, item): a term hitting both an edge's name and its
  // description yields ONE row, keeping the longer (more informative) snippet.
  // Distinct session subfields keep distinct labels, so they survive.
  const byKey = new Map();
  for (const h of raw) {
    const key = `${h.label}|${h.item || ''}`;
    const prev = byKey.get(key);
    if (!prev || h.snippet.length > prev.snippet.length) byKey.set(key, h);
  }

  return [...byKey.values()].map(h => ({
    id:      char.id,
    name:    char.info?.name || 'Unnamed',
    label:   h.label,
    item:    h.item,
    tier:    h.tier,
    snippet: h.snippet,
    date:    h.date || char.updatedAt,   // session date for note hits, else envelope mtime
  }));
}

app.get('/api/search', requireAuth, (req, res) => {
  try {
    const needle = String(req.query.q || '').trim().toLowerCase();
    if (needle.length < SEARCH_MIN_LEN) return res.json([]);

    const username = req.session.user.username;

    // SAME visibility rule as GET /api/characters — own OR owned-campaign.
    // No admin blanket. Kept identical on purpose; if that rule changes there,
    // change it there and search follows.
    const ownedCampaigns    = getCampaigns().filter(c => c.ownedBy === username);
    const ownedCampaignKeys = campaignKeySet(ownedCampaigns);

    const hits = [];
    for (const filePath of findAllCharFiles()) {
      try {
        // Gate on the cheap main-file read FIRST; only merge sidecars (sessions)
        // for characters that pass, so we never open an invisible char's notes.
        const main       = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const isOwner    = main.owner === username;
        const isCampChar = matchesCampaign(main.campaignId, ownedCampaignKeys);
        if (!isOwner && !isCampChar) continue;

        const rel   = path.relative(CHARS_DIR, filePath);
        const found = { filePath, username: rel.split(path.sep)[0] };
        const full  = readCharFull(found);   // merges sessions sidecar

        for (const h of searchCharacter(full, needle)) {
          hits.push(h);
          if (hits.length >= SEARCH_MAX_HITS) break;
        }
      } catch (e) {
        // A single corrupt file shouldn't sink the whole search.
        console.error(`[search] skipped ${filePath}: ${e.message}`);
      }
      if (hits.length >= SEARCH_MAX_HITS) break;
    }

    res.json(hits);
  } catch (e) {
    console.error(e);
    res.json([]);
  }
});

app.get('/api/characters/:id', requireAuth, validId, (req, res) => {
  const found = findCharFile(req.params.id);
  if (!found) return res.status(404).json({ error: 'Not found' });

  const username = req.session.user.username;

  // Same visibility rule as the list: the owner, or the GM who owns this
  // character's campaign. No admin blanket — an admin can't open another user's
  // sheet by URL unless it's tagged to a campaign they own.
  let allowed = found.username === username;
  if (!allowed) {
    const ownedCampaigns = getCampaigns().filter(c => c.ownedBy === username);
    const keys = campaignKeySet(ownedCampaigns);
    // Visibility check only needs the main file's campaignId — sidecar paths
    // never carry membership info, so we read the cheap main file first.
    const char = JSON.parse(fs.readFileSync(found.filePath));
    allowed = matchesCampaign(char.campaignId, keys);
  }

  if (!allowed) return res.status(403).json({ error: 'Forbidden' });
  // readCharFull merges in any sidecar paths (e.g. sessions) the bundle has
  // declared. Renderer sees an unchanged top-level shape.
  res.json(readCharFull(found));
});

app.put('/api/characters/:id', requireAuth, validId, (req, res) => {
  const id       = req.params.id;
  const username = req.session.user.username;

  // Check ownership if file already exists
  const existing = findCharFile(id);
  if (existing && existing.username !== username) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const body = req.body;

  // Read whatever's currently on disk (including sidecars) so we can enforce
  // field ownership against the merged shape. readCharFull handles legacy
  // characters where the sidecar fields are still embedded in the main file.
  const onDisk = existing ? readCharFull(existing) : {};

  // Campaign membership is owned solely by the /campaign/join and /campaign/leave
  // endpoints. Autosave must never change it, so preserve the campaign fields from
  // the file on disk and ignore whatever the (possibly stale) client sent — e.g. a
  // sheet left open while a GM ejects the character must not be able to re-link it.
  const campaignFields = {
    campaignId:   onDisk.campaignId   ?? null,
    campaignCode: onDisk.campaignCode ?? null,
    campaignName: onDisk.campaignName ?? null,
  };

  // Shares and status are likewise owned by their own endpoints (the share
  // routes and /status), which write straight to disk. An open sheet's char
  // state goes stale the moment one of those runs — e.g. generating a share
  // adds a token to the file but not to the in-memory char — so if autosave
  // spread the client body unchecked it would clobber the freshly-written
  // shares/status. Always take these from disk, never from the request body.
  const ownedFields = {
    shares: onDisk.shares ?? body.shares ?? [],
    status: onDisk.status ?? body.status ?? 'active',
    // The attachment manifest is owned by the /attachments endpoints, which
    // write it straight to disk. A sheet open while a file is uploaded goes
    // stale, so — exactly like shares/status — always take it from disk and
    // ignore whatever the client body carries.
    attachments: onDisk.attachments ?? [],
  };

  ensureUserCharDir(username);

  // Portrait: check for an existing portrait file on disk
  const extensions  = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
  const portraitExt = extensions.find(ext => fs.existsSync(portraitPath(username, id, ext)));
  const portrait    = portraitExt
    ? `/portraits/${username}/${id}.portrait${portraitExt}`
    : body.portrait;

  const data = {
    ...body,
    ...campaignFields,
    ...ownedFields,
    id,
    portrait,
    owner:     username,
    updatedAt: new Date().toISOString(),
  };

  // writeCharSplit handles the split: anything declared in the bundle's
  // sidecarPaths (e.g. sessions) is peeled off into its own file; everything
  // else lands in the main envelope. Legacy characters that still have the
  // sidecar fields embedded are migrated on this save — the main file is
  // rewritten without them, and the sidecar files are written for the first time.
  writeCharSplit(username, id, data);

  // Echo back the merged shape so the client sees exactly what the next GET
  // would return — this matters because autosave responses sometimes flow into
  // local state (e.g. updatedAt).
  res.json(data);
});

app.delete('/api/characters/:id', requireAuth, validId, (req, res) => {
  const found = findCharFile(req.params.id);
  if (!found) return res.status(404).json({ error: 'Not found' });

  if (!req.session.user.admin && found.username !== req.session.user.username) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // collectCharacterFiles globs `${id}.*` in the owner's dir, so this single
  // loop sweeps the main file, every sidecar (sessions.json, etc.), and any
  // portrait extension that happens to exist. No need to enumerate extensions.
  for (const f of collectCharacterFiles(found.username, req.params.id)) {
    fs.unlinkSync(f.full);
  }

  res.json({ ok: true });
});

// GET /api/characters/:id/rolls — the roll log, newest first.
// Same visibility as the rename/status endpoints (owner or admin). NOT the
// wider owner-or-campaign-GM rule that GET /api/characters/:id uses — a GM
// can view a member's sheet but doesn't see their private roll history yet.
// Widen this later with campaignKeySet()/matchesCampaign() if you want a
// shared-table view.
app.get('/api/characters/:id/rolls', requireAuth, validId, (req, res) => {
  const found = findCharFile(req.params.id);
  if (!found) return res.status(404).json({ error: 'Not found' });

  const username = req.session.user.username;
  if (!req.session.user.admin && found.username !== username) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  res.json(readRolls(found.username, req.params.id));
});

// POST /api/characters/:id/rolls   body: { dice, modifier, total, source? }
// Appends one roll entry. Fired automatically by DiceTray after every throw —
// see the "Roll log" comment above for why this bypasses the character
// envelope entirely instead of going through PUT /api/characters/:id.
app.post('/api/characters/:id/rolls', requireAuth, validId, (req, res) => {
  const found = findCharFile(req.params.id);
  if (!found) return res.status(404).json({ error: 'Not found' });

  const username = req.session.user.username;
  if (!req.session.user.admin && found.username !== username) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { dice, modifier, total, source } = req.body || {};
  if (typeof dice !== 'object' || dice === null || typeof total !== 'number') {
    return res.status(400).json({ error: 'Invalid roll payload' });
  }

  const entry = {
    id:       generateToken(8),
    rolledAt: new Date().toISOString(),
    dice,
    modifier: Number.isFinite(modifier) ? modifier : 0,
    total,
    source: typeof source === 'string' && source.trim() ? source.trim() : null,
  };

  res.json(appendRoll(found.username, req.params.id, entry));
});

// ---------------------------------------------------------------------------
// Export — download a character as a file.
//
// The server decides the format because it owns the filesystem. It globs the
// owner's dir for `${id}.*`:
//   • just the character file  → raw `.json` download
//   • JSON + portrait (+ any future per-character files) → a `.zip` of them all
// New file types are picked up automatically — no client change needed.
//
// Visibility mirrors GET /api/characters/:id exactly: owner, admin, or the GM
// of the character's campaign.
// ---------------------------------------------------------------------------
app.get('/api/characters/:id/export', requireAuth, validId, (req, res) => {
  const found = findCharFile(req.params.id);
  if (!found) return res.status(404).json({ error: 'Not found' });

  const username = req.session.user.username;
  const isAdmin  = req.session.user.admin;
  const isGM     = req.session.user.gm;
  const char     = JSON.parse(fs.readFileSync(found.filePath));

  let allowed = isAdmin || found.username === username;
  if (!allowed && isGM) {
    const keys = campaignKeySet(getCampaigns().filter(c => c.ownedBy === username));
    allowed = matchesCampaign(char.campaignId, keys);
  }
  if (!allowed) return res.status(403).json({ error: 'Forbidden' });

  // Friendly download name from the display name; fall back to the id (already a
  // safe slug) if the name slugifies to nothing.
  const base  = slugify(char.info?.name) || req.params.id;
  const files = collectCharacterFiles(found.username, req.params.id);

  // Only the character file present → raw JSON, no zip overhead.
  if (files.length <= 1) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.json"`);
    return res.send(fs.readFileSync(found.filePath));
  }

  // Multiple files → zip. zipSync takes a plain { name: Uint8Array } map and
  // returns the whole archive in one call — no streams to manage for the handful
  // of files a character has. Store-only (level 0): portraits, PDFs and Office
  // files are already compressed, so deflating again just burns CPU.
  //
  // Attachment blobs are stored under server tokens (`attach.<key>.<ext>`), which
  // would be meaningless in the archive. Map them back to their human names from
  // the manifest, drop them under an `attachments/` folder, and de-dupe collisions
  // (two files both called notes.pdf → "notes.pdf", "notes (2).pdf").
  const manifest = readManifest(found.username, req.params.id);
  const byKey    = new Map(manifest.map(a => [a.key, a]));
  const usedNames = new Set();
  const uniqueName = (name) => {
    let candidate = String(name || 'file').replace(/[\/\\\r\n]/g, '_');
    if (usedNames.has(candidate)) {
      const dot  = candidate.lastIndexOf('.');
      const stem = dot > 0 ? candidate.slice(0, dot) : candidate;
      const ext  = dot > 0 ? candidate.slice(dot) : '';
      let i = 2;
      do { candidate = `${stem} (${i++})${ext}`; } while (usedNames.has(candidate));
    }
    usedNames.add(candidate);
    return candidate;
  };

  const entries = {};
  for (const f of files) {
    if (f.suffix === 'attachments.json') {
      continue;
    } else if (f.suffix.startsWith('attach.')) {
      const key   = f.suffix.split('.')[1];
      const entry = byKey.get(key);
      const named = uniqueName(entry ? entry.name : f.suffix);
      entries[`attachments/${named}`] = new Uint8Array(fs.readFileSync(f.full));
    } else {
      entries[f.zipName] = new Uint8Array(fs.readFileSync(f.full));
    }
  }
  const archive = zipSync(entries, { level: 0 });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${base}.zip"`);
  return res.send(Buffer.from(archive));
});

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

app.get('/api/campaigns', requireAuth, (req, res) => {
  const all      = getCampaigns();
  const username = req.session.user.username;
  const isAdmin  = req.session.user.admin;

  // GMs see their own campaigns; admins see all. Membership arrays were removed —
  // player ↔ campaign association is now per-character (tag-based), so a plain
  // player has no owned campaigns and gets an empty list here by design.
  const visible = all.filter(c =>
    isAdmin ||
    c.ownedBy === username
  );
  res.json(visible);
});

app.post('/api/campaigns', requireAuth, requireGM, (req, res) => {
  const { name, sheetId, sheetName } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });

  const campaigns = getCampaigns();

  // Ensure unique join code
  let joinCode;
  const existingCodes = new Set(campaigns.map(c => c.joinCode));
  do { joinCode = generateJoinCode(); } while (existingCodes.has(joinCode));

  const campaign = {
    id:        generateToken(12),
    name,
    sheetId:   sheetId   || null,
    sheetName: sheetName || null,
    joinCode,
    ownedBy:   req.session.user.username,
    createdAt: new Date().toISOString(),
  };

  campaigns.push(campaign);
  saveCampaigns(campaigns);
  res.json(campaign);
});

app.delete('/api/campaigns/:id', requireAuth, requireGM, validId, (req, res) => {
  const campaigns = getCampaigns();
  const campaign  = campaigns.find(c => c.id === req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Not found' });
  if (!req.session.user.admin && campaign.ownedBy !== req.session.user.username) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  saveCampaigns(campaigns.filter(c => c.id !== req.params.id));
  res.json({ ok: true });
});

// POST /api/campaigns/:id/status   body: { status: "active" | "archived" }
app.post('/api/campaigns/:id/status', requireAuth, requireGM, validId, (req, res) => {
  const status = req.body?.status;
  if (!['active', 'archived'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  const campaigns = getCampaigns();
  const campaign  = campaigns.find(c => c.id === req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Not found' });
  if (!req.session.user.admin && campaign.ownedBy !== req.session.user.username) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  campaign.status = status;
  saveCampaigns(campaigns);
  res.json({ id: campaign.id, status });
});

// Values that identify a GM's campaigns — internal id AND join code,
// so a character can be tagged with either.
function campaignKeySet(campaigns) {
  const keys = new Set();
  for (const c of campaigns) {
    if (c.id)       keys.add(c.id);
    if (c.joinCode) keys.add(c.joinCode);
  }
  return keys;
}

// Does a character's stored tag match any of those keys?
// Join codes are uppercase; tolerate lowercase input. Ids stay case-sensitive.
function matchesCampaign(stored, keys) {
  if (!stored) return false;
  const v = String(stored).trim();
  return keys.has(v) || keys.has(v.toUpperCase());
}

// ---------------------------------------------------------------------------
// Share links
// ---------------------------------------------------------------------------

function findCharByToken(token) {
  for (const filePath of findAllCharFiles()) {
    const char  = JSON.parse(fs.readFileSync(filePath));
    const share = (char.shares || []).find(s => s.token === token);
    if (share) {
      // Match findCharFile's contract — callers (share GET/PUT) need the
      // username to locate sidecar files via sidecarFilePath(username, id, …).
      const rel      = path.relative(CHARS_DIR, filePath);
      const username = rel.split(path.sep)[0];
      return { char, share, filePath, username };
    }
  }
  return null;
}

// A share link grants access to ONE character's sheet — nothing more. Before
// sending a character to a share client, strip the fields that would let the
// holder escalate beyond that, or that leak internals they can't use:
//   - `shares`: the token list. Returning it would let a VIEW-link holder read an
//     EDIT token out of the array and use it to start writing.
//   - `campaignCode`: the campaign join code (set in /campaign/join). Returning it
//     would let a viewer join the character's campaign.
//   - `attachments`: the manifest of server-side blob keys, original filenames,
//     sizes and SHAs. Share holders are unauthenticated, so the attachment
//     download routes (requireAuth + owner/admin/campaign-GM) already refuse
//     them — sending the manifest would only leak internal keys/metadata for
//     files they can't fetch. Same reasoning as excluding it from exports.
// Everything else — sheet data, portrait, names — is what the renderer needs.
function shareSafeChar(char) {
  const { shares, campaignCode, attachments, ...safe } = char;
  return safe;
}

app.post('/api/characters/:id/shares', requireAuth, validId, (req, res) => {
  const found = findCharFile(req.params.id);
  if (!found) return res.status(404).json({ error: 'Not found' });

  const char = JSON.parse(fs.readFileSync(found.filePath));
  if (!req.session.user.admin && found.username !== req.session.user.username) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { permission = 'view', expiresInDays = 3 } = req.body;
  const token     = generateToken(32);
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + expiresInDays);

  const share = { token, permission, expiresAt: expiresAt.toISOString(), createdAt: new Date().toISOString() };
  if (!char.shares) char.shares = [];
  char.shares.push(share);
  fs.writeFileSync(found.filePath, JSON.stringify(char, null, 2));
  res.json(share);
});

app.get('/api/characters/:id/shares', requireAuth, validId, (req, res) => {
  const found = findCharFile(req.params.id);
  if (!found) return res.status(404).json({ error: 'Not found' });
  const char = JSON.parse(fs.readFileSync(found.filePath));
  if (!req.session.user.admin && found.username !== req.session.user.username) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const now    = new Date();
  const active = (char.shares || []).filter(s => new Date(s.expiresAt) > now);
  res.json(active);
});

app.delete('/api/characters/:id/shares/:token', requireAuth, validId, (req, res) => {
  const found = findCharFile(req.params.id);
  if (!found) return res.status(404).json({ error: 'Not found' });
  const char = JSON.parse(fs.readFileSync(found.filePath));
  if (!req.session.user.admin && found.username !== req.session.user.username) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  char.shares = (char.shares || []).filter(s => s.token !== req.params.token);
  fs.writeFileSync(found.filePath, JSON.stringify(char, null, 2));
  res.json({ ok: true });
});

app.get('/api/share/:token', (req, res) => {
  const result = findCharByToken(req.params.token);
  if (!result) return res.status(404).json({ error: 'Link not found' });
  if (new Date() > new Date(result.share.expiresAt)) {
    return res.status(410).json({ error: 'Link expired' });
  }

  // The share viewer needs the same shape the owner sees, so merge any sidecar
  // paths in before sanitizing. findCharByToken only reads the main file (the
  // tokens it scans for live there), so on its own it would hand back a sheet
  // missing sessions etc. readCharFull pulls those in.
  const merged = readCharFull(result);
  res.json({ char: shareSafeChar(merged), permission: result.share.permission });
});

app.put('/api/share/:token', (req, res) => {
  const result = findCharByToken(req.params.token);
  if (!result) return res.status(404).json({ error: 'Link not found' });
  if (new Date() > new Date(result.share.expiresAt)) {
    return res.status(410).json({ error: 'Link expired' });
  }
  if (result.share.permission !== 'edit') {
    return res.status(403).json({ error: 'View only' });
  }

  // Field ownership, same rule as autosave: an edit-link holder may change the
  // sheet DATA, but never the reserved envelope fields. Take those from the
  // MERGED on-disk view (main + sidecars) so sidecar values aren't lost when
  // we re-spread the body — readCharFull catches legacy embedded values, too.
  const onDisk = readCharFull(result);
  const data = {
    ...req.body,
    id:           onDisk.id,
    owner:        onDisk.owner,
    portrait:     onDisk.portrait,
    campaignId:   onDisk.campaignId   ?? null,
    campaignCode: onDisk.campaignCode ?? null,
    campaignName: onDisk.campaignName ?? null,
    shares:       onDisk.shares       ?? [],
    status:       onDisk.status       ?? 'active',
    // The attachment manifest is owned by the /attachments endpoints, which
    // write it straight to disk — same rule as shares/status. It's a built-in
    // sidecar, so readCharFull loaded it above and writeCharSplit would peel
    // whatever's here back into ${id}.attachments.json. Without this line the
    // spread of req.body lets an edit-link holder clobber (or wipe) the manifest.
    // Mirrors the autosave route's identical guard.
    attachments:  onDisk.attachments  ?? [],
    sheetId:      onDisk.sheetId,                  // sheetId drives sidecar paths — never let the body change it
    updatedAt:    new Date().toISOString(),
  };

  // writeCharSplit splits sidecar paths back into their own files. The body
  // may contain updated sessions etc. — they land in the sidecar, not the
  // main envelope.
  writeCharSplit(result.username, onDisk.id, data);

  // The echo back to the client should be the merged shape (so the renderer
  // sees the same sessions array it just saved). shareSafeChar still strips
  // tokens/campaign-code before send.
  res.json(shareSafeChar(data));
});


// ---------------------------------------------------------------------------
// Rename — explicit file rename, separate from autosave
// ---------------------------------------------------------------------------

app.post('/api/characters/:id/rename', requireAuth, validId, (req, res) => {
  const oldId    = req.params.id;
  const username = req.session.user.username;
  const newName  = req.body?.name?.trim();

  if (!newName) return res.status(400).json({ error: 'Name required' });

  const existing = findCharFile(oldId);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (!req.session.user.admin && existing.username !== username) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Build new ID: slugified name + original random suffix
  const parts  = oldId.split('-');
  const suffix = parts[parts.length - 1];
  const newId  = `${slugify(newName)}-${suffix}`;

  // Read MERGED character so sidecar values get written under the new id by
  // writeCharSplit below. If we only read the main file, sessions would be
  // re-written empty alongside the new envelope.
  const char = readCharFull(existing);
  char.id        = newId;
  char.info      = { ...(char.info || {}), name: newName };
  char.updatedAt = new Date().toISOString();

  // Write under the new id. writeCharSplit re-creates the main envelope plus
  // every sidecar in one call — sessions etc. land at `${newId}.sessions.json`.
  ensureUserCharDir(username);
  writeCharSplit(username, newId, char);

  // If the id changed, clean up the old-id files. JSON files (main + sidecars)
  // have already been re-written under newId, so we delete them. Binary files
  // like portraits live under their old name and need to be renamed in place.
  if (newId !== oldId) {
    for (const f of collectCharacterFiles(username, oldId)) {
      if (f.suffix === 'json' || f.suffix.endsWith('.json')) {
        fs.unlinkSync(f.full);
      } else {
        const newPath = path.join(userCharDir(username), `${newId}.${f.suffix}`);
        fs.renameSync(f.full, newPath);
      }
    }

    // Update the portrait URL inside the character to point at the new id, then
    // re-write the envelope. Sidecars don't reference the id internally so they
    // don't need this second write.
    if (char.portrait) {
      const extensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
      const ext = extensions.find(e => char.portrait.endsWith(e));
      if (ext) {
        char.portrait = `/portraits/${username}/${newId}.portrait${ext}`;
        writeCharSplit(username, newId, char);
      }
    }
  }

  res.json({ id: newId, name: newName });
});

// POST /api/characters/:id/status   body: { status: "active" | "archived" }
app.post('/api/characters/:id/status', requireAuth, validId, (req, res) => {
  const id       = req.params.id;
  const username = req.session.user.username;
  const status   = req.body?.status;

  const VALID_STATUSES = ['active', 'inactive', 'deceased', 'retired', 'shelved', 'archived'];
  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  const existing = findCharFile(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (!req.session.user.admin && existing.username !== username) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const char = JSON.parse(fs.readFileSync(existing.filePath));
  char.status    = status;
  char.updatedAt = new Date().toISOString();
  fs.writeFileSync(existing.filePath, JSON.stringify(char, null, 2));

  res.json({ id, status });
});

// ---------------------------------------------------------------------------
// Campaign membership — narrow endpoints, role-aware auth, touch only the
// campaign fields. The character is the single source of truth. These mirror
// the rename/status endpoints and deliberately bypass the owner-gated autosave
// so a GM can act on a member they don't own.
// ---------------------------------------------------------------------------

// True if `username` is the GM (owner) of the campaign with this id.
function ownsCampaignOf(username, campaignId) {
  if (!campaignId) return false;
  const camp = getCampaigns().find(c => c.id === campaignId);
  return !!camp && camp.ownedBy === username;
}

// POST /api/characters/:id/campaign/join   body: { campaignCode }
// Sets campaign membership from an invite code. Owner or admin only — joining is
// opt-in by the owner; a GM cannot conscript a character they don't own.
app.post('/api/characters/:id/campaign/join', requireAuth, validId, (req, res) => {
  const id       = req.params.id;
  const username = req.session.user.username;
  const isAdmin  = !!req.session.user.admin;
  const code     = String(req.body?.campaignCode || '').trim();

  if (!code) return res.status(400).json({ error: 'Invite code required' });

  const existing = findCharFile(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (!isAdmin && existing.username !== username) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const match = getCampaigns().find(c => c.joinCode === code.toUpperCase() || c.id === code);
  if (!match) return res.status(404).json({ error: 'No campaign matches that code' });

  const char = JSON.parse(fs.readFileSync(existing.filePath));
  char.campaignId   = match.id;
  char.campaignCode = code.toUpperCase();
  char.campaignName = match.name;
  char.updatedAt    = new Date().toISOString();
  fs.writeFileSync(existing.filePath, JSON.stringify(char, null, 2));

  res.json({ id, campaignId: match.id, campaignName: match.name });
});

// POST /api/characters/:id/campaign/leave
// Clears campaign membership. Allowed for the owner, an admin, OR the GM of the
// campaign the character is currently in (so a GM can eject a member they don't own).
app.post('/api/characters/:id/campaign/leave', requireAuth, validId, (req, res) => {
  const id       = req.params.id;
  const username = req.session.user.username;
  const isAdmin  = !!req.session.user.admin;

  const existing = findCharFile(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const char    = JSON.parse(fs.readFileSync(existing.filePath));
  const isOwner = existing.username === username;
  const isGM    = ownsCampaignOf(username, char.campaignId);

  if (!isAdmin && !isOwner && !isGM) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  char.campaignId   = null;
  char.campaignCode = null;
  char.campaignName = null;
  char.updatedAt    = new Date().toISOString();
  fs.writeFileSync(existing.filePath, JSON.stringify(char, null, 2));

  res.json({ id, campaignId: null, campaignName: null });
});



// ---------------------------------------------------------------------------
// SPA fallback
// ---------------------------------------------------------------------------
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend/build/index.html'));
});


const server = app.listen(PORT, () => console.log(`Server on ${PORT}`));

// Node's default keepAliveTimeout (5s) is shorter than the keepalive Nginx
// Proxy Manager uses toward this upstream (commonly 60-75s). When the app
// sits idle (tab backgrounded, no requests for >5s), Node closes the socket
// from its end, but NPM doesn't find out until it tries to reuse that same
// socket for the next request — which fails as a connection reset. The
// browser/Cloudflare surface that as "can't connect," and a refresh "fixes"
// it only because it opens a brand-new connection.
//
// Setting this above NPM's upstream keepalive means Node never closes first;
// NPM always closes (or recycles) the connection before Node would, so there's
// no race. headersTimeout must stay a few seconds above keepAliveTimeout per
// Node's own requirement, or it'll throw at startup.
server.keepAliveTimeout = 65000; // 65s — exceeds NPM's typical 60-75s upstream keepalive... see below
server.headersTimeout   = 66000;

const shutdown = (signal) => {
  console.log(`${signal} received — shutting down`);
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
  server.closeIdleConnections?.();                 // drop idle keep-alive sockets so close() resolves fast
  setTimeout(() => process.exit(1), 5000).unref(); // safety net if something hangs
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

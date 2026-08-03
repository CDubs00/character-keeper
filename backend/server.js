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
const packs     = require('./packs');
const systemRef = require('./systemRef');   // Wave C: the stamped system-reference tier
const { loadSchema } = sheets;
const { validateUsername } = require('./validateUsername');
const { passwordError } = require('./validatePassword');
// isGM is aliased to isWorldGM: two route handlers below declare a local
// `const isGM` for the SITE-level GM flag (req.session.user.gm), which is a
// different concept from a WORLD role. Aliasing keeps them from shadowing.
const {
  canSee, seesRawFog, stripFog, serializeEntryForRole,
  isGM: isWorldGM,
  VISIBILITY_STATES, DEFAULT_VISIBILITY,
  migrateRole, migrateVisibility,
  CAMPAIGN_STATUSES, CAMPAIGN_TEXT_FIELDS, serializeCampaignForRole,
  SESSION_SCENE_FIELDS, SESSION_RECORD_FIELDS, SESSION_VISIBILITY,
  DEFAULT_SESSION_VISIBILITY, serializeSessionForRole, serializeSessionsForRole,
  sessionStatsForRole,
} = require('./loreAccess');
const calendarMath = require('./calendarMath');
const createFileSessionStore = require('./sessionStore');
const pkg = require('./package.json');
const { zipSync } = require('fflate');

const app      = express();
const PORT     = process.env.PORT     || 3001;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');

// bcrypt work factor. Kept as a single named constant so every hashing site uses
// the same cost and it can't drift. 12 follows current OWASP guidance (each +1
// doubles an offline cracker's work if users.json ever leaks). Existing hashes at
// an older cost keep verifying — the cost is embedded in each stored hash — and
// upgrade opportunistically on the next password change.
const BCRYPT_COST = 12;
// Number of reverse-proxy hops in front of the app (see app.set('trust proxy')).
// Cloudflare(orange) + Nginx Proxy Manager = 2, which is the default. An admin
// deploying Keep behind ONLY NPM (or directly) should set TRUST_PROXY_HOPS=1.
// Setting this HIGHER than the real hop count lets a client forge X-Forwarded-For
// and spoof its IP, defeating the login rate limiter — so keep it exact.
const TRUST_PROXY_HOPS = Number(process.env.TRUST_PROXY_HOPS) || 2;

// Absolute session lifetime. The 7-day cookie maxAge slides on activity, so an
// active session could otherwise live forever. This hard ceiling (stamped at
// login, enforced in requireAuth) forces a re-login after 30 days no matter how
// active the session is — bounding the value of a stolen cookie.
const MAX_SESSION_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const USERS_FILE      = path.join(DATA_DIR, 'users.json');
const CAMPAIGNS_FILE  = path.join(DATA_DIR, 'campaigns.json');
const CHARS_DIR       = path.join(DATA_DIR, 'characters');  // ← new
const LOGS_FILE       = path.join(DATA_DIR, 'logs.json');
const WORLDS_FILE     = path.join(DATA_DIR, 'worlds.json');   // Keep: flat world list
const LORE_DIR        = path.join(DATA_DIR, 'lore');          // Keep: one file per lore entry
const WORLD_ASSETS_DIR= path.join(DATA_DIR, 'world-assets');  // Keep: per-world backdrop images
const SYSREF_DIR      = path.join(DATA_DIR, 'sysref');        // Keep: one file per system-reference entry





// App/config files that must never be treated as character data, even if they
// somehow land inside the characters tree (e.g. a misconfigured volume).
const RESERVED_JSON = new Set(['settings.json', 'users.json', 'campaigns.json', 'sheets-registry.json', 'logs.json', 'worlds.json']);

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

// Post-write magic-byte check for the two disk-storage image uploads (character
// portrait, world backdrop). The attachment and lore-asset uploads use multer
// memoryStorage and sniff the in-memory buffer BEFORE writing; these two use
// diskStorage (multer writes the file first), so we read the leading bytes back
// off disk and reject-and-unlink if they don't match the claimed extension. The
// GUARANTEE is identical — a renamed `evil.exe → map.png` never survives — just
// reached a step later. Returns true when the file is a genuine image.
function verifyImageFile(filePath, ext) {
  try {
    const fd   = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(12);
    fs.readSync(fd, head, 0, 12, 0);
    fs.closeSync(fd);
    return sniffMagic(ext, head);
  } catch {
    return false;
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
// Activity logs — login events and share-link accesses. Capped at 1 000 per
// type so the file never grows unbounded.
// ---------------------------------------------------------------------------
const LOG_CAP = 1000;

// Node dual-stack sockets represent IPv4 addresses as ::ffff:x.x.x.x — strip
// the prefix so logs show the plain IPv4 form.
const normalizeIp = (ip) => (ip || '').replace(/^::ffff:/, '');

function getLogs() {
  if (!fs.existsSync(LOGS_FILE)) return { logins: [], shareAccesses: [] };
  try { return JSON.parse(fs.readFileSync(LOGS_FILE)); } catch { return { logins: [], shareAccesses: [] }; }
}

function appendLog(type, entry) {
  const logs = getLogs();
  if (!Array.isArray(logs[type])) logs[type] = [];
  logs[type].unshift(entry);              // newest first
  if (logs[type].length > LOG_CAP) logs[type].length = LOG_CAP;
  try { fs.writeFileSync(LOGS_FILE, JSON.stringify(logs)); } catch { /* non-fatal */ }
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
      password:     bcrypt.hashSync(password, BCRYPT_COST),
      admin:        true,
      gm:           false,
      player:       false,
      tokenVersion: 1,
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

// ---------------------------------------------------------------------------
// Campaign↔World link + world access ledger (§4.7) — GM-side plumbing only.
// A campaign MAY belong to one world owned by the SAME GM (campaign.worldId), or
// be standalone (null). A world's access is a per-USER ledger on the world record
// (world.members). Joining a campaign-in-a-world auto-grants the character owner
// `read`; the GM manages tiers from there. NO player read surface here — that's
// §4.8; a `read` member still can't open a world yet.
// ---------------------------------------------------------------------------

// The three access tiers, ascending. `read` is the auto-grant floor. `coGM` is
// GM-equivalent for CONTENT (hidden entries, raw fog, direct edits, approvals) but
// holds NO structural power — members, pack, delete and transfer stay with the
// owner via requireWorldOwner, so a coGM can never lock the owner out.
const MEMBER_TIERS = ['read', 'propose', 'coGM'];

// Validate a campaign's requested worldId against the caller. Returns:
//   null      — standalone (no/blank world) — a valid choice
//   <string>  — a world that exists AND is owned by this user
//   undefined — invalid (malformed, missing, or someone else's world) → 400
// Same-GM ownership is the rule: a campaign can only nest under a world you own.
function resolveOwnedWorldId(worldId, username) {
  if (worldId == null || worldId === '') return null;
  if (typeof worldId !== 'string' || !safeId(worldId)) return undefined;
  const w = getWorlds().find(x => x.id === worldId);
  if (!w || w.ownedBy !== username) return undefined;
  return worldId;
}

// The campaigns that belong to a world (same-GM link). Used to derive which of a
// user's characters count as "in this world" and to scope revoke/kick cascades.
// Resolve a viewer's role on ONE campaign. Returns 'owner', 'player', or null.
//
// Membership is DERIVED, never a ledger: a user is a player iff they own a
// character whose campaignId matches this campaign's id or join code — exactly
// the rule join-by-code already uses (matchesCampaign). Consequences worth
// stating, because both are easy to get wrong later:
//   • World membership does NOT grant campaign access. A world ledger member with
//     no character here is a stranger.
//   • Admin does NOT grant access either, matching GET /api/campaigns ("Admin role
//     does not grant visibility into other GMs' campaigns").
// A null return must produce a 404, never a 403 — a stranger should not learn
// that a campaign id exists. Mirrors requireWorldRead.
function resolveCampaignRole(campaign, username) {
  if (!campaign || !username) return null;
  if (campaign.ownedBy === username) return 'owner';
  const keys = campaignKeySet([campaign]);
  for (const { id, filePath } of userCharacterFiles(username)) {
    let char;
    try { char = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }
    if (matchesCampaign(char.campaignId, keys)) return 'player';
  }
  return null;
}

// The campaign roster: every character tagged with this campaign, with its owning
// username. ONE scan of all character files, mirroring GET /api/worlds/:id/campaigns.
// Derived at read and never persisted — a stored roster drifts the moment someone
// joins, leaves, or renames, the same reason autosave re-reads `shares` from disk.
// serializeCampaignForRole strips the `owner` field for non-GMs.
function campaignRoster(campaign) {
  const keys = campaignKeySet([campaign]);
  const out  = [];
  for (const filePath of findAllCharFiles()) {
    let char;
    try { char = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }
    if (!matchesCampaign(char.campaignId, keys)) continue;
    out.push({
      id:    char.id || null,
      name:  char.info?.name || 'Unnamed',
      owner: path.relative(CHARS_DIR, filePath).split(path.sep)[0],   // dir = username
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}


// ---------------------------------------------------------------------------
// Session sidecars (Wave B)
//
// One file per campaign at data/campaigns/<id>.sessions.json — a SIDECAR, never
// inside campaigns.json. That file is read whole on every join-by-code lookup and
// every roster scan; folding a campaign's whole play log into it would put
// thousands of lines of prose on that hot path. Same reasoning as the character
// `${id}.sessions.json` sidecar.
//
// data/campaigns.json (the registry) and data/campaigns/ (the sidecars) coexist —
// a flat list beside a directory, exactly like worlds.json beside lore/.
// ---------------------------------------------------------------------------

const CAMPAIGN_SIDECAR_DIR = path.join(DATA_DIR, 'campaigns');

function sessionsPath(campaignId) {
  return path.join(CAMPAIGN_SIDECAR_DIR, `${campaignId}.sessions.json`);
}

// Tolerant of a missing or corrupt sidecar — log and fall back to empty, never
// crash the campaign load. Same discipline as the lore history sidecar.
function readSessions(campaignId) {
  const file = sessionsPath(campaignId);
  if (!fs.existsSync(file)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch (e) {
    console.warn(`[sessions] ${campaignId}.sessions.json is unreadable (${e.message}) — treating as empty`);
    return [];
  }
}

function writeSessions(campaignId, sessions) {
  fs.mkdirSync(CAMPAIGN_SIDECAR_DIR, { recursive: true });
  fs.writeFileSync(sessionsPath(campaignId), JSON.stringify(sessions, null, 2));
}

// ---------------------------------------------------------------------------
// Session attachments — reuses the lore-asset security model VERBATIM (extension
// allowlist, magic-byte sniff, server-token filenames, pinned Content-Type +
// nosniff, size/count caps): "store inert, serve guarded" per SECURITY.public.md.
// Files live beside the session sidecar in CAMPAIGN_SIDECAR_DIR, keyed by
// campaign + session so a delete of either can sweep them; the extra-dot stem
// (`.session-<id>.assets.json` / `.session-<id>.asset.<key>.<ext>`) keeps them
// out of any future generic scan of that directory, same discipline as the lore
// entry/history/assets split.
//
// Each asset carries its OWN `visibility` ('hidden' | 'shared', same vocabulary
// as the session record) — a GM can attach a secret map (hidden) and a handout
// (shared) to the same session. A shared asset is only actually reachable by a
// player when the SESSION ITSELF is shared too (canSeeSession) — an attachment
// on a hidden session must not leak just because someone guesses its key.
// ---------------------------------------------------------------------------
const SESSION_ASSET_MAX_PER_SESSION = Number(process.env.SESSION_ASSET_MAX_PER_SESSION) || 50;

function sessionAssetsManifestPath(campaignId, sessionId) {
  return path.join(CAMPAIGN_SIDECAR_DIR, `${campaignId}.session-${sessionId}.assets.json`);
}
function sessionAssetBlobPath(campaignId, sessionId, key, ext) {
  return path.join(CAMPAIGN_SIDECAR_DIR, `${campaignId}.session-${sessionId}.asset.${key}.${ext}`);
}
function readSessionAssets(campaignId, sessionId) {
  const p = sessionAssetsManifestPath(campaignId, sessionId);
  if (!fs.existsSync(p)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error(`[sessions] Failed to parse assets ${p}: ${e.message}`);
    return [];
  }
}
function writeSessionAssets(campaignId, sessionId, list) {
  fs.mkdirSync(CAMPAIGN_SIDECAR_DIR, { recursive: true });
  fs.writeFileSync(sessionAssetsManifestPath(campaignId, sessionId), JSON.stringify(list, null, 2));
}
// Best-effort removal of one session's asset blobs + manifest (called when that
// session is deleted, or when the whole log is dropped alongside a campaign).
function removeSessionAssets(campaignId, sessionId) {
  for (const a of readSessionAssets(campaignId, sessionId)) {
    const p = sessionAssetBlobPath(campaignId, sessionId, a.key, a.ext);
    if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch { /* best-effort */ } }
  }
  const m = sessionAssetsManifestPath(campaignId, sessionId);
  if (fs.existsSync(m)) { try { fs.unlinkSync(m); } catch { /* best-effort */ } }
}
const sessionAssetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: ATTACH_MAX_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).slice(1).toLowerCase();
    cb(null, ATTACH_EXTS.has(ext)); // drop disallowed extensions before buffering
  },
});

// The calendar a campaign's in-world dates are validated against: its world's if
// it has one, else the built-in. A campaign may be standalone (worldId null), and
// since resolveWorldCalendar never returns null there is always something to
// validate against — so standalone campaigns get dates too rather than a special case.
function campaignCalendar(campaign) {
  if (campaign && campaign.worldId) {
    const world = getWorlds().find(w => w.id === campaign.worldId);
    if (world) return resolveWorldCalendar(world);
  }
  return BUILTIN_CALENDAR;
}

const SESSION_TEXT_CAP = 8000;
const SESSION_LIST_CAP = 200;

// Build a stored session from a client body. An ALLOWLIST, never a spread: the
// envelope (id, number, createdAt) is app-owned, and a client must not be able to
// set it through here. `existing` is the current record on a PUT, so an absent key
// means "leave alone" rather than "clear".
function sessionFromBody(body, existing, calendar) {
  const b   = body || {};
  const cur = existing || {};
  const str = (v, fallback) => (typeof v === 'string' ? v.slice(0, SESSION_TEXT_CAP) : fallback);

  const group = (key, fields) => {
    const out = {};
    const inc = b[key] && typeof b[key] === 'object' && !Array.isArray(b[key]) ? b[key] : null;
    for (const f of fields) {
      out[f] = inc && typeof inc[f] === 'string'
        ? inc[f].slice(0, SESSION_TEXT_CAP)
        : str((cur[key] || {})[f], '');
    }
    return out;
  };

  // In-world dates are GM-set ONLY — never inferred from the real-world date,
  // never auto-filled, never back-filled by a migration. An invalid one is
  // rejected outright rather than silently dropped, so a GM notices a typo.
  let inWorldDate = cur.inWorldDate || null;
  if ('inWorldDate' in b) {
    if (b.inWorldDate == null) inWorldDate = null;
    else {
      const v = calendarMath.validateDate(calendar, b.inWorldDate);
      if (!v.ok) return { error: `In-world date: ${v.error}` };
      inWorldDate = v.value;
    }
  }

  let date = cur.date || null;
  if ('date' in b) {
    if (b.date == null || b.date === '') date = null;
    else if (typeof b.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.date)) date = b.date;
    else return { error: 'Date must look like 2026-02-14.' };
  }

  const ids = key => (Array.isArray(b[key])
    ? b[key].filter(x => safeId(x)).slice(0, SESSION_LIST_CAP)
    : (Array.isArray(cur[key]) ? cur[key] : []));

  const encounters = Array.isArray(b.encounters)
    ? b.encounters.slice(0, SESSION_LIST_CAP).map(e => ({
        name:   typeof (e && e.name) === 'string' ? e.name.slice(0, 200) : '',
        notes:  typeof (e && e.notes) === 'string' ? e.notes.slice(0, SESSION_TEXT_CAP) : '',
        status: (e && e.status) === 'run' ? 'run' : 'ready',
      }))
    : (Array.isArray(cur.encounters) ? cur.encounters : []);

  // Prep is a list of SCENES (the "Script" template), not a flat who/what/where
  // block. An incoming array replaces the whole list wholesale — same as
  // `encounters` — since scenes are reordered/added/removed together from one
  // form, not patched field-by-field like `prep`/`record` used to be.
  const scenes = Array.isArray(b.scenes)
    ? b.scenes.slice(0, SESSION_LIST_CAP).map(sc => {
        const out = {};
        for (const f of SESSION_SCENE_FIELDS) {
          out[f] = typeof (sc && sc[f]) === 'string'
            ? sc[f].slice(0, f === 'name' ? 200 : SESSION_TEXT_CAP)
            : '';
        }
        return out;
      })
    : (Array.isArray(cur.scenes) ? cur.scenes : []);

  return {
    session: {
      id:          cur.id,
      number:      Number.isInteger(cur.number) ? cur.number : 1,
      title:       typeof b.title === 'string' ? b.title.slice(0, 200) : str(cur.title, ''),
      date,
      inWorldDate,
      visibility:  SESSION_VISIBILITY.includes(b.visibility)
                     ? b.visibility
                     : (SESSION_VISIBILITY.includes(cur.visibility) ? cur.visibility : DEFAULT_SESSION_VISIBILITY),
      scenes,
      record:      group('record', SESSION_RECORD_FIELDS),
      nextTime:    typeof b.nextTime === 'string' ? b.nextTime.slice(0, SESSION_TEXT_CAP) : str(cur.nextTime, ''),
      cast:        ids('cast'),
      loreRefs:    ids('loreRefs'),
      encounters,
      createdAt:   cur.createdAt || new Date().toISOString(),
      updatedAt:   new Date().toISOString(),
    },
  };
}

// Campaign write access, matching PUT /api/campaigns/:id: the owning GM, or an
// admin. Reads use resolveCampaignRole instead, which deliberately does NOT grant
// admin visibility into another GM's campaign.
function ownsCampaign(campaign, user) {
  return !!user && (user.admin || campaign.ownedBy === user.username);
}

function campaignsOfWorld(worldId) {
  return getCampaigns().filter(c => c.worldId === worldId);
}

// List ONE user's character records as { id, filePath } — top-level envelopes
// only (sidecars have an extra-dotted stem and are skipped, like the roster scan),
// so a cascade only ever touches real characters in that user's own folder.
function userCharacterFiles(username) {
  const dir = userCharDir(username);
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json') || RESERVED_JSON.has(name)) continue;
    const stem = name.slice(0, -5);
    if (!safeId(stem)) continue;             // skips ${id}.sessions.json etc.
    out.push({ id: stem, filePath: path.join(dir, name) });
  }
  return out;
}

// Clear the campaign envelope on the characters of `username` whose current
// campaign is in `keys` (a campaignKeySet). Reads each record from disk and writes
// it back — never trusts a client body. Returns how many were changed. Shared by
// the revoke cascade and the GM campaign-kick.
function clearCampaignForUserChars(username, keys) {
  let changed = 0;
  for (const { id, filePath } of userCharacterFiles(username)) {
    const char = readCharFull({ filePath, username });
    if (!matchesCampaign(char.campaignId, keys)) continue;
    char.campaignId   = null;
    char.campaignCode = null;
    char.campaignName = null;
    char.updatedAt    = new Date().toISOString();
    writeCharSplit(username, id, char);
    changed++;
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Keep — Worlds + Lore
//
// Worlds live in a flat worlds.json (git-friendly, portable), exactly like
// campaigns. Lore entries are one-file-per-entry under data/lore/<worldId>/,
// with a `.history.json` sidecar per entry (snapshots, not diffs). A world is
// OWNER-ONLY: unlike campaigns, admin does NOT get to peek into another GM's
// world — the owner check below deliberately omits the admin exemption.
// ---------------------------------------------------------------------------

function getWorlds() {
  if (!fs.existsSync(WORLDS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(WORLDS_FILE, 'utf8'));
  } catch (e) {
    console.error('[worlds] Failed to parse worlds.json:', e.message);
    return [];
  }
}

function saveWorlds(worlds) {
  fs.writeFileSync(WORLDS_FILE, JSON.stringify(worlds, null, 2));
}

// Per-world backdrop image path. worldId is validated (safeId) before we get
// here, so it can't escape WORLD_ASSETS_DIR. Mirrors portraitPath — one asset
// per world, named `${id}.backdrop.<ext>`.
function worldBackdropPath(worldId, ext) {
  return path.join(WORLD_ASSETS_DIR, `${worldId}.backdrop${ext}`);
}

// A record id the SERVER owns: slug of the name + a short random suffix, kept
// lowercase so it round-trips safely through case-insensitive filesystems and
// passes safeId(). Used for both worlds and lore entries.
function newRecordId(name) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(5);
  let rand = '';
  for (let i = 0; i < 5; i++) rand += chars[bytes[i] % chars.length];
  const slug = slugify(name);
  return slug ? `${slug}-${rand}` : rand;
}

// Owner-only guard for a world. Resolves the world once and stashes it on
// req.world so the handler doesn't look it up again. Place AFTER validId.
// NOTE: no admin exemption — a world is visible only to the GM who owns it.
function requireWorldOwner(req, res, next) {
  const world = getWorlds().find(w => w.id === req.params.id);
  if (!world) return res.status(404).json({ error: 'Not found' });
  if (world.ownedBy !== req.session.user.username) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  req.world = world;
  next();
}

// The viewer's ROLE in a world (§4.8): 'owner' if they own it, else their ledger
// tier ('read'|'propose'|'coGM'), else null (no access). Identity comes from the
// session, never the body. A member row with a missing/garbage tier fails safe to
// 'read' (the auto-grant floor) rather than granting anything higher.
function worldRoleFor(world, username) {
  if (world.ownedBy === username) return 'owner';
  const m = world.members && typeof world.members === 'object' ? world.members[username] : null;
  if (!m) return null;
  return MEMBER_TIERS.includes(m.tier) ? m.tier : 'read';
}

// READ guard for a world (§4.8): allow the owner OR any ledger member; otherwise
// 404 (don't confirm a world exists to someone with no access, matching the
// campaign style). Stashes req.world + req.worldRole. Place AFTER validId. Used by
// CONTENT-READ routes only — every management/mutation route keeps requireWorldOwner.
function requireWorldRead(req, res, next) {
  // Share-link readers are pinned to the LOWEST tier, 'read'. Everything
  // downstream — canSee filtering, fog stripping, asset gating — is then the
  // same code path a `read` member takes, so a share link can never see more
  // than the most restricted logged-in player. There is deliberately no way to
  // issue a propose/write share link (see the share-create route).
  if (req.isWorldShare) {
    req.world     = req.shareWorld;
    req.worldRole = 'read';
    return next();
  }
  const world = getWorlds().find(w => w.id === req.params.id);
  const role  = world ? worldRoleFor(world, req.session.user.username) : null;
  if (!world || !role) return res.status(404).json({ error: 'Not found' });
  req.world     = world;
  req.worldRole = role;
  next();
}

// CONTENT guard: owner or coGM may reach entry create/edit/delete. A stranger
// 404s (as requireWorldRead); a read/propose member — who CAN see the world —
// gets 403 (they have access, just not GM status). Everything STRUCTURAL (world
// delete, categories, members, settings, pack) stays on requireWorldOwner, so a
// coGM can never lock the owner out. Stashes req.world + req.worldRole.
function requireWorldWrite(req, res, next) {
  const world = getWorlds().find(w => w.id === req.params.id);
  const role  = world ? worldRoleFor(world, req.session.user.username) : null;
  if (!world || !role) return res.status(404).json({ error: 'Not found' });
  if (!isWorldGM(role)) return res.status(403).json({ error: 'Forbidden' });
  req.world     = world;
  req.worldRole = role;
  next();
}

// The world record a NON-OWNER member may receive: strip the `members` ledger
// (other players' access is not their business) and tag the viewer's role. The
// owner always gets the full record (with its own role tag) elsewhere.
//
// `shares` is stripped for the same reason shareSafeChar strips a character's:
// the token list is the credential itself. Handing it to a member — or, worse,
// to a share-link reader, who receives this same view — would let anyone with
// read access mint a permanent link out of the payload.
function memberWorldView(world, role) {
  const { members, shares, ...safe } = world;
  return { ...safe, role };
}

// The calendar a world actually uses. Resolution order:
//   1. the world's OWN calendar (`world.calendar`, GM-authored, app-owned)
//   2. its pack's calendar.json (a TEMPLATE — a starting point, not the authority)
//   3. null — no calendar, and calendar-date fields degrade to read-only
//
// A calendar is LORE, not rules: Harptos is Forgotten Realms, usable under any
// ruleset. So the WORLD owns it and the pack merely offers one, which is the same
// relationship categoryConfig has with the pack's category labels.
//
// Re-cleaned on every read rather than trusted as stored, so a hand-edited
// worlds.json can never push an unvalidated shape into the date math. That is
// cheap (cleanCalendar is pure and the record is capped) and it is a FIXPOINT —
// cleaning an already-clean calendar returns it unchanged, see worldCalendar_test.
// The baked-in default, normalized once at boot so it is guaranteed to be in the
// exact shape the date math expects (and a bad edit to the constant surfaces on
// startup rather than at request time).
const BUILTIN_CALENDAR = packs.cleanCalendar(packs.DEFAULT_CALENDAR, 'built-in');

// The calendar a world actually uses. NEVER returns null — every world has one:
//   1. the world's OWN calendar (`world.calendar`, GM-authored/forked)
//   2. an explicit "use the built-in, not the pack's" preference
//   3. the pack's calendar.json (a template a pack author supplies)
//   4. the baked-in default
//
// IMPORTANT: `world.calendarHidden` is NOT consulted here. Hiding the calendar is
// a DISPLAY choice, and this function feeds sanitizeEntryFields on every lore
// save — where a null calendar actively NULLS stored calendar-date values. If
// hiding resolved to null, toggling the calendar off and then editing any entry
// would silently erase every in-world date in the world. Hiding must stay as
// non-destructive as hiding a category, which keeps all its entries.
function resolveWorldCalendar(world) {
  if (world && world.calendar) {
    const own = packs.cleanCalendar(world.calendar, `world '${world.id}'`);
    if (own) return own;                    // fall through if a hand-edit broke it
  }
  if (world && world.calendarSource === 'builtin') return BUILTIN_CALENDAR;
  return packs.loadCalendar(DATA_DIR, world && world.packId) || BUILTIN_CALENDAR;
}

// Which of the four the world is currently on — drives the settings banner so the
// GM always knows whether they're looking at their own copy or a template.
function calendarSourceOf(world) {
  if (world && world.calendar) return 'own';
  if (world && world.calendarSource === 'builtin') return 'builtin';
  return packs.loadCalendar(DATA_DIR, world && world.packId) ? 'pack' : 'builtin';
}

// Per-world lore directory. worldId is validated (safeId) before we get here.
function loreDir(worldId) {
  return path.join(LORE_DIR, worldId);
}
function lorePath(worldId, entryId) {
  return path.join(loreDir(worldId), `${entryId}.json`);
}
function loreHistoryPath(worldId, entryId) {
  return path.join(loreDir(worldId), `${entryId}.history.json`);
}

function readLoreEntry(worldId, entryId) {
  const p = lorePath(worldId, entryId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error(`[lore] Failed to parse ${p}: ${e.message}`);
    return null;
  }
}

// --- system reference (Wave C) -----------------------------------------------
//
// Same storage grammar as lore — one JSON file per entry under a per-world dir —
// because it IS the same kind of record, just stamped. A separate tree
// (data/sysref/<worldId>/) rather than a reserved lore category, for the reason
// §4k gave for world assets: anything living in the lore dir shows up in the lore
// scan, the category rail and the broken-links pass, and would have to be
// filtered out of each by hand forever.
//
// The record deliberately reuses `categoryId` for its type id and `visibility`
// for its secrecy, so serializeEntryForRole / canSee / the fog stripper operate on
// it with ZERO new code — the type list from systemRef.js is category-shaped for
// exactly this reason. What it adds is `systemId`: the stamp naming the ruleset
// the entry was written for, which is what lets the world outlive the system.
function sysrefDir(worldId) {
  return path.join(SYSREF_DIR, worldId);
}
function sysrefPath(worldId, entryId) {
  return path.join(sysrefDir(worldId), `${entryId}.json`);
}

function readSysrefEntry(worldId, entryId) {
  const p = sysrefPath(worldId, entryId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error(`[sysref] Failed to parse ${p}: ${e.message}`);
    return null;
  }
}

// The reference types available in a world: its `primarySystemId` resolved through
// the bundle registry. Returns [] when the world has no system set or its bundle
// is gone — never a fallback set. Unlike lore categories there is no honest
// default here: nobody's rules are the generic rules, and inventing a shape would
// mis-file every entry authored under it.
function worldSystemTypes(world) {
  if (!world || !world.primarySystemId) return [];
  return systemRef.loadSystemTypes(DATA_DIR, world.primarySystemId) || [];
}


// --- one-time migration to the three-role / two-state model ------------------
//
// The old model overloaded ONE ordinal scale for both capability and secrecy:
// member tiers were read|propose|write and entry visibility was
// hidden|read|propose|write, compared by rank. That coupled "may edit" to "may
// see", so granting a player edit rights silently handed them every GM secret.
//
// Both mappings FAIL CLOSED (see loreAccess.migrateRole / migrateVisibility):
//   • members: `write` DOWNGRADES to `propose`. Promoting it to coGM would grant
//     fog clearance over the whole world — the owner re-grants coGM by hand.
//   • entries: only old `read` becomes `shared`. `propose`/`write` meant MORE
//     secret than read, so they stay hidden for the owner to re-share deliberately.
//
// Runs once at boot, before the first request. Idempotent: already-migrated data
// maps to itself, so a restart is a no-op and logs nothing. Never throws — a
// migration crash must not stop the server booting.
function migrateWorldModel() {
  let members = 0, entries = 0, worldsTouched = 0;

  try {
    const worlds = getWorlds();
    let dirty = false;
    for (const w of worlds) {
      if (!w || !w.members || typeof w.members !== 'object') continue;
      let wDirty = false;
      for (const [userId, m] of Object.entries(w.members)) {
        if (!m || typeof m !== 'object') continue;
        const next = migrateRole(m.tier);
        if (next !== m.tier) {
          console.log(`[migrate] world ${w.id}: member ${userId} tier '${m.tier}' -> '${next}'`);
          m.tier = next;
          members++; wDirty = true;
        }
      }
      if (wDirty) { dirty = true; worldsTouched++; }
    }
    if (dirty) saveWorlds(worlds);
  } catch (e) {
    console.error('[migrate] member tiers failed:', e.message);
  }

  try {
    if (fs.existsSync(LORE_DIR)) {
      for (const worldId of fs.readdirSync(LORE_DIR)) {
        const dir = loreDir(worldId);
        let stat; try { stat = fs.statSync(dir); } catch { continue; }
        if (!stat.isDirectory()) continue;
        for (const file of fs.readdirSync(dir)) {
          // Entry files only — skip the .history/.proposals/.assets sidecars.
          if (!file.endsWith('.json')) continue;
          if (/\.(history|proposals|assets)\.json$/.test(file)) continue;
          const p = path.join(dir, file);
          try {
            const entry = JSON.parse(fs.readFileSync(p, 'utf8'));
            const next = migrateVisibility(entry.visibility);
            if (next !== entry.visibility) {
              console.log(`[migrate] ${worldId}/${file}: visibility '${entry.visibility}' -> '${next}'`);
              entry.visibility = next;
              fs.writeFileSync(p, JSON.stringify(entry, null, 2));
              entries++;
            }
          } catch (e) {
            console.error(`[migrate] skipped ${p}: ${e.message}`);
          }
        }
      }
    }
  } catch (e) {
    console.error('[migrate] entry visibility failed:', e.message);
  }

  if (members || entries) {
    console.log(`[migrate] done: ${members} member tier(s) across ${worldsTouched} world(s), ${entries} entry visibility value(s).`);
    if (members) console.log('[migrate] NOTE: former `write` members are now `propose`. Re-grant coGM deliberately.');
  }
}

// Read the history sidecar (tolerant of a corrupt/absent one — log + fall back,
// never crash the load, same discipline as character sidecars).
function readLoreHistory(worldId, entryId) {
  const p = loreHistoryPath(worldId, entryId);
  if (!fs.existsSync(p)) return { versions: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(parsed?.versions) ? parsed : { versions: [] };
  } catch (e) {
    console.error(`[lore] Failed to parse history ${p}: ${e.message}`);
    return { versions: [] };
  }
}

// Append a snapshot (name + fields + visibility) of an entry's state to its
// history sidecar. Snapshots, not diffs — entries are small, so there's no
// reconstruction logic and no eval. Called on every successful PUT/restore.
function appendLoreHistory(worldId, entry, savedBy, reason) {
  const history = readLoreHistory(worldId, entry.id);
  history.versions.push({
    savedAt: new Date().toISOString(),
    savedBy,
    reason,
    body: {
      name:       entry.name,
      fields:     entry.fields || {},
      visibility: entry.visibility,
    },
  });
  fs.writeFileSync(loreHistoryPath(worldId, entry.id), JSON.stringify(history, null, 2));
}

// ---------------------------------------------------------------------------
// Proposals sidecar (§4.9 — propose tier). A per-entry `${entryId}.proposals.json`
// holding SUGGESTED edits a GM approves/rejects. Same sidecar convention as
// history (snapshots, not diffs; no DB; git-friendly) and, like history, its extra
// dot in the stem keeps it OUT of the lore list scan (which matches only plain
// `${id}.json`). A proposal never mutates the entry — approval does, through the
// normal update path so history still records the pre-edit snapshot.
// ---------------------------------------------------------------------------
function loreProposalsPath(worldId, entryId) {
  return path.join(loreDir(worldId), `${entryId}.proposals.json`);
}
function readLoreProposals(worldId, entryId) {
  const p = loreProposalsPath(worldId, entryId);
  if (!fs.existsSync(p)) return { proposals: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(parsed?.proposals) ? parsed : { proposals: [] };
  } catch (e) {
    console.error(`[lore] Failed to parse proposals ${p}: ${e.message}`);
    return { proposals: [] };
  }
}
function writeLoreProposals(worldId, entryId, data) {
  fs.writeFileSync(loreProposalsPath(worldId, entryId), JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// Per-entry lore assets — inline images AND downloadable attachments.
//
// Same "store inert, serve guarded" model as character attachments (§ up top),
// keyed to a lore entry instead of a character. Blobs live as flat siblings in
// the world's lore dir named with a SERVER token — `${entryId}.asset.<key>.<ext>`
// — and the human name/mime/size/sha live in a manifest sidecar
// `${entryId}.assets.json`. Both have an extra dot in the stem, so the
// entry-list scan (which matches only `${id}.json`) skips them, exactly like the
// history sidecar. Reuses the character ATTACH_* allowlist + magic-byte sniff, so
// one file-type policy governs every upload surface in the app.
// ---------------------------------------------------------------------------
const LORE_ASSET_MAX_PER_ENTRY = Number(process.env.LORE_ASSET_MAX_PER_ENTRY) || 50;
// Which allowlisted types are actually images (drives the inline-image `isImage`
// flag the editor uses to decide "insert into body" vs "list as a download").
const LORE_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);

function loreAssetsManifestPath(worldId, entryId) {
  return path.join(loreDir(worldId), `${entryId}.assets.json`);
}
function loreAssetBlobPath(worldId, entryId, key, ext) {
  return path.join(loreDir(worldId), `${entryId}.asset.${key}.${ext}`);
}

function readLoreAssets(worldId, entryId) {
  const p = loreAssetsManifestPath(worldId, entryId);
  if (!fs.existsSync(p)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error(`[lore] Failed to parse assets ${p}: ${e.message}`);
    return [];
  }
}
function writeLoreAssets(worldId, entryId, list) {
  fs.writeFileSync(loreAssetsManifestPath(worldId, entryId), JSON.stringify(list, null, 2));
}
// Best-effort removal of an entry's asset blobs + manifest (called on entry
// delete; world delete rm -rf's the whole lore dir so it's covered there).
function removeLoreAssets(worldId, entryId) {
  for (const a of readLoreAssets(worldId, entryId)) {
    const p = loreAssetBlobPath(worldId, entryId, a.key, a.ext);
    if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch { /* best-effort */ } }
  }
  const m = loreAssetsManifestPath(worldId, entryId);
  if (fs.existsSync(m)) { try { fs.unlinkSync(m); } catch { /* best-effort */ } }
}

// ---------------------------------------------------------------------------
// World-level asset store (§4k landing page)
//
// Same "store inert, serve guarded" model as the per-entry lore store (§4g), but
// keyed by worldId ALONE — the landing page has no entry to hang assets off. The
// blobs + manifest live in a per-world SUBDIR under WORLD_ASSETS_DIR, so they
// coexist cleanly with the flat backdrop file `<worldId>.backdrop.<ext>` already
// there (different dir, different stem). Deliberately NOT a reserved lore entry:
// a fake entry would leak into the entry-list scan, the rail, and broken-links.
// ---------------------------------------------------------------------------
const WORLD_ASSET_MAX = Number(process.env.WORLD_ASSET_MAX) || 50;
// Length ceiling for a world's landing Markdown (roomy enough for a rich home
// page, bounded so a runaway body can't bloat worlds.json).
const LANDING_MAX = Number(process.env.LANDING_MAX) || 20000;

function worldAssetsDir(worldId) {
  return path.join(WORLD_ASSETS_DIR, worldId);
}
function worldAssetsManifestPath(worldId) {
  return path.join(worldAssetsDir(worldId), 'assets.json');
}
function worldAssetBlobPath(worldId, key, ext) {
  return path.join(worldAssetsDir(worldId), `asset.${key}.${ext}`);
}
function readWorldAssets(worldId) {
  const p = worldAssetsManifestPath(worldId);
  if (!fs.existsSync(p)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error(`[world-assets] Failed to parse ${p}: ${e.message}`);
    return [];
  }
}
function writeWorldAssets(worldId, list) {
  fs.mkdirSync(worldAssetsDir(worldId), { recursive: true });
  fs.writeFileSync(worldAssetsManifestPath(worldId), JSON.stringify(list, null, 2));
}
// Best-effort removal of a world's whole asset subdir (called on world delete).
function removeWorldAssets(worldId) {
  const dir = worldAssetsDir(worldId);
  if (fs.existsSync(dir)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); }
    catch (e) { console.error(`[world-assets] Failed to remove ${dir}: ${e.message}`); }
  }
}

function requireAuth(req, res, next) {
  // A world share link (see the world-share gate) is deliberately
  // UNAUTHENTICATED — the token IS the credential, exactly as a character share
  // link is. The gate has already resolved the token, checked its expiry,
  // rejected every non-GET method and matched the path against a read-only
  // allowlist, so by here the request is provably a read of one world's content.
  if (req.isWorldShare) return next();
  if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
  // Absolute-lifetime ceiling: force re-login past the hard cap even on an active
  // (sliding) session. Older sessions with no stamp are treated as expired.
  if (Date.now() > (req.session.absoluteExp || 0)) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'Session expired — please log in again' });
  }
  const u = getUsers().find(u => u.username === req.session.user.username);
  if (!u || (u.tokenVersion || 1) !== (req.session.user.tokenVersion || 1)) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'Session invalidated — please log in again' });
  }
  next();
}

// Character / campaign ids are slug-suffix or 12-char tokens. Reject anything
// with path separators, dots, or other surprises before it reaches the
// filesystem. Use as: if (!safeId(req.params.id)) return res.status(400)...
function safeId(id) {
  return typeof id === 'string' && /^[a-z0-9-]{1,80}$/i.test(id);
}

// Password policy now lives in the shared ./validatePassword module (passwordError),
// imported at the top of this file and ALSO used by adduser.js so the CLI and the
// API can't drift. It enforces a length floor plus a basic weak/breached blocklist.

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

const PORTRAIT_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];

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
// Dice macro pages
//
// Per-character, user-authored roll shortcuts shown on the dice tray's macro
// pages. Same reasoning as the roll log above for why this is its OWN sidecar
// rather than a bundle-declared sidecarPath or a field on the character:
//   • It's owned by the dice tray (host/core), so every bundle with dice
//     enabled gets it with no schema opt-in.
//   • It's saved by its own endpoint, so it never races the sheet's debounced
//     autosave (they'd otherwise read-modify-write the same document).
//
// Storage is `${id}.macros.json`, so collectCharacterFiles() picks it up for
// free (rename/delete/export all follow) and findAllCharFiles()'s safeId(stem)
// check keeps it out of the roster scan — exactly like `${id}.rolls.json`.
//
// Shape: an ORDERED array of pages, each an ordered array of macros:
//   [ { macros: [ { id, name, notation } ] }, … ]
// Pages hold different numbers of macros by design (page 1 may have 2, page 2
// three) — the tray renders whatever a page contains plus empty slots in edit
// mode.
//
// The server validates SHAPE and LENGTH only, never notation VALIDITY: the
// dice notation grammar lives in the frontend parser (diceParser.js) and the
// backend has no copy. The editor rejects bad notation before saving; a
// hand-crafted bad string is caught at roll time and simply fails that roll,
// which is a strictly local, non-destructive failure. Duplicating the grammar
// server-side would be a second source of truth to keep in sync — the exact
// drift the mirrored-module notes elsewhere in this repo warn about.
// ---------------------------------------------------------------------------
const MACRO_PAGES_MAX     = 10;
const MACROS_PER_PAGE_MAX = 12;
const MACRO_NAME_MAX      = 40;
const MACRO_NOTATION_MAX  = 120;

function macrosFilePath(username, id) {
  return path.join(userCharDir(username), `${id}.macros.json`);
}

function readMacros(username, id) {
  const p = macrosFilePath(username, id);
  if (!fs.existsSync(p)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    // Tolerate a corrupt sidecar: log and fall back to "no macros" rather than
    // failing the tray open. Same posture as every other sidecar read.
    console.error(`[macros] Failed to parse ${p}: ${e.message}`);
    return [];
  }
}

// Defensive normaliser — the client is not trusted to send a well-formed tree.
// Anything unrecognised is dropped rather than stored, so a malformed save can
// never poison a later read.
function cleanMacroPages(raw) {
  if (!Array.isArray(raw)) return null;
  return raw.slice(0, MACRO_PAGES_MAX).map((page) => {
    const macros = Array.isArray(page?.macros) ? page.macros : [];
    return {
      macros: macros
        .filter(m => m && typeof m === 'object'
          && typeof m.name === 'string' && typeof m.notation === 'string'
          && m.notation.trim())
        .slice(0, MACROS_PER_PAGE_MAX)
        .map(m => ({
          // The id is a client-side React key only, so a client-supplied one is
          // harmless — but re-mint anything that isn't a plain safe token so a
          // crafted value can never reach a filesystem or DOM-sensitive path.
          id:       (typeof m.id === 'string' && /^[a-zA-Z0-9_-]{1,32}$/.test(m.id))
                      ? m.id : generateToken(8),
          name:     m.name.trim().slice(0, MACRO_NAME_MAX),
          notation: m.notation.trim().slice(0, MACRO_NOTATION_MAX),
        })),
    };
  });
}

// ---------------------------------------------------------------------------
// Express setup
// ---------------------------------------------------------------------------

const isProd = process.env.NODE_ENV === 'production';

// NPM (Nginx Proxy Manager) terminates TLS and forwards over http with
// X-Forwarded-* headers. Trust the first proxy hop so express-session sees the
// request as secure and express-rate-limit reads the real client IP.
app.set('trust proxy', TRUST_PROXY_HOPS);

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
// Default ON (enforced). Set CSP_ENFORCE=false to fall back to Report-Only for
// debugging. The enforced CSP keeps 'unsafe-inline' in scriptSrc/styleSrc (see
// below), so enforcing it does not break CRA's inlined runtime or React inline
// styles — it just stops being advisory.
const cspEnforce      = process.env.CSP_ENFORCE !== 'false';
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
      // Helmet adds `upgrade-insecure-requests` by default. It's INERT in
      // report-only mode, but once CSP is enforced it rewrites every relative
      // subresource (our own /static/js bundle included) from http→https. This
      // app is designed to speak plain HTTP internally with TLS terminated at a
      // reverse proxy (and to run over http on localhost in dev), so that upgrade
      // makes the browser request https on a port with no TLS — the bundle fails
      // to load and the page goes white. Setting it to null removes the directive;
      // real HTTPS is enforced by the proxy + HSTS, not by this. (`null` is
      // helmet's documented way to drop a default directive.)
      upgradeInsecureRequests: null,
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

app.use(express.json({ limit: '1mb' }));
app.use(session({
  // File-backed store (backend/sessionStore.js) instead of express-session's
  // default in-memory store, which leaks memory and drops every session on
  // restart. Hand-rolled to avoid a new npm dependency, matching the app's
  // JSON-per-record persistence convention.
  store: createFileSessionStore({ dir: SESSIONS_DIR, ttlMs: 1000 * 60 * 60 * 24 * 7 }),
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
// Default ON. Set CSRF_ENFORCE=false only to temporarily disable the validator
// (the issuer always runs regardless). Every same-origin mutation carries the
// token automatically via the SPA's fetch interceptor (frontend/src/index.js).
const csrfEnforce = process.env.CSRF_ENFORCE !== 'false';
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

// Serve world backdrop images. The asset dir holds only images (no JSON lives
// here), but keep the same image-only guard as /portraits so nothing but an
// image extension is ever served.
app.use('/world-backdrops', (req, res, next) => {
  if (!/\.(jpg|jpeg|png|webp|gif)$/i.test(req.path)) {
    return res.status(404).json({ error: 'Not found' });
  }
  next();
}, express.static(WORLD_ASSETS_DIR, {
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
    // X-CSRF-Token must be allowed or cross-origin (dev) mutations get their CSRF
    // header stripped by the preflight and fail once CSRF_ENFORCE is on (default).
    res.header('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH');
    res.header('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Global API rate limit — a broad ceiling so no single client can flood the
// disk-scanning list/search routes and saturate the single Node event loop.
// Deliberately generous (a busy SPA session fires many legit requests); it only
// bites abuse, not real use. The stricter login/setup limiters stack on top.
// trust proxy (set above) is what makes req.ip the real client IP here.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      1000,             // ~66 req/min/IP sustained — ruinous only for a flood
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many requests. Please slow down.' },
});
app.use('/api', apiLimiter);

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
if (!fs.existsSync(LORE_DIR))  fs.mkdirSync(LORE_DIR,  { recursive: true });
if (!fs.existsSync(SYSREF_DIR)) fs.mkdirSync(SYSREF_DIR, { recursive: true });
if (!fs.existsSync(WORLD_ASSETS_DIR)) fs.mkdirSync(WORLD_ASSETS_DIR, { recursive: true });
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// Bootstrap a first admin from env vars on a fresh install
seedInitialAdmin();

// Scan sheet bundles
sheets.scanBundles(DATA_DIR);
sheets.registerRoutes(app, DATA_DIR, requireAuth);

// Scan/seed lore packs (Keep) — mirrors scanBundles for the world-building side.
packs.scanPacks(DATA_DIR);

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

// Pre-computed at startup so unknown-username login attempts take the same
// ~100ms as a real bcrypt compare, preventing timing-based username enumeration.
const DUMMY_HASH = bcrypt.hashSync('__dummy_sentinel__', BCRYPT_COST);

// Brute-force protection: cap login attempts per IP. Counts all attempts
// (not just failures) so a flood of guesses can't slip through.
const loginLimiter = rateLimit({
  windowMs: 30 * 60 * 1000,   // 30 minutes
  max:      10,               // per IP per window
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many login attempts. Try again later.' },
});

// Per-USERNAME cap, layered on top of the per-IP one. The per-IP limiter alone
// lets an attacker with many IPs (a botnet / rotating proxies) keep guessing a
// single account — this ceiling throttles attempts against one username no
// matter where they come from. Keyed on the (lowercased) submitted username.
const loginUserLimiter = rateLimit({
  windowMs: 30 * 60 * 1000,
  max:      20,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator: (req) => `login:${String(req.body?.username || '').toLowerCase()}`,
  message: { error: 'Too many login attempts for this account. Try again later.' },
});

// Tighter cap on account-mutation routes (create/reset). These are admin-gated
// already, but a stricter throttle limits abuse if an admin session is hijacked.
const accountLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max:      20,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many account changes. Try again later.' },
});

app.post('/api/login', loginLimiter, loginUserLimiter, async (req, res) => {
  const { username, password } = req.body;
  const users = getUsers();
  const user  = users.find(u => u.username === username);
  const hash  = user ? user.password : DUMMY_HASH;
  const match = await bcrypt.compare(String(password || ''), hash);
  if (!user || !match) return res.status(401).json({ error: 'Invalid credentials' });
  req.session.absoluteExp = Date.now() + MAX_SESSION_AGE_MS;
  req.session.user = {
    username:     user.username,
    admin:        user.admin    || false,
    gm:           user.gm       || false,
    player:       user.player   || false,
    theme:        user.theme  || getSettings().theme || 'tavern',
    sortBy:       user.sortBy || 'updatedAt',
    diceScale:    user.diceScale ?? 3,
    tokenVersion: user.tokenVersion || 1,
  };
  appendLog('logins', { username: user.username, at: new Date().toISOString(), ip: normalizeIp(req.ip) });
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
const DICE_SCALE_MIN = 1;
const DICE_SCALE_MAX = 5;

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

  if ('diceScale' in req.body) {
    // Clamp to the valid integer range; non-numeric input defaults to 3.
    const raw   = parseInt(req.body.diceScale, 10);
    const scale = Number.isNaN(raw)
      ? 3
      : Math.max(DICE_SCALE_MIN, Math.min(DICE_SCALE_MAX, raw));
    user.diceScale = scale;
    req.session.user.diceScale = scale;
  }

  saveUsers(users);
  res.json({
    theme:     req.session.user.theme,
    sortBy:    req.session.user.sortBy,
    diceScale: req.session.user.diceScale,
  });
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

  const hash = await bcrypt.hash(password, BCRYPT_COST);

  // Re-check AFTER the async hash: the window must still be open. Closes the
  // tiny single-process race where two requests both saw zero users.
  if (getUsers().length > 0) {
    return res.status(403).json({ error: 'Setup has already been completed' });
  }

  // First account on a personal instance gets every role so nothing is locked
  // away before the admin panel exists. Change to admin-only here if you prefer.
  saveUsers([{ username, password: hash, admin: true, gm: true, player: true }]);

  // Log them straight in so the wizard lands on the roster.
  req.session.absoluteExp = Date.now() + MAX_SESSION_AGE_MS;
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
app.post('/api/users', accountLimiter, requireAuth, requireAdmin, async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });

    const usernameError = validateUsername(username);
  if (usernameError) return res.status(400).json({ error: usernameError });

  // Enforce the shared password policy here too — previously this route skipped
  // it, so an admin-created account could be weaker than a setup/reset one. Same
  // passwordError() the CLI and every other path uses, so the floor can't drift.
  const pwErr = passwordError(password);
  if (pwErr) return res.status(400).json({ error: pwErr });

  const users = getUsers();
  if (users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
    return res.status(409).json({ error: 'A user with that name already exists' });
  }

  const user = {
    username,
    password:     await bcrypt.hash(password, BCRYPT_COST),
    admin:        !!req.body.admin,
    gm:           !!req.body.gm,
    player:       !!req.body.player,
    tokenVersion: 1,
  };
  users.push(user);
  saveUsers(users);
  res.json(publicUser(user));
});

// PATCH /api/users/:username — update roles and/or reset password
//   body may include any of: { admin, gm, player, password }
app.patch('/api/users/:username', accountLimiter, requireAuth, requireAdmin, async (req, res) => {
  const users = getUsers();
  const user  = users.find(u => u.username === req.params.username);
  if (!user) return res.status(404).json({ error: 'Not found' });

  // Guard against self-lockout: an admin can't strip their own admin role.
  const self = req.params.username === req.session.user.username;
  if (self && 'admin' in req.body && !req.body.admin) {
    return res.status(400).json({ error: "You can't remove your own admin role" });
  }

  let changed = false;
  for (const role of ['admin', 'gm', 'player']) {
    if (role in req.body) { user[role] = !!req.body[role]; changed = true; }
  }
  if (req.body.password) {
    const pwErr = passwordError(String(req.body.password));
    if (pwErr) return res.status(400).json({ error: pwErr });
    user.password = await bcrypt.hash(String(req.body.password), BCRYPT_COST);
    changed = true;
  }
  if (changed) user.tokenVersion = (user.tokenVersion || 1) + 1;

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

// GET /api/users/assignable — list of users available for a character transfer.
// If allowUserListForTransfer is on, returns all users except the caller.
// If off, returns only admin users (so non-admins can still hand off to an admin).
app.get('/api/users/assignable', requireAuth, (req, res) => {
  const settings    = getSettings();
  const currentUser = req.session.user.username;
  const users       = getUsers();
  const list = users.filter(u => {
    if (u.username === currentUser) return false;
    return settings.allowUserListForTransfer || u.admin;
  });
  res.json(list.map(u => ({ username: u.username, admin: !!u.admin })));
});

// POST /api/characters/:id/transfer — transfer ownership to another user.
// Only the owner (or an admin) may call this. Moves all character files to
// the new owner's directory and updates the owner field in the JSON.
app.post('/api/characters/:id/transfer', requireAuth, validId, (req, res) => {
  const found = findCharFile(req.params.id);
  if (!found) return res.status(404).json({ error: 'Not found' });

  if (!req.session.user.admin && found.username !== req.session.user.username) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const newOwner = String(req.body?.newOwner || '').trim();
  if (!newOwner) return res.status(400).json({ error: 'newOwner is required' });
  if (newOwner === found.username) {
    return res.status(400).json({ error: 'Character already belongs to that user' });
  }

  const users = getUsers();
  if (!users.find(u => u.username === newOwner)) {
    return res.status(404).json({ error: 'Target user not found' });
  }

  ensureUserCharDir(newOwner);
  const files = collectCharacterFiles(found.username, req.params.id);
  for (const f of files) {
    fs.renameSync(f.full, path.join(userCharDir(newOwner), path.basename(f.full)));
  }

  // Update the owner field in the moved character JSON.
  const newCharPath = charPath(newOwner, req.params.id);
  try {
    const char  = JSON.parse(fs.readFileSync(newCharPath));
    char.owner  = newOwner;
    char.updatedAt = new Date().toISOString();
    fs.writeFileSync(newCharPath, JSON.stringify(char, null, 2));
  } catch { /* file move succeeded; metadata update is best-effort */ }

  res.json({ ok: true, newOwner });
});

// ---------------------------------------------------------------------------
// App settings (single shared file: app-chrome theme + external-link policy)
// ---------------------------------------------------------------------------

const SETTINGS_FILE    = path.join(DATA_DIR, 'settings.json');
const DEFAULT_SETTINGS = { theme: 'tavern', allowExternalLinks: false, allowAttachments: false, allowUserListForTransfer: false };

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

// Admin only — activity logs (login events + share-link accesses).
app.get('/api/admin/logs', requireAuth, requireAdmin, (req, res) => {
  res.json(getLogs());
});

// Admin only — update theme and/or link policy.
app.put('/api/settings', requireAuth, requireAdmin, (req, res) => {
  const next = getSettings();
  if ('theme' in req.body)              next.theme = String(req.body.theme || 'tavern');
  if ('allowExternalLinks' in req.body) next.allowExternalLinks = !!req.body.allowExternalLinks;
  if ('allowAttachments' in req.body)        next.allowAttachments        = !!req.body.allowAttachments;
  if ('allowUserListForTransfer' in req.body) next.allowUserListForTransfer = !!req.body.allowUserListForTransfer;
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

// World backdrop upload — same pattern as the portrait multer, keyed to a world
// instead of a character. requireWorldOwner runs BEFORE this (see the route), so
// by the time the file lands the requester is confirmed to own the world; the
// filename comes from the validated :id, never from the client. A backdrop is a
// scenic map, so the cap is a touch higher than a portrait's.
const worldBackdropStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync(WORLD_ASSETS_DIR)) fs.mkdirSync(WORLD_ASSETS_DIR, { recursive: true });
    cb(null, WORLD_ASSETS_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${req.params.id}.backdrop${ext}`);
  },
});
const worldBackdropUpload = multer({
  storage: worldBackdropStorage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB cap — backdrops are scenic
  fileFilter: (req, file, cb) => cb(null, /\.(jpg|jpeg|png|webp|gif)$/i.test(file.originalname)),
});

app.post('/api/characters/:id/portrait', requireAuth, validId, requireCharOwner, upload.single('portrait'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });

  // Magic-byte verify the written file — a renamed non-image is deleted and
  // rejected, matching the attachment / lore-asset upload guarantee.
  const ext = path.extname(req.file.filename).slice(1).toLowerCase();
  if (!verifyImageFile(req.file.path, ext)) {
    try { fs.unlinkSync(req.file.path); } catch { /* best effort */ }
    return res.status(415).json({ error: "File contents don't match its type" });
  }

  const owner = req.portraitOwner || req.session.user.username;
  const portraitUrl = `/portraits/${owner}/${req.file.filename}`;

  // Clean up old portraits with different extensions
  const extensions = PORTRAIT_EXTENSIONS;
  extensions.forEach(ext => {
    const old = portraitPath(owner, req.params.id, ext);
    if (fs.existsSync(old) && old !== req.file.path) fs.unlinkSync(old);
  });

  // Update the character envelope's portrait field. requireCharOwner already
  // resolved and authorized the character, so req.foundChar is guaranteed.
  const found = req.foundChar;
  const char = readCharFull(found);
  char.portrait = portraitUrl;
  writeCharSplit(found.username, req.params.id, char);

  res.json({ portrait: portraitUrl });
});

// GET portrait — redirect to the static file
app.get('/api/characters/:id/portrait', requireAuth, validId, (req, res) => {
  const found = findCharFile(req.params.id);
  if (!found) return res.status(404).json({ error: 'Character not found' });

  const extensions = PORTRAIT_EXTENSIONS;
  for (const ext of extensions) {
    const p = portraitPath(found.username, req.params.id, ext);
    if (fs.existsSync(p)) {
      return res.redirect(`/portraits/${found.username}/${req.params.id}.portrait${ext}`);
    }
  }
  res.status(404).json({ error: 'No portrait' });
});

// DELETE portrait — removes the image file and clears the portrait field.
// Uses the same auth chain as the POST (requireCharOwner).
app.delete('/api/characters/:id/portrait', requireAuth, validId, requireCharOwner, (req, res) => {
  const found = req.foundChar;
  const owner = found.username;

  // Delete whichever extension variant exists on disk.
  const extensions = PORTRAIT_EXTENSIONS;
  extensions.forEach(ext => {
    const p = portraitPath(owner, req.params.id, ext);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  });

  // Clear the portrait field in the character envelope.
  const char = readCharFull(found);
  char.portrait = null;
  writeCharSplit(found.username, req.params.id, char);

  res.json({ portrait: null });
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

// Lore-asset uploads reuse the exact same policy as character attachments:
// buffer in memory, same allowlist, magic-sniff + hash in the handler.
const loreAssetUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: ATTACH_MAX_BYTES },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).slice(1).toLowerCase();
    cb(null, ATTACH_EXTS.has(ext));
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

// Update (overwrite) a text attachment — owner-or-admin.
// Only txt/md/csv are editable; binary files must be re-uploaded.
const ATTACH_EDITABLE_EXTS = new Set(['txt', 'md', 'csv']);

app.put('/api/characters/:id/attachments/:key',
  requireAuth, validId, requireAttachmentsOn, requireCharOwner,
  express.text({ type: 'text/*', limit: ATTACH_MAX_BYTES }),
  (req, res) => {
    const key = req.params.key;
    if (!/^[A-Za-z0-9]{1,40}$/.test(key)) return res.status(400).json({ error: 'Bad key' });

    const { username } = req.foundChar;
    const id   = req.params.id;
    const list = readManifest(username, id);
    const idx  = list.findIndex(a => a.key === key);
    if (idx === -1) return res.status(404).json({ error: 'No such attachment' });

    const entry = list[idx];
    if (!ATTACH_EDITABLE_EXTS.has(entry.ext)) {
      return res.status(415).json({ error: 'Only txt, md, and csv files can be edited in place' });
    }

    const text = typeof req.body === 'string' ? req.body : '';
    const buf  = Buffer.from(text, 'utf8');
    if (buf.length > ATTACH_MAX_BYTES) return res.status(413).json({ error: 'Content too large' });

    const total = list.reduce((n, a) => n + (a.size || 0), 0);
    if (total - (entry.size || 0) + buf.length > ATTACH_MAX_TOTAL_BYTES) {
      return res.status(413).json({ error: 'Storage limit for this character reached' });
    }

    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    fs.writeFileSync(attachBlobPath(username, id, key, entry.ext), buf);

    list[idx] = { ...entry, size: buf.length, sha256, editedAt: new Date().toISOString() };
    writeManifest(username, id, list);

    res.json({ attachment: list[idx], attachments: list });
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
        campaignId:     data.campaignId   || null,
        campaignName:   data.campaignName || null,
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

app.delete('/api/characters/:id', requireAuth, validId, requireCharOwner, (req, res) => {
  const found = req.foundChar;

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
app.get('/api/characters/:id/rolls', requireAuth, validId, requireCharOwner, (req, res) => {
  const found = req.foundChar;
  res.json(readRolls(found.username, req.params.id));
});

// POST /api/characters/:id/rolls   body: { dice, modifier, total, source?, segments? }
// Appends one roll entry. Fired automatically by DiceTray after every throw —
// see the "Roll log" comment above for why this bypasses the character
// envelope entirely instead of going through PUT /api/characters/:id.
//
// `segments` is optional: present only when the user typed a slash-separated
// multi-roll like "1d6x/1d6x", where each segment was rolled independently
// and has its own total. RollLog renders these side-by-side; the top-level
// `total` is still the grand total across all segments, kept for backward
// compatibility with single-roll consumers.
app.post('/api/characters/:id/rolls', requireAuth, validId, requireCharOwner, (req, res) => {
  const found = req.foundChar;

  const { dice, modifier, total, source, segments } = req.body || {};
  if (typeof dice !== 'object' || dice === null || typeof total !== 'number') {
    return res.status(400).json({ error: 'Invalid roll payload' });
  }

  // Validate segments if present: must be an array of objects shaped like
  // { notation:string, dice:object, modifier:number, total:number }.
  // Reject anything malformed rather than silently dropping fields — the
  // client builds this from the parser output, so a bad shape is a bug.
  let cleanSegments = null;
  if (segments !== undefined) {
    if (!Array.isArray(segments)) {
      return res.status(400).json({ error: 'segments must be an array' });
    }
    cleanSegments = [];
    for (const seg of segments) {
      if (!seg || typeof seg !== 'object'
        || typeof seg.notation !== 'string'
        || typeof seg.dice !== 'object' || seg.dice === null
        || typeof seg.total !== 'number') {
        return res.status(400).json({ error: 'Invalid segment shape' });
      }
      cleanSegments.push({
        notation: seg.notation,
        dice:     seg.dice,
        modifier: Number.isFinite(seg.modifier) ? seg.modifier : 0,
        total:    seg.total,
      });
    }
  }

  const entry = {
    id:       generateToken(8),
    rolledAt: new Date().toISOString(),
    dice,
    modifier: Number.isFinite(modifier) ? modifier : 0,
    total,
    source: typeof source === 'string' && source.trim() ? source.trim() : null,
    ...(cleanSegments ? { segments: cleanSegments } : {}),
  };

  res.json(appendRoll(found.username, req.params.id, entry));
});

// GET /api/characters/:id/macros — the dice-tray macro pages.
// Owner-or-admin, matching the roll log: macros are the owner's private
// shortcuts, not part of the sheet a campaign GM can view.
app.get('/api/characters/:id/macros', requireAuth, validId, requireCharOwner, (req, res) => {
  const found = req.foundChar;
  res.json(readMacros(found.username, req.params.id));
});

// PUT /api/characters/:id/macros   body: { pages: [ { macros: [...] } ] }
// Whole-document replace, not a per-macro CRUD surface. The payload is a
// handful of short strings, the editor already holds the entire tree in state,
// and reordering/adding/removing a page are all just "the tree changed" — so
// one atomic write is simpler than five endpoints and can't half-apply.
app.put('/api/characters/:id/macros', requireAuth, validId, requireCharOwner, (req, res) => {
  const found = req.foundChar;
  const pages = cleanMacroPages(req.body?.pages);
  if (!pages) return res.status(400).json({ error: 'pages must be an array' });
  fs.writeFileSync(macrosFilePath(found.username, req.params.id), JSON.stringify(pages, null, 2));
  res.json(pages);
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

  // Only the owning GM sees a campaign. Admin role does not grant visibility into
  // other GMs' campaigns — a plain player gets an empty list here by design.
  const visible = all.filter(c => c.ownedBy === username);
  res.json(visible);
});

app.post('/api/campaigns', requireAuth, requireGM, (req, res) => {
  const { name, sheetId, sheetName } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });

  // Optional world link (§4.7). resolveOwnedWorldId returns null for standalone,
  // the id for a world this GM owns, or undefined for anything invalid.
  const worldId = resolveOwnedWorldId(req.body?.worldId, req.session.user.username);
  if (worldId === undefined) return res.status(400).json({ error: 'Invalid world' });

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
    worldId,                              // app-owned: null or a world this GM owns
    joinCode,
    ownedBy:   req.session.user.username,
    createdAt: new Date().toISOString(),
  };

  campaigns.push(campaign);
  saveCampaigns(campaigns);
  res.json(campaign);
});

// PUT /api/campaigns/:id — edit a campaign's world link (and optionally its name).
// Owner-only. worldId is validated for same-GM ownership exactly like create, so a
// GM can link an existing campaign to a world, move it, or unlink it (null). The
// world's members ledger is NOT touched here — access persists at the user level.
app.put('/api/campaigns/:id', requireAuth, requireGM, validId, (req, res) => {
  const campaigns = getCampaigns();
  const campaign  = campaigns.find(c => c.id === req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Not found' });
  if (!req.session.user.admin && campaign.ownedBy !== req.session.user.username) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if ('worldId' in req.body) {
    const worldId = resolveOwnedWorldId(req.body.worldId, campaign.ownedBy);
    if (worldId === undefined) return res.status(400).json({ error: 'Invalid world' });
    campaign.worldId = worldId;
  }
  if (typeof req.body?.name === 'string' && req.body.name.trim()) {
    campaign.name = req.body.name.trim();
  }
  // The GM-authored prose (Wave A). Each key is picked EXPLICITLY — never spread
  // req.body, or a client could set ownedBy/joinCode/worldId through this route.
  // Absent key = leave alone; empty string = clear. Capped so a paste can't bloat
  // campaigns.json, which is read on every join-by-code lookup.
  for (const k of CAMPAIGN_TEXT_FIELDS) {
    if (typeof req.body?.[k] !== 'string') continue;
    campaign[k] = req.body[k].slice(0, k === 'threads' ? 16000 : 4000);
  }
  saveCampaigns(campaigns);
  res.json(campaign);
});

// GET /api/campaigns/:id/overview — the campaign surface. The FIRST campaign route
// a non-owner may call; every other campaign route stays owner-only.
//
// No requireGM: a plain player with a character here must reach it. Access is
// decided by resolveCampaignRole, and an unknown viewer gets 404 (not 403) so a
// stranger never learns the id exists. serializeCampaignForRole then strips the
// join code and fog for players — see loreAccess.js.
app.get('/api/campaigns/:id/overview', requireAuth, validId, (req, res) => {
  const campaign = getCampaigns().find(c => c.id === req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Not found' });

  const role = resolveCampaignRole(campaign, req.session.user.username);
  if (!role) return res.status(404).json({ error: 'Not found' });

  const roster = campaignRoster(campaign);
  // Session stats are role-scoped: a player counting sessions they cannot read
  // would learn how much unpublished material the GM is sitting on.
  const stats = sessionStatsForRole(readSessions(campaign.id), role);
  const out = serializeCampaignForRole(campaign, role, {
    characterCount: roster.length,
    roster,
    sessionCount: stats.sessionCount,
    lastPlayed:   stats.lastPlayed,
  });
  if (!out) return res.status(404).json({ error: 'Not found' });   // belt and braces
  res.json(out);
});


// ---------------------------------------------------------------------------
// Sessions (Wave B). Ordering is ALWAYS by number — see loreAccess.js.
// ---------------------------------------------------------------------------

// GET /api/campaigns/:id/sessions — the play log for whoever is asking.
// Role-based like the overview: a stranger gets 404, never 403. A player receives
// only SHARED records with prep absent by construction; hidden sessions are
// dropped from the list entirely rather than returned blank.
app.get('/api/campaigns/:id/sessions', requireAuth, validId, (req, res) => {
  const campaign = getCampaigns().find(c => c.id === req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Not found' });

  const role = resolveCampaignRole(campaign, req.session.user.username);
  if (!role) return res.status(404).json({ error: 'Not found' });

  res.json({
    role,
    sessions: serializeSessionsForRole(readSessions(campaign.id), role),
  });
});

// POST /api/campaigns/:id/sessions — start a session. Owner only.
// The number is assigned SERVER-SIDE as max+1 and is never taken from the body:
// it is the spine the whole log sorts on, so a client must not be able to collide
// two sessions on one number.
app.post('/api/campaigns/:id/sessions', requireAuth, requireGM, validId, (req, res) => {
  const campaign = getCampaigns().find(c => c.id === req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Not found' });
  if (!ownsCampaign(campaign, req.session.user)) return res.status(403).json({ error: 'Forbidden' });

  const sessions = readSessions(campaign.id);
  const nextNum  = sessions.reduce((n, s) => Math.max(n, Number.isInteger(s.number) ? s.number : 0), 0) + 1;

  const built = sessionFromBody(req.body, {
    id: crypto.randomUUID(),
    number: nextNum,
    createdAt: new Date().toISOString(),
  }, campaignCalendar(campaign));
  if (built.error) return res.status(400).json({ error: built.error });

  sessions.push(built.session);
  writeSessions(campaign.id, sessions);
  res.status(201).json(serializeSessionForRole(built.session, 'owner'));
});

// PUT /api/campaigns/:id/sessions/:sessionId — owner only.
// `validId` only guards req.params.id, so :sessionId is checked explicitly here.
app.put('/api/campaigns/:id/sessions/:sessionId', requireAuth, requireGM, validId, (req, res) => {
  if (!safeId(req.params.sessionId)) return res.status(400).json({ error: 'Invalid id' });
  const campaign = getCampaigns().find(c => c.id === req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Not found' });
  if (!ownsCampaign(campaign, req.session.user)) return res.status(403).json({ error: 'Forbidden' });

  const sessions = readSessions(campaign.id);
  const i = sessions.findIndex(s => s.id === req.params.sessionId);
  if (i < 0) return res.status(404).json({ error: 'Not found' });

  const built = sessionFromBody(req.body, sessions[i], campaignCalendar(campaign));
  if (built.error) return res.status(400).json({ error: built.error });

  // Renumbering is a deliberate, separate act: the body may set `number`, but it
  // must be a positive integer and it never happens implicitly on a content edit.
  if (Number.isInteger(req.body?.number) && req.body.number > 0) {
    built.session.number = req.body.number;
  }

  sessions[i] = built.session;
  writeSessions(campaign.id, sessions);
  res.json(serializeSessionForRole(built.session, 'owner'));
});

// DELETE /api/campaigns/:id/sessions/:sessionId — owner only.
// Numbers are NOT re-packed afterwards: session 4 stays session 4 in everyone's
// notes, and a gap in the log is honest about what happened.
app.delete('/api/campaigns/:id/sessions/:sessionId', requireAuth, requireGM, validId, (req, res) => {
  if (!safeId(req.params.sessionId)) return res.status(400).json({ error: 'Invalid id' });
  const campaign = getCampaigns().find(c => c.id === req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Not found' });
  if (!ownsCampaign(campaign, req.session.user)) return res.status(403).json({ error: 'Forbidden' });

  const sessions = readSessions(campaign.id);
  const next = sessions.filter(s => s.id !== req.params.sessionId);
  if (next.length === sessions.length) return res.status(404).json({ error: 'Not found' });
  writeSessions(campaign.id, next);
  removeSessionAssets(campaign.id, req.params.sessionId);
  res.json({ ok: true });
});

// Session attachments — GM upload/manage; a player may fetch a SHARED asset only
// on a session they can already see (canSeeSession). "Store inert, serve
// guarded" — see the block comment above readSessionAssets for the full model.

// GET the list for whoever is asking. Owner sees every asset with its
// visibility; a player sees only the shared ones, and only once the session
// itself is shared — an attachment cannot be more visible than its session.
app.get('/api/campaigns/:id/sessions/:sessionId/assets', requireAuth, validId, (req, res) => {
  if (!safeId(req.params.sessionId)) return res.status(400).json({ error: 'Invalid id' });
  const campaign = getCampaigns().find(c => c.id === req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Not found' });
  const role = resolveCampaignRole(campaign, req.session.user.username);
  if (!role) return res.status(404).json({ error: 'Not found' });

  const session = readSessions(campaign.id).find(s => s.id === req.params.sessionId);
  if (!session || !canSeeSession(session, role)) return res.status(404).json({ error: 'Not found' });

  const list = readSessionAssets(campaign.id, req.params.sessionId);
  const out = role === 'owner' ? list : list.filter(a => a.visibility === 'shared');
  res.json({ assets: out });
});

// POST upload — owner only. Body field `visibility` ('hidden'|'shared'; default
// hidden, matching the session record's own default-closed posture).
app.post('/api/campaigns/:id/sessions/:sessionId/assets',
  requireAuth, requireGM, validId, sessionAssetUpload.single('file'),
  (req, res) => {
    if (!safeId(req.params.sessionId)) return res.status(400).json({ error: 'Invalid id' });
    const campaign = getCampaigns().find(c => c.id === req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Not found' });
    if (!ownsCampaign(campaign, req.session.user)) return res.status(403).json({ error: 'Forbidden' });
    const session = readSessions(campaign.id).find(s => s.id === req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Not found' });
    if (!req.file) return res.status(400).json({ error: 'No file' });

    const ext = path.extname(req.file.originalname).slice(1).toLowerCase();
    if (!ATTACH_EXTS.has(ext))             return res.status(415).json({ error: 'File type not allowed' });
    if (!sniffMagic(ext, req.file.buffer)) return res.status(415).json({ error: "File contents don't match its type" });

    const list = readSessionAssets(campaign.id, req.params.sessionId);
    if (list.length >= SESSION_ASSET_MAX_PER_SESSION) {
      return res.status(413).json({ error: `Limit of ${SESSION_ASSET_MAX_PER_SESSION} files per session reached` });
    }
    const total = list.reduce((n, a) => n + (a.size || 0), 0);
    if (total + req.file.size > ATTACH_MAX_TOTAL_BYTES) {
      return res.status(413).json({ error: 'Storage limit for this session reached' });
    }

    const sha256 = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    let key;
    const used = new Set(list.map(a => a.key));
    do { key = generateToken(12); } while (used.has(key));

    fs.mkdirSync(CAMPAIGN_SIDECAR_DIR, { recursive: true });
    fs.writeFileSync(sessionAssetBlobPath(campaign.id, req.params.sessionId, key, ext), req.file.buffer);

    const asset = {
      key,
      name:       String(req.file.originalname).slice(0, 200),
      ext,
      mime:       ATTACH_MIME[ext],
      size:       req.file.size,
      sha256,
      isImage:    LORE_IMAGE_EXTS.has(ext),
      visibility: req.body?.visibility === 'shared' ? 'shared' : 'hidden',
      url:        `/api/campaigns/${campaign.id}/sessions/${req.params.sessionId}/assets/${key}`,
      uploadedAt: new Date().toISOString(),
      uploadedBy: req.session.user.username,
    };
    list.push(asset);
    writeSessionAssets(campaign.id, req.params.sessionId, list);
    res.json({ asset, assets: list });
  });

// PUT — owner only. The only mutable field is `visibility`; everything else
// about an already-uploaded file is immutable (re-upload to change the file).
app.put('/api/campaigns/:id/sessions/:sessionId/assets/:key', requireAuth, requireGM, validId, (req, res) => {
  if (!safeId(req.params.sessionId)) return res.status(400).json({ error: 'Invalid id' });
  const key = req.params.key;
  if (!/^[A-Za-z0-9]{1,40}$/.test(key)) return res.status(400).json({ error: 'Bad key' });
  const campaign = getCampaigns().find(c => c.id === req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Not found' });
  if (!ownsCampaign(campaign, req.session.user)) return res.status(403).json({ error: 'Forbidden' });
  if (!SESSION_VISIBILITY.includes(req.body?.visibility)) return res.status(400).json({ error: 'Invalid visibility' });

  const list  = readSessionAssets(campaign.id, req.params.sessionId);
  const asset = list.find(a => a.key === key);
  if (!asset) return res.status(404).json({ error: 'No such asset' });
  asset.visibility = req.body.visibility;
  writeSessionAssets(campaign.id, req.params.sessionId, list);
  res.json({ asset, assets: list });
});

// GET one (download/inline). Re-checks BOTH the asset's own visibility and the
// owning session's — a shared asset on a hidden session must not leak.
app.get('/api/campaigns/:id/sessions/:sessionId/assets/:key', requireAuth, validId, (req, res) => {
  if (!safeId(req.params.sessionId)) return res.status(400).json({ error: 'Invalid id' });
  const key = req.params.key;
  if (!/^[A-Za-z0-9]{1,40}$/.test(key)) return res.status(400).json({ error: 'Bad key' });
  const campaign = getCampaigns().find(c => c.id === req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Not found' });
  const role = resolveCampaignRole(campaign, req.session.user.username);
  if (!role) return res.status(404).json({ error: 'Not found' });

  const session = readSessions(campaign.id).find(s => s.id === req.params.sessionId);
  if (!session || !canSeeSession(session, role)) return res.status(404).json({ error: 'Not found' });

  const asset = readSessionAssets(campaign.id, req.params.sessionId).find(a => a.key === key);
  if (!asset) return res.status(404).json({ error: 'No such asset' });
  if (role !== 'owner' && asset.visibility !== 'shared') return res.status(404).json({ error: 'Not found' });

  const p = sessionAssetBlobPath(campaign.id, req.params.sessionId, asset.key, asset.ext);
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'File missing' });

  const disposition = ATTACH_INLINE.has(asset.ext) ? 'inline' : 'attachment';
  res.setHeader('Content-Type', ATTACH_MIME[asset.ext] || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `${disposition}; ${dispositionFilename(asset.name)}`);
  res.setHeader('Content-Length', asset.size);
  const stream = fs.createReadStream(p);
  stream.on('error', () => { if (!res.headersSent) res.status(500).end(); else res.destroy(); });
  stream.pipe(res);
});

// DELETE — owner only.
app.delete('/api/campaigns/:id/sessions/:sessionId/assets/:key', requireAuth, requireGM, validId, (req, res) => {
  if (!safeId(req.params.sessionId)) return res.status(400).json({ error: 'Invalid id' });
  const key = req.params.key;
  if (!/^[A-Za-z0-9]{1,40}$/.test(key)) return res.status(400).json({ error: 'Bad key' });
  const campaign = getCampaigns().find(c => c.id === req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Not found' });
  if (!ownsCampaign(campaign, req.session.user)) return res.status(403).json({ error: 'Forbidden' });

  const list  = readSessionAssets(campaign.id, req.params.sessionId);
  const asset = list.find(a => a.key === key);
  if (!asset) return res.status(404).json({ error: 'No such asset' });

  const p = sessionAssetBlobPath(campaign.id, req.params.sessionId, asset.key, asset.ext);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  const next = list.filter(a => a.key !== key);
  writeSessionAssets(campaign.id, req.params.sessionId, next);
  res.json({ ok: true, assets: next });
});

app.delete('/api/campaigns/:id', requireAuth, requireGM, validId, (req, res) => {
  const campaigns = getCampaigns();
  const campaign  = campaigns.find(c => c.id === req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Not found' });
  if (!req.session.user.admin && campaign.ownedBy !== req.session.user.username) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  for (const s of readSessions(campaign.id)) removeSessionAssets(campaign.id, s.id);
  saveCampaigns(campaigns.filter(c => c.id !== req.params.id));
  res.json({ ok: true });
});

// POST /api/campaigns/:id/status   body: { status: "active" | "archived" }
app.post('/api/campaigns/:id/status', requireAuth, requireGM, validId, (req, res) => {
  const status = req.body?.status;
  if (!CAMPAIGN_STATUSES.includes(status)) {
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

// ===========================================================================
// Keep — World CRUD (Steps 1-2 backend) + Lore CRUD + version history
//
// All routes: requireAuth → requireGM → validId (on :id) → requireWorldOwner.
// The client body never sets app-owned fields (id, worldId, categoryId,
// createdBy, ownedBy, timestamps) — those are read from disk / server-generated.
// ===========================================================================

// ---------------------------------------------------------------------------
// World share links — READ-ONLY, unauthenticated
//
// Same shape and same security guidelines as a character share link: an
// unguessable 32-byte token, an expiry, revocable by the owner, and the payload
// stripped of anything that would let the holder escalate.
//
// ONE difference, and it is deliberate: there is NO 'edit' permission. A
// character share link can be editable because it grants one person write access
// to their own sheet; a world holds every other player's secrets, so an external
// link is read-only, full stop. The create route takes no permission argument —
// the absence of the parameter is the enforcement, so no future body key can
// quietly turn one on.
//
// HOW IT WORKS: rather than a parallel set of handlers (which would drift from
// the real ones and re-implement canSee/fog stripping — the exact duplication
// §4.8 avoided), the gate below REWRITES the URL onto the ordinary world routes
// and marks the request. `requireAuth` then passes it through and
// `requireWorldRead` pins it to the 'read' tier, so the response is byte-for-byte
// what the most restricted logged-in member would get: hidden/over-tier entries
// absent, ||fog|| stripped, assets gated on their owning entry.
//
// FOUR gates, all before the rewrite:
//   1. GET only — no method can mutate through this prefix.
//   2. The path must match the READ allowlist below. This is why it's an
//      allowlist and not "any GET": /campaigns and /lore/:id/proposals are also
//      requireWorldRead routes, and a campaign row carries its join code.
//   3. The token must resolve to a world.
//   4. The link must not have expired.
// ---------------------------------------------------------------------------

// The only paths a share link may read. Anything not listed 404s — including
// routes a `read` MEMBER can reach (campaigns, proposals), because a member is a
// known person in the ledger and a link holder is anonymous.
const WORLD_SHARE_PATHS = [
  /^$/,                                                        // the world record
  /^\/categories$/,
  /^\/calendar$/,
  /^\/system$/,
  /^\/lore$/,
  /^\/lore\/[a-z0-9-]{1,80}$/i,
  /^\/lore\/[a-z0-9-]{1,80}\/assets\/[A-Za-z0-9]{1,40}$/,      // inline images
  /^\/assets\/[A-Za-z0-9]{1,40}$/,                             // landing images
  /^\/sysref$/,
  /^\/sysref\/[a-z0-9-]{1,80}$/i,
];

function findWorldByToken(token) {
  for (const w of getWorlds()) {
    const share = (w.shares || []).find(s => s && s.token === token);
    if (share) return { world: w, share };
  }
  return null;
}

app.use((req, res, next) => {
  const qIdx     = req.url.indexOf('?');
  const pathOnly = qIdx === -1 ? req.url : req.url.slice(0, qIdx);
  const qs       = qIdx === -1 ? '' : req.url.slice(qIdx);
  const m = /^\/api\/share\/world\/([A-Za-z0-9_-]{16,128})(\/.*)?$/.exec(pathOnly);
  if (!m) return next();

  if (req.method !== 'GET') return res.status(403).json({ error: 'This link is read-only' });

  const rest = (m[2] || '').replace(/\/+$/, '');
  if (!WORLD_SHARE_PATHS.some(re => re.test(rest))) {
    return res.status(404).json({ error: 'Not found' });
  }

  const found = findWorldByToken(m[1]);
  if (!found) return res.status(404).json({ error: 'Link not found' });
  if (new Date() > new Date(found.share.expiresAt)) {
    return res.status(410).json({ error: 'Link expired' });
  }

  // Log the OPENING of a world, not every fetch behind it — one page view pulls
  // categories, lore, the calendar and every image, and a log of that is noise.
  if (rest === '') {
    appendLog('shareAccesses', {
      sharedBy:  found.world.ownedBy,
      character: `World: ${found.world.name || found.world.id}`,
      at:        new Date().toISOString(),
      ip:        normalizeIp(req.ip),
    });
  }

  req.isWorldShare = true;
  req.shareWorld   = found.world;
  // Internal rewrite onto the real route. `found.world.id` came out of our own
  // storage and already passes safeId, so it can't inject a path segment.
  req.url = `/api/worlds/${found.world.id}${rest}${qs}`;
  next();
});

// Owner-only management of a world's share links. `shares` is APP-OWNED: written
// only here, never through the generic world PUT.
app.get('/api/worlds/:id/shares', requireAuth, requireGM, validId, requireWorldOwner, (req, res) => {
  const now = new Date();
  res.json((req.world.shares || []).filter(s => new Date(s.expiresAt) > now));
});

app.post('/api/worlds/:id/shares', requireAuth, requireGM, validId, requireWorldOwner, (req, res) => {
  // Note the absence of a `permission` read: a world link is read-only by
  // construction, not by validating a value the client sent.
  const days = Math.min(Math.max(parseInt(req.body?.expiresInDays, 10) || 3, 1), 90);
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + days);

  const share = {
    token:      generateToken(32),
    permission: 'view',
    expiresAt:  expiresAt.toISOString(),
    createdAt:  new Date().toISOString(),
  };
  const worlds = getWorlds();
  const world  = worlds.find(w => w.id === req.params.id);
  if (!Array.isArray(world.shares)) world.shares = [];
  world.shares.push(share);
  saveWorlds(worlds);
  res.json(share);
});

app.delete('/api/worlds/:id/shares/:token', requireAuth, requireGM, validId, requireWorldOwner, (req, res) => {
  const worlds = getWorlds();
  const world  = worlds.find(w => w.id === req.params.id);
  world.shares = (world.shares || []).filter(s => s.token !== req.params.token);
  saveWorlds(worlds);
  res.json({ ok: true });
});

// GET /api/worlds — every world the requester can see, each tagged with the
// viewer's `role`: worlds they OWN (role 'owner', full record) plus, since §4.8,
// worlds where they're a ledger MEMBER (role = their tier, `members` stripped).
// No requireGM: a plain player who's a member must get their member worlds here.
app.get('/api/worlds', requireAuth, (req, res) => {
  const username = req.session.user.username;
  const out = [];
  for (const w of getWorlds()) {
    if (w.ownedBy === username) { out.push({ ...w, role: 'owner' }); continue; }
    const role = worldRoleFor(w, username);
    if (role) out.push(memberWorldView(w, role));
  }
  res.json(out);
});

// GET /api/worlds/:id — one world + the viewer's role (owner or member tier).
// Members get the ledger stripped; the landing lives on the record, so this is
// how a member receives it. 404 (via requireWorldRead) for anyone with no access.
app.get('/api/worlds/:id', requireAuth, validId, requireWorldRead, (req, res) => {
  res.json(req.worldRole === 'owner'
    ? { ...req.world, role: 'owner' }
    : memberWorldView(req.world, req.worldRole));
});

// POST /api/worlds — create. Server owns id, ownedBy, createdAt, packId, status.
app.post('/api/worlds', requireAuth, requireGM, (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name) return res.status(400).json({ error: 'Name required' });
  const worlds = getWorlds();
  const world = {
    id:          newRecordId(name),
    name:        name.slice(0, 120),
    description: typeof req.body?.description === 'string' ? req.body.description.slice(0, 2000) : '',
    packId:      'default',
    status:      'active',
    ownedBy:     req.session.user.username,
    createdAt:   new Date().toISOString(),
  };
  worlds.push(world);
  saveWorlds(worlds);
  res.json(world);
});

// PUT /api/worlds/:id — update name/description only. App-owned fields are
// re-read from disk (req.world) and never taken from the body.
app.put('/api/worlds/:id', requireAuth, requireGM, validId, requireWorldOwner, (req, res) => {
  const worlds = getWorlds();
  const world  = worlds.find(w => w.id === req.params.id);
  if (typeof req.body?.name === 'string' && req.body.name.trim()) {
    world.name = req.body.name.trim().slice(0, 120);
  }
  if (typeof req.body?.description === 'string') {
    world.description = req.body.description.slice(0, 2000);
  }
  saveWorlds(worlds);
  res.json(world);
});

// DELETE /api/worlds/:id — remove the world record and its lore tree.
app.delete('/api/worlds/:id', requireAuth, requireGM, validId, requireWorldOwner, (req, res) => {
  const worlds = getWorlds();
  saveWorlds(worlds.filter(w => w.id !== req.params.id));
  // Best-effort cleanup of the world's lore directory (entries + history).
  const dir = loreDir(req.params.id);
  if (fs.existsSync(dir)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); }
    catch (e) { console.error(`[lore] Failed to remove ${dir}: ${e.message}`); }
  }
  // …and its backdrop asset (whichever extension variant exists).
  PORTRAIT_EXTENSIONS.forEach(ext => {
    const p = worldBackdropPath(req.params.id, ext);
    if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch { /* best-effort */ } }
  });
  // …and its system-reference tree (Wave C), which lives outside LORE_DIR.
  const sdir = sysrefDir(req.params.id);
  if (fs.existsSync(sdir)) {
    try { fs.rmSync(sdir, { recursive: true, force: true }); }
    catch (e) { console.error(`[sysref] Failed to remove ${sdir}: ${e.message}`); }
  }
  // …and its world-level asset store (landing-page images + attachments).
  removeWorldAssets(req.params.id);
  res.json({ ok: true });
});

// POST /api/worlds/:id/status — active | archived.
app.post('/api/worlds/:id/status', requireAuth, requireGM, validId, requireWorldOwner, (req, res) => {
  const status = req.body?.status;
  if (!['active', 'archived'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  const worlds = getWorlds();
  const world  = worlds.find(w => w.id === req.params.id);
  world.status = status;
  saveWorlds(worlds);
  res.json({ id: world.id, status });
});

// ---- World access ledger — GM management (§4.7) ----------------------------
// All owner-only (requireWorldOwner); :userId/:campaignId/:charId validated
// in-handler. The ledger (world.members) is app-owned — written ONLY here and by
// the join hook, never by the generic PUT /api/worlds/:id.

// GET /api/worlds/:id/members — the ledger enriched for display: each member user
// + tier + grant metadata + which of THEIR characters currently sit in this
// world's campaigns (derived by scanning that user's characters for a campaignId
// in the world's campaign set). No player data leaks — owner-only route.
app.get('/api/worlds/:id/members', requireAuth, requireGM, validId, requireWorldOwner, (req, res) => {
  const members  = (req.world.members && typeof req.world.members === 'object') ? req.world.members : {};
  const worldCamps = campaignsOfWorld(req.params.id);
  const keys       = campaignKeySet(worldCamps);
  const campName   = new Map(worldCamps.map(c => [c.id, c.name]));

  const out = Object.entries(members).map(([userId, entry]) => {
    const characters = userCharacterFiles(userId)
      .map(({ id, filePath }) => ({ id, char: readCharFull({ filePath, username: userId }) }))
      .filter(({ char }) => matchesCampaign(char.campaignId, keys))
      .map(({ id, char }) => ({
        id,
        name:         char.info?.name || 'Unnamed',
        campaignId:   char.campaignId,
        campaignName: char.campaignName || campName.get(char.campaignId) || null,
      }));
    return {
      userId,
      tier:       entry?.tier || 'read',
      grantedAt:  entry?.grantedAt || null,
      grantedVia: entry?.grantedVia || null,
      characters,
    };
  }).sort((a, b) => a.userId.localeCompare(b.userId));

  res.json(out);
});

// GET /api/worlds/:id/campaigns — the campaigns attached to this world (§4.10),
// i.e. campaigns whose worldId === this world (the §4.7 link), enriched for a
// read-only display: name, join code, owner, and how many characters / distinct
// members currently sit in each. Owner-only — no player data leaks. We derive the
// counts with a SINGLE character scan (findAllCharFiles), tallying by the
// campaign key (id OR join code) the character is tagged with, mirroring the
// members route's matching discipline.
app.get('/api/worlds/:id/campaigns', requireAuth, validId, requireWorldRead, (req, res) => {
  // Wave A widened this from owner-only to any world MEMBER, because the rail
  // needs a campaign list a player can fetch. requireWorldRead (not requireGM):
  // a plain player who is a ledger member must reach it, and a stranger 404s.
  //
  // What a non-owner gets is narrowed twice, below:
  //   • only campaigns they actually belong to (a character tagged with it) —
  //     world membership does NOT imply campaign membership;
  //   • no joinCode, no memberCount. The code is a bearer credential (anyone
  //     holding it can attach a character) and the head-count is GM bookkeeping.
  // The owner's payload is unchanged, so WorldSettingsModal keeps working as-is.
  const viewerIsOwner = req.worldRole === 'owner';
  const viewer        = req.session.user.username;
  const worldCamps    = campaignsOfWorld(req.params.id);
  // key (id or UPPER join code) -> campaignId, so a character tagged with either resolves.
  const keyToId = new Map();
  for (const c of worldCamps) {
    if (c.id)       keyToId.set(c.id, c.id);
    if (c.joinCode) keyToId.set(String(c.joinCode).toUpperCase(), c.id);
  }
  const charCount = new Map();
  const memberSet = new Map();
  for (const c of worldCamps) { charCount.set(c.id, 0); memberSet.set(c.id, new Set()); }

  for (const filePath of findAllCharFiles()) {
    let char;
    try { char = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }
    const stored = char.campaignId;
    if (!stored) continue;
    const v = String(stored).trim();
    const cid = keyToId.get(v) || keyToId.get(v.toUpperCase());
    if (!cid) continue;
    charCount.set(cid, (charCount.get(cid) || 0) + 1);
    const owner = path.relative(CHARS_DIR, filePath).split(path.sep)[0];   // dir = username
    memberSet.get(cid).add(owner);
  }

  const out = worldCamps
    // A non-owner sees only campaigns they hold a character in. memberSet was
    // built by the scan above, so this costs nothing extra.
    .filter(c => viewerIsOwner || (memberSet.get(c.id) || new Set()).has(viewer))
    .map(c => {
      const row = {
        id:             c.id,
        name:           c.name,
        ownedBy:        c.ownedBy,
        status:         c.status || 'active',
        characterCount: charCount.get(c.id) || 0,
      };
      if (viewerIsOwner) {
        row.joinCode    = c.joinCode;
        row.memberCount = (memberSet.get(c.id) || new Set()).size;
      }
      return row;
    })
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  res.json({ campaigns: out });
});

// PUT /api/worlds/:id/members/:userId — set an existing member's tier. Validates
// the tier and the username shape; the world owner is never a ledger member.
app.put('/api/worlds/:id/members/:userId', requireAuth, requireGM, validId, requireWorldOwner, (req, res) => {
  const userId = req.params.userId;
  if (validateUsername(userId)) return res.status(400).json({ error: 'Invalid user' });
  if (userId === req.world.ownedBy) return res.status(400).json({ error: 'The world owner is not a member' });
  const tier = req.body?.tier;
  if (!MEMBER_TIERS.includes(tier)) return res.status(400).json({ error: 'Invalid tier' });

  const worlds = getWorlds();
  const world  = worlds.find(w => w.id === req.params.id);
  if (!world.members || !world.members[userId]) return res.status(404).json({ error: 'Not a member' });
  world.members[userId].tier = tier;   // keep grantedAt/grantedVia
  saveWorlds(worlds);
  res.json({ userId, tier });
});

// DELETE /api/worlds/:id/members/:userId — REVOKE + CASCADE. Remove the ledger
// entry AND clear the campaign envelope on that user's characters whose campaign
// belongs to this world (read-from-disk, per character). "Removed from the world
// ⇒ removed from its campaigns." Only the target user's characters are touched.
app.delete('/api/worlds/:id/members/:userId', requireAuth, requireGM, validId, requireWorldOwner, (req, res) => {
  const userId = req.params.userId;
  if (validateUsername(userId)) return res.status(400).json({ error: 'Invalid user' });
  // The owner is never a ledger member, so revoking them is a no-op on the ledger —
  // but the CASCADE below would still run and strip the campaign envelope off the
  // owner's own characters in their own world. Guard the row, as the PUT above does.
  if (userId === req.world.ownedBy) return res.status(400).json({ error: 'The world owner is not a member' });

  const worlds = getWorlds();
  const world  = worlds.find(w => w.id === req.params.id);
  const existed = !!(world.members && world.members[userId]);
  if (world.members) delete world.members[userId];
  saveWorlds(worlds);

  // Cascade the user's characters out of this world's campaigns.
  const cleared = clearCampaignForUserChars(userId, campaignKeySet(campaignsOfWorld(req.params.id)));

  res.json({ ok: true, revoked: existed, charactersCleared: cleared });
});

// DELETE /api/worlds/:id/campaigns/:campaignId/characters/:charId — GM
// campaign-kick: clear the campaign envelope on ONE character. Does NOT touch the
// ledger — "kicked from a campaign keeps world access." Scoped to a campaign that
// belongs to THIS world (and thus this owner), so a GM can only kick within their
// own world's campaigns.
app.delete('/api/worlds/:id/campaigns/:campaignId/characters/:charId', requireAuth, requireGM, validId, requireWorldOwner, (req, res) => {
  const { campaignId, charId } = req.params;
  if (!safeId(charId)) return res.status(400).json({ error: 'Invalid character id' });

  const camp = campaignsOfWorld(req.params.id).find(c => c.id === campaignId);
  if (!camp) return res.status(404).json({ error: 'No such campaign in this world' });

  const found = findCharFile(charId);
  if (!found) return res.status(404).json({ error: 'Character not found' });
  const char = readCharFull(found);
  if (!matchesCampaign(char.campaignId, campaignKeySet([camp]))) {
    return res.status(400).json({ error: 'Character is not in that campaign' });
  }
  char.campaignId   = null;
  char.campaignCode = null;
  char.campaignName = null;
  char.updatedAt    = new Date().toISOString();
  writeCharSplit(found.username, charId, char);

  res.json({ ok: true, charId });
});

// POST /api/worlds/:id/backdrop — upload the world's backdrop image. Owner-only.
// The image is one app-owned asset per world; the world record's `backdrop` field
// is written here (server-owned), never taken from a generic body spread.
app.post('/api/worlds/:id/backdrop', requireAuth, requireGM, validId, requireWorldOwner, worldBackdropUpload.single('backdrop'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });

  // Magic-byte verify the written file — same guarantee as the portrait and
  // attachment uploads: a renamed non-image is deleted and rejected.
  const ext = path.extname(req.file.filename).slice(1).toLowerCase();
  if (!verifyImageFile(req.file.path, ext)) {
    try { fs.unlinkSync(req.file.path); } catch { /* best effort */ }
    return res.status(415).json({ error: "File contents don't match its type" });
  }

  const url = `/world-backdrops/${req.file.filename}`;
  // Remove older-extension variants so a png→jpg swap doesn't leave a stale file.
  PORTRAIT_EXTENSIONS.forEach(ext => {
    const old = worldBackdropPath(req.params.id, ext);
    if (fs.existsSync(old) && old !== req.file.path) fs.unlinkSync(old);
  });
  const worlds = getWorlds();
  const world  = worlds.find(w => w.id === req.params.id);
  world.backdrop = url;
  saveWorlds(worlds);
  res.json({ backdrop: url });
});

// DELETE /api/worlds/:id/backdrop — remove the image file and clear the field.
app.delete('/api/worlds/:id/backdrop', requireAuth, requireGM, validId, requireWorldOwner, (req, res) => {
  PORTRAIT_EXTENSIONS.forEach(ext => {
    const p = worldBackdropPath(req.params.id, ext);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  });
  const worlds = getWorlds();
  const world  = worlds.find(w => w.id === req.params.id);
  if (world) world.backdrop = null;
  saveWorlds(worlds);
  res.json({ backdrop: null });
});

// GET /api/worlds/:id/categories — the world's pack's lore categories. Loader
// is defensive: broken/missing pack falls back to the default set (see packs.js).
// §4.8: readable by members. The owner gets ALL merged categories (hidden ones
// flagged, needed for the rail + customize); a member gets only the non-hidden
// ones — the server never even names a hidden category to a player.
app.get('/api/worlds/:id/categories', requireAuth, validId, requireWorldRead, (req, res) => {
  const merged = packs.applyCategoryConfig(packs.loadCategories(DATA_DIR, req.world.packId), req.world.categoryConfig);
  res.json(req.worldRole === 'owner' ? merged : merged.filter(c => !c.hidden));
});

// PUT /api/worlds/:id/categories/config   body: { config: { <catId>: { label?, hidden? } } }
//
// The world's per-world category rename/hide overrides (§4j). Owner-only: this is
// STRUCTURAL — it reshapes the rail for everyone in the world — and structural
// powers stay with the owner, like the pack and the calendar.
//
// `categoryConfig` is APP-OWNED: written ONLY here, never through the generic
// PUT /api/worlds/:id, so a stray body spread can't reach it.
//
// The config is validated against the world's UN-MERGED pack categories, not the
// merged view: cleanCategoryConfig drops a label equal to the base as a no-op, and
// handing it already-merged labels would make every existing rename look like a
// no-op and silently erase it.
//
// The stored value REPLACES the old one rather than merging into it. That is what
// makes un-hiding work: turning a category back on removes its override entirely
// (`hidden: false` is the default and is not stored), and a merge would keep the
// stale `{ hidden: true }` key forever — the category could be hidden but never
// shown again. An empty result deletes the key, so "no overrides" is absent
// rather than `{}`.
app.put('/api/worlds/:id/categories/config', requireAuth, requireGM, validId, requireWorldOwner, (req, res) => {
  const base   = packs.loadCategories(DATA_DIR, req.world.packId);
  const clean  = packs.cleanCategoryConfig(req.body && req.body.config, base);

  const worlds = getWorlds();
  const world  = worlds.find(w => w.id === req.params.id);
  if (Object.keys(clean).length) world.categoryConfig = clean;
  else delete world.categoryConfig;
  saveWorlds(worlds);

  // Return the merged list the client adopts directly (it replaces its category
  // state with this), so a save and a fresh GET can never disagree.
  res.json(packs.applyCategoryConfig(base, clean));
});

// GET /api/worlds/:id/calendar — the world's RESOLVED calendar: its own if the GM
// authored one, else its pack's template, else null. Member-readable
// (requireWorldRead) so any tier can render/format in-world dates on the reader +
// timeline. A calendar is setting structure, not player data — safe for every
// member, and every member needs it to read a date at all.
app.get('/api/worlds/:id/calendar', requireAuth, validId, requireWorldRead, (req, res) => {
  res.json({
    calendar: resolveWorldCalendar(req.world),
    hidden:   req.world.calendarHidden === true,
    source:   calendarSourceOf(req.world),
  });
});

// PUT /api/worlds/:id/calendar — the GM authors the world's own calendar.
// body: { calendar: {...} }  |  { calendar: null } to clear.
//
// `calendar` is APP-OWNED: written ONLY here, never through the generic
// PUT /api/worlds/:id, so a stray body spread can't reach it. We re-read the
// record from disk and set just this one field, mirroring the landing/backdrop/
// categoryConfig handlers.
//
// The body goes through the SAME packs.cleanCalendar the pack loader uses — one
// validator for both authoring paths, so GM input can never be accepted in a
// shape a pack file couldn't be. Clearing falls back to the pack's calendar,
// which is why it DELETES the key instead of storing null: absent means "use the
// template", and a stored null would be indistinguishable from a broken one.
//
// Owner-only (requireWorldOwner, not requireWorldWrite): the calendar is
// structural — re-dating the spine moves every event on the timeline at once —
// and structural powers stay with the owner, like the pack and category config.
app.put('/api/worlds/:id/calendar', requireAuth, requireGM, validId, requireWorldOwner, (req, res) => {
  const b = req.body || {};
  const worlds = getWorlds();
  const world  = worlds.find(w => w.id === req.params.id);
  if (!world) return res.status(404).json({ error: 'Not found' });

  // Each key is picked EXPLICITLY — never spread req.body onto a world record, or
  // a client could set ownedBy/packId/members through this route.
  if ('calendar' in b) {
    if (b.calendar == null) {
      // Clearing DELETES the key rather than storing null: absent means "use the
      // template", and a stored null would be indistinguishable from a broken one.
      delete world.calendar;
    } else {
      const cleaned = packs.cleanCalendar(b.calendar, `world '${req.params.id}'`);
      if (!cleaned) {
        return res.status(400).json({ error: 'A calendar needs at least one month with a positive number of days' });
      }
      // The SAME rules the editor enforces (calendarMath.calendarIssues), so a
      // client that skips its own checks can't store a calendar the editor would
      // have refused. Warnings are deliberately NOT blocking — a week that doesn't
      // divide the year is the normal case, not a fault.
      const issues = calendarMath.calendarIssues(cleaned);
      if (issues.errors.length) {
        return res.status(400).json({ error: issues.errors[0].message, errors: issues.errors });
      }
      world.calendar = cleaned;
    }
  }

  if ('source' in b) {
    if (b.source === 'builtin')   world.calendarSource = 'builtin';
    else if (b.source === 'pack') delete world.calendarSource;   // pack is the default
    else return res.status(400).json({ error: 'Unknown calendar source' });
  }

  // Display-only, like a hidden category: the calendar still resolves server-side
  // so stored dates keep validating and never get wiped.
  if ('hidden' in b) {
    if (b.hidden === true) world.calendarHidden = true;
    else delete world.calendarHidden;
  }

  saveWorlds(worlds);
  res.json({
    calendar: resolveWorldCalendar(world),
    hidden:   world.calendarHidden === true,
    source:   calendarSourceOf(world),
  });
});

// ---- World landing page (§4k) -----------------------------------------------

// PUT /api/worlds/:id/landing — set the world's landing Markdown. `landing` is
// APP-OWNED: written only here, never via the generic PUT /api/worlds/:id, so a
// stray body spread can't touch it. We re-read the record from disk and set just
// this one field, mirroring the backdrop/status handlers.
app.put('/api/worlds/:id/landing', requireAuth, requireGM, validId, requireWorldOwner, (req, res) => {
  const landing = typeof req.body?.landing === 'string' ? req.body.landing.slice(0, LANDING_MAX) : '';
  const worlds  = getWorlds();
  const world   = worlds.find(w => w.id === req.params.id);
  world.landing = landing;
  saveWorlds(worlds);
  res.json(world);
});

// ---- World-level asset store (§4k) ------------------------------------------
// The §4g lore-asset routes, keyed by worldId ALONE (no entry-existence check —
// requireWorldOwner is the gate). Same allowlist / magic-sniff / server-token /
// pinned-Content-Type + nosniff posture. App-origin only.

// GET list — §4.8: member-readable (world/landing images are shown to members).
app.get('/api/worlds/:id/assets', requireAuth, validId, requireWorldRead, (req, res) => {
  res.json({ assets: readWorldAssets(req.params.id) });
});

// POST upload
app.post('/api/worlds/:id/assets',
  requireAuth, requireGM, validId, requireWorldOwner, loreAssetUpload.single('file'),
  (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const worldId = req.params.id;
    const ext = path.extname(req.file.originalname).slice(1).toLowerCase();
    if (!ATTACH_EXTS.has(ext))             return res.status(415).json({ error: 'File type not allowed' });
    if (!sniffMagic(ext, req.file.buffer)) return res.status(415).json({ error: "File contents don't match its type" });

    const list = readWorldAssets(worldId);
    if (list.length >= WORLD_ASSET_MAX) {
      return res.status(413).json({ error: `Limit of ${WORLD_ASSET_MAX} files per world reached` });
    }
    const total = list.reduce((n, a) => n + (a.size || 0), 0);
    if (total + req.file.size > ATTACH_MAX_TOTAL_BYTES) {
      return res.status(413).json({ error: 'Storage limit for this world reached' });
    }

    const sha256 = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    let key;
    const used = new Set(list.map(a => a.key));
    do { key = generateToken(12); } while (used.has(key));

    fs.mkdirSync(worldAssetsDir(worldId), { recursive: true });
    fs.writeFileSync(worldAssetBlobPath(worldId, key, ext), req.file.buffer);

    const asset = {
      key,
      name:       String(req.file.originalname).slice(0, 200),
      ext,
      mime:       ATTACH_MIME[ext],
      size:       req.file.size,
      sha256,
      isImage:    LORE_IMAGE_EXTS.has(ext),
      url:        `/api/worlds/${worldId}/assets/${key}`,
      uploadedAt: new Date().toISOString(),
      uploadedBy: req.session.user.username,
    };
    list.push(asset);
    writeWorldAssets(worldId, list);
    res.json({ asset, assets: list });
  });

// GET one (download / inline view). Content-Type PINNED from our map, nosniff
// always set, only known-safe types served inline; the rest download.
// §4.8: member-readable (any world member may fetch a world/landing image).
app.get('/api/worlds/:id/assets/:key', requireAuth, validId, requireWorldRead, (req, res) => {
  const key = req.params.key;
  if (!/^[A-Za-z0-9]{1,40}$/.test(key)) return res.status(400).json({ error: 'Bad key' });

  const asset = readWorldAssets(req.params.id).find(a => a.key === key);
  if (!asset) return res.status(404).json({ error: 'No such asset' });

  const p = worldAssetBlobPath(req.params.id, asset.key, asset.ext);
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'File missing' });

  const disposition = ATTACH_INLINE.has(asset.ext) ? 'inline' : 'attachment';
  res.setHeader('Content-Type', ATTACH_MIME[asset.ext] || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `${disposition}; ${dispositionFilename(asset.name)}`);
  res.setHeader('Content-Length', asset.size);
  const stream = fs.createReadStream(p);
  stream.on('error', () => { if (!res.headersSent) res.status(500).end(); else res.destroy(); });
  stream.pipe(res);
});

// DELETE one — owner-only. Removes blob + manifest entry. (A landing body that
// still references a deleted image renders a broken <img>, same honest behaviour
// as a dangling [[wiki]] link — we don't rewrite the author's text.)
app.delete('/api/worlds/:id/assets/:key', requireAuth, requireGM, validId, requireWorldOwner, (req, res) => {
  const key = req.params.key;
  if (!/^[A-Za-z0-9]{1,40}$/.test(key)) return res.status(400).json({ error: 'Bad key' });

  const list  = readWorldAssets(req.params.id);
  const asset = list.find(a => a.key === key);
  if (!asset) return res.status(404).json({ error: 'No such asset' });

  const p = worldAssetBlobPath(req.params.id, asset.key, asset.ext);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  const next = list.filter(a => a.key !== key);
  writeWorldAssets(req.params.id, next);
  res.json({ ok: true, assets: next });
});

// Validate + normalize an entry's field values before store (§4.11). Only
// calendar-date fields need work: each must be a valid { era, year, month, day }
// (or null) for the world's calendar. Non-date fields pass through untouched.
// Returns { fields } on success or { error } on an invalid date. If the pack has
// NO calendar, a declared date field degrades to null (dropped + logged) rather
// than erroring — the entry form must keep working with no calendar.
function sanitizeEntryFields(fields, categoryDef, calendar) {
  const src = fields && typeof fields === 'object' && !Array.isArray(fields) ? fields : {};
  if (!categoryDef) return { fields: src };
  const out = { ...src };
  for (const f of categoryDef.fields || []) {
    if (f.type !== 'calendar-date' || !(f.key in out)) continue;
    const raw = out[f.key];
    if (raw == null) { out[f.key] = null; continue; }
    if (!calendar) {
      console.warn(`[calendar] field '${f.key}' ignored — pack has no calendar`);
      out[f.key] = null;
      continue;
    }
    const v = calendarMath.validateDate(calendar, raw);
    if (!v.ok) return { error: `${f.label || f.key}: ${v.error}` };
    out[f.key] = v.value;
  }
  return { fields: out };
}

// ---- Lore entries -----------------------------------------------------------

// GET /api/worlds/:id/lore?category=<catId> — list entries (optionally filtered).
// List reads must NOT drag in history sidecars — they have an extra dot in the
// stem (`${id}.history.json`), so filtering to plain `${id}.json` skips them.
// §4.8: readable by members, FILTERED by canSee against the viewer's role — an
// entry above their tier (or any `hidden` one) never appears, not even its name,
// so wiki-resolution and broken-links stay correct for that member. Non-owners
// additionally get every fog-capable field stripped of ||GM-only|| spans.
app.get('/api/worlds/:id/lore', requireAuth, validId, requireWorldRead, (req, res) => {
  const dir = loreDir(req.params.id);
  if (!fs.existsSync(dir)) return res.json([]);
  const category = req.query.category;
  const role = req.worldRole;
  const categories = packs.loadCategories(DATA_DIR, req.world.packId);
  const entries = [];
  for (const file of fs.readdirSync(dir)) {
    // Plain entry files only: `${id}.json` where the stem has no extra dot.
    // The extra-dot sidecars (`.history.json`, `.proposals.json`, `.assets.json`)
    // are already excluded by the no-dot stem regex; the explicit guards are
    // belt-and-suspenders so a scan never leaks a sidecar as an "entry".
    if (!/^[a-z0-9-]+\.json$/i.test(file)) continue;
    if (file.endsWith('.history.json') || file.endsWith('.proposals.json')) continue;
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      if (category && entry.categoryId !== category) continue;
      if (!canSee(role, entry.visibility)) continue;          // never serialize what the role can't see
      entries.push(serializeEntryForRole(entry, role, categories));
    } catch (e) {
      console.error(`[lore] Skipping unreadable ${file}: ${e.message}`);
    }
  }
  entries.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  res.json(entries);
});

// POST /api/worlds/:id/lore — create. Server owns id, worldId, createdBy, times.
// Open to owner + coGM (requireWorldWrite). New entries default to `hidden`:
// sharing is a deliberate act, and fog means a shared entry can still hold secrets.
app.post('/api/worlds/:id/lore', requireAuth, validId, requireWorldWrite, (req, res) => {
  const b = req.body || {};
  const categoryId = typeof b.categoryId === 'string' ? b.categoryId : '';
  const name       = typeof b.name === 'string' ? b.name.trim() : '';
  if (!categoryId) return res.status(400).json({ error: 'categoryId required' });
  if (!name)       return res.status(400).json({ error: 'Name required' });

  // categoryId must be one the world's pack actually declares.
  const categories = packs.loadCategories(DATA_DIR, req.world.packId);
  const categoryDef = categories.find(c => c.id === categoryId);
  if (!categoryDef) {
    return res.status(400).json({ error: 'Unknown category' });
  }

  // §4.11: validate/normalize calendar-date fields against the world's calendar.
  const calendar = resolveWorldCalendar(req.world);
  const sane = sanitizeEntryFields(b.fields, categoryDef, calendar);
  if (sane.error) return res.status(400).json({ error: sane.error });

  const now = new Date().toISOString();
  const entry = {
    id:         newRecordId(name),
    worldId:    req.params.id,
    categoryId,
    name:       name.slice(0, 200),
    fields:     sane.fields,
    // Only GMs reach this route and both states are legal for both GM roles, so
    // there is no role clamp left — just validate. Junk fails closed anyway
    // (canSee returns false for anything that isn't 'shared'), but keep it clean.
    visibility: VISIBILITY_STATES.includes(b.visibility) ? b.visibility : DEFAULT_VISIBILITY,
    createdBy:  req.session.user.username,
    createdAt:  now,
    updatedAt:  now,
  };
  fs.mkdirSync(loreDir(req.params.id), { recursive: true });
  fs.writeFileSync(lorePath(req.params.id, entry.id), JSON.stringify(entry, null, 2));
  res.json(entry);
});

// GET /api/worlds/:id/lore/:entryId — read one. §4.8: readable by members, but
// 404 if the viewer's role can't see it (same not-found response as a missing
// entry — never confirm an over-tier/hidden entry exists). Fog-stripped for
// non-owners.
app.get('/api/worlds/:id/lore/:entryId', requireAuth, validId, requireWorldRead, (req, res) => {
  if (!safeId(req.params.entryId)) return res.status(400).json({ error: 'Invalid id' });
  const entry = readLoreEntry(req.params.id, req.params.entryId);
  if (!entry || !canSee(req.worldRole, entry.visibility)) return res.status(404).json({ error: 'Not found' });
  const categories = packs.loadCategories(DATA_DIR, req.world.packId);
  res.json(serializeEntryForRole(entry, req.worldRole, categories));
});

// PUT /api/worlds/:id/lore/:entryId — update name/fields/visibility. Appends the
// PRE-edit snapshot to history first, so the newest history version always
// reflects a prior saved state and the current file is the live one.
// Open to owner + coGM (requireWorldWrite), and only for an entry they canSee
// (404 otherwise — never confirm a hidden entry exists). The snapshot records the
// EDITING user (session identity), so history shows who changed what. Both GM
// roles receive raw fog (seesRawFog), so an edit round-trip is lossless — they
// cannot erase ||fog|| that was never stripped for them. This is why no non-GM
// tier may write directly: a proposer's base IS fog-stripped, so their edits go
// through the proposal queue for a sighted GM to merge.
app.put('/api/worlds/:id/lore/:entryId', requireAuth, validId, requireWorldWrite, (req, res) => {
  if (!safeId(req.params.entryId)) return res.status(400).json({ error: 'Invalid id' });
  const entry = readLoreEntry(req.params.id, req.params.entryId);
  if (!entry || !canSee(req.worldRole, entry.visibility)) return res.status(404).json({ error: 'Not found' });

  const b = req.body || {};

  // §4.11: validate calendar-date fields BEFORE snapshotting/mutating, so an
  // invalid date is a clean 400 that leaves no spurious history version behind.
  let nextFields = null;
  if (b.fields && typeof b.fields === 'object' && !Array.isArray(b.fields)) {
    const categories  = packs.loadCategories(DATA_DIR, req.world.packId);
    const categoryDef = categories.find(c => c.id === entry.categoryId);
    const calendar    = resolveWorldCalendar(req.world);
    const sane = sanitizeEntryFields(b.fields, categoryDef, calendar);
    if (sane.error) return res.status(400).json({ error: sane.error });
    nextFields = sane.fields;
  }

  // Snapshot the current (pre-edit) state before mutating, attributed to the editor.
  appendLoreHistory(req.params.id, entry, req.session.user.username, 'edit');

  if (typeof b.name === 'string' && b.name.trim()) entry.name = b.name.trim().slice(0, 200);
  if (nextFields) entry.fields = nextFields;
  // Invalid values are ignored, leaving the current visibility untouched (the old
  // clamp's behaviour). No role clamp: only GMs reach here and both states are theirs.
  if (b.visibility !== undefined && VISIBILITY_STATES.includes(b.visibility)) entry.visibility = b.visibility;
  entry.updatedAt = new Date().toISOString();
  // app-owned fields (id, worldId, categoryId, createdBy, createdAt) untouched.

  fs.writeFileSync(lorePath(req.params.id, entry.id), JSON.stringify(entry, null, 2));
  res.json(entry);
});

// DELETE /api/worlds/:id/lore/:entryId — remove entry + its history sidecar.
app.delete('/api/worlds/:id/lore/:entryId', requireAuth, requireGM, validId, requireWorldOwner, (req, res) => {
  if (!safeId(req.params.entryId)) return res.status(400).json({ error: 'Invalid id' });
  const p = lorePath(req.params.id, req.params.entryId);
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'Not found' });
  fs.rmSync(p, { force: true });
  const hp = loreHistoryPath(req.params.id, req.params.entryId);
  if (fs.existsSync(hp)) fs.rmSync(hp, { force: true });
  const pp = loreProposalsPath(req.params.id, req.params.entryId);
  if (fs.existsSync(pp)) fs.rmSync(pp, { force: true });   // §4.9: sweep proposals too
  removeLoreAssets(req.params.id, req.params.entryId);  // blobs + assets manifest
  res.json({ ok: true });
});

// GET /api/worlds/:id/lore/:entryId/history — the version list (newest last).
app.get('/api/worlds/:id/lore/:entryId/history', requireAuth, requireGM, validId, requireWorldOwner, (req, res) => {
  if (!safeId(req.params.entryId)) return res.status(400).json({ error: 'Invalid id' });
  if (!readLoreEntry(req.params.id, req.params.entryId)) return res.status(404).json({ error: 'Not found' });
  res.json(readLoreHistory(req.params.id, req.params.entryId));
});

// POST /api/worlds/:id/lore/:entryId/restore  body: { index }
// Non-destructive: first snapshot the CURRENT state into history, then write the
// chosen version's body as current — so a restore is itself undoable.
app.post('/api/worlds/:id/lore/:entryId/restore', requireAuth, requireGM, validId, requireWorldOwner, (req, res) => {
  if (!safeId(req.params.entryId)) return res.status(400).json({ error: 'Invalid id' });
  const entry = readLoreEntry(req.params.id, req.params.entryId);
  if (!entry) return res.status(404).json({ error: 'Not found' });

  const history = readLoreHistory(req.params.id, req.params.entryId);
  const index = Number(req.body?.index);
  if (!Number.isInteger(index) || index < 0 || index >= history.versions.length) {
    return res.status(400).json({ error: 'Invalid version index' });
  }

  // Snapshot current state so the restore can itself be undone.
  appendLoreHistory(req.params.id, entry, req.session.user.username, 'restore');

  const snap = history.versions[index].body;
  entry.name       = snap.name;
  entry.fields     = snap.fields || {};
  entry.visibility = VISIBILITY_STATES.includes(snap.visibility) ? snap.visibility : entry.visibility;
  entry.updatedAt  = new Date().toISOString();
  fs.writeFileSync(lorePath(req.params.id, entry.id), JSON.stringify(entry, null, 2));
  res.json(entry);
});

// ---- Proposals (§4.9 — propose tier: suggested edits, GM-approved) ----------
// A proposal is a suggested set of field/name values a member submits WITHOUT
// touching the entry. The owner reviews the queue and approves (applies through
// the normal update path, so history records the pre-edit snapshot) or rejects.
// Because a proposer's base was fog-stripped, approval is a SIGHTED act — the GM's
// UI shows the proposal against the raw entry and may edit before approving; the
// approve route accepts the GM's (possibly edited) name/fields, never a blind copy.
const PROPOSAL_ID_RE = /^[A-Za-z0-9]{1,40}$/;

// POST propose — owner/write/propose may submit (a `read` member may not); requires
// canSee on the entry. Never mutates the entry. Identity from session.
app.post('/api/worlds/:id/lore/:entryId/proposals', requireAuth, validId, requireWorldRead, (req, res) => {
  if (!safeId(req.params.entryId)) return res.status(400).json({ error: 'Invalid id' });
  if (req.worldRole === 'read') return res.status(403).json({ error: 'Read access cannot propose edits' });
  const entry = readLoreEntry(req.params.id, req.params.entryId);
  if (!entry || !canSee(req.worldRole, entry.visibility)) return res.status(404).json({ error: 'Not found' });

  const b = req.body || {};
  const fields = (b.fields && typeof b.fields === 'object' && !Array.isArray(b.fields)) ? b.fields : {};
  const proposal = {
    id:         generateToken(12),
    entryId:    entry.id,
    proposedBy: req.session.user.username,        // session identity, never the body
    proposedAt: new Date().toISOString(),
    name:       typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 200) : entry.name,
    fields,
    note:       typeof b.note === 'string' ? b.note.slice(0, 1000) : '',
    status:     'pending',
    resolvedBy: null,
    resolvedAt: null,
  };
  const store = readLoreProposals(req.params.id, entry.id);
  store.proposals.push(proposal);
  writeLoreProposals(req.params.id, entry.id, store);
  res.json(proposal);
});

// GET per-entry proposals — the owner sees ALL; anyone else sees only their OWN.
app.get('/api/worlds/:id/lore/:entryId/proposals', requireAuth, validId, requireWorldRead, (req, res) => {
  if (!safeId(req.params.entryId)) return res.status(400).json({ error: 'Invalid id' });
  const entry = readLoreEntry(req.params.id, req.params.entryId);
  if (!entry || !canSee(req.worldRole, entry.visibility)) return res.status(404).json({ error: 'Not found' });
  const all = readLoreProposals(req.params.id, entry.id).proposals;
  const mine = req.worldRole === 'owner'
    ? all
    : all.filter(p => p.proposedBy === req.session.user.username);
  res.json({ proposals: mine });
});

// GET the world-wide PENDING queue — owner-only (the GM's review list). Scans the
// per-entry proposal sidecars and enriches each pending item with its entry name.
app.get('/api/worlds/:id/proposals', requireAuth, requireGM, validId, requireWorldOwner, (req, res) => {
  const dir = loreDir(req.params.id);
  if (!fs.existsSync(dir)) return res.json({ proposals: [] });
  const out = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.proposals.json')) continue;
    const entryId = file.slice(0, -('.proposals.json'.length));
    if (!safeId(entryId)) continue;
    const entry = readLoreEntry(req.params.id, entryId);
    const entryName = entry ? entry.name : '(deleted entry)';
    for (const p of readLoreProposals(req.params.id, entryId).proposals) {
      if (p.status !== 'pending') continue;
      out.push({ ...p, entryName });
    }
  }
  out.sort((a, b) => (a.proposedAt || '').localeCompare(b.proposedAt || ''));
  res.json({ proposals: out });
});

// POST approve — owner-only. Applies the proposal's (or the GM's edited) name +
// fields to the entry through the normal update path: pre-edit snapshot to history
// attributed to the approving GM with the proposer noted, then mark approved. A
// proposal already resolved returns 409 rather than re-applying (idempotent-safe).
app.post('/api/worlds/:id/lore/:entryId/proposals/:proposalId/approve', requireAuth, requireGM, validId, requireWorldOwner, (req, res) => {
  if (!safeId(req.params.entryId)) return res.status(400).json({ error: 'Invalid id' });
  if (!PROPOSAL_ID_RE.test(req.params.proposalId)) return res.status(400).json({ error: 'Bad proposal id' });
  const entry = readLoreEntry(req.params.id, req.params.entryId);
  if (!entry) return res.status(404).json({ error: 'Not found' });

  const store = readLoreProposals(req.params.id, req.params.entryId);
  const p = store.proposals.find(x => x.id === req.params.proposalId);
  if (!p) return res.status(404).json({ error: 'No such proposal' });
  if (p.status !== 'pending') return res.status(409).json({ error: 'Proposal already resolved' });

  // Apply the GM's reviewed values if supplied (sighted approve — the GM may have
  // edited to re-inject fog), else the proposal's stored values. Never the raw body
  // for app-owned fields; visibility/id/timestamps are not the proposer's to set.
  const b = req.body || {};
  const name   = typeof b.name === 'string' && b.name.trim() ? b.name.trim()
               : (typeof p.name === 'string' && p.name.trim() ? p.name.trim() : entry.name);
  const fields = (b.fields && typeof b.fields === 'object' && !Array.isArray(b.fields)) ? b.fields
               : (p.fields && typeof p.fields === 'object' && !Array.isArray(p.fields) ? p.fields : entry.fields);

  // §4.11: an approved proposal lands through the SAME calendar-date validation as
  // a direct edit — a bad date can't sneak in via approval. Checked BEFORE the
  // history snapshot so a rejection leaves no spurious version.
  const categories  = packs.loadCategories(DATA_DIR, req.world.packId);
  const categoryDef = categories.find(c => c.id === entry.categoryId);
  const calendar    = resolveWorldCalendar(req.world);
  const sane = sanitizeEntryFields(fields, categoryDef, calendar);
  if (sane.error) return res.status(400).json({ error: sane.error });

  // Snapshot the current (pre-edit) state, attributed to the approving GM.
  appendLoreHistory(req.params.id, entry, req.session.user.username, `approve (from ${p.proposedBy})`);

  entry.name      = String(name).slice(0, 200);
  entry.fields    = sane.fields;
  entry.updatedAt = new Date().toISOString();
  fs.writeFileSync(lorePath(req.params.id, entry.id), JSON.stringify(entry, null, 2));

  p.status     = 'approved';
  p.resolvedBy = req.session.user.username;
  p.resolvedAt = new Date().toISOString();
  writeLoreProposals(req.params.id, req.params.entryId, store);
  res.json({ ok: true, entry, proposal: p });
});

// POST reject — owner-only. Marks the proposal rejected; never touches the entry.
app.post('/api/worlds/:id/lore/:entryId/proposals/:proposalId/reject', requireAuth, requireGM, validId, requireWorldOwner, (req, res) => {
  if (!safeId(req.params.entryId)) return res.status(400).json({ error: 'Invalid id' });
  if (!PROPOSAL_ID_RE.test(req.params.proposalId)) return res.status(400).json({ error: 'Bad proposal id' });

  const store = readLoreProposals(req.params.id, req.params.entryId);
  const p = store.proposals.find(x => x.id === req.params.proposalId);
  if (!p) return res.status(404).json({ error: 'No such proposal' });
  if (p.status !== 'pending') return res.status(409).json({ error: 'Proposal already resolved' });

  p.status     = 'rejected';
  p.resolvedBy = req.session.user.username;
  p.resolvedAt = new Date().toISOString();
  writeLoreProposals(req.params.id, req.params.entryId, store);
  res.json({ ok: true, proposal: p });
});

// ---- Per-entry lore assets (inline images + attachments) --------------------
// All routes carry the full lore auth chain (requireAuth + requireGM + validId +
// requireWorldOwner) PLUS a safeId check on :entryId, mirroring the other
// /lore/:entryId routes. The entry must exist before we touch its asset store.

// GET list
app.get('/api/worlds/:id/lore/:entryId/assets', requireAuth, requireGM, validId, requireWorldOwner, (req, res) => {
  if (!safeId(req.params.entryId)) return res.status(400).json({ error: 'Invalid id' });
  if (!readLoreEntry(req.params.id, req.params.entryId)) return res.status(404).json({ error: 'Not found' });
  res.json({ assets: readLoreAssets(req.params.id, req.params.entryId) });
});

// POST upload — allowlist + magic-byte checked, count/size capped, blob written
// under a server token (the original filename is metadata only).
app.post('/api/worlds/:id/lore/:entryId/assets',
  requireAuth, requireGM, validId, requireWorldOwner, loreAssetUpload.single('file'),
  (req, res) => {
    if (!safeId(req.params.entryId)) return res.status(400).json({ error: 'Invalid id' });
    if (!readLoreEntry(req.params.id, req.params.entryId)) return res.status(404).json({ error: 'Not found' });
    if (!req.file) return res.status(400).json({ error: 'No file' });

    const worldId = req.params.id, entryId = req.params.entryId;
    const ext = path.extname(req.file.originalname).slice(1).toLowerCase();
    if (!ATTACH_EXTS.has(ext))             return res.status(415).json({ error: 'File type not allowed' });
    if (!sniffMagic(ext, req.file.buffer)) return res.status(415).json({ error: "File contents don't match its type" });

    const list = readLoreAssets(worldId, entryId);
    if (list.length >= LORE_ASSET_MAX_PER_ENTRY) {
      return res.status(413).json({ error: `Limit of ${LORE_ASSET_MAX_PER_ENTRY} files per entry reached` });
    }
    const total = list.reduce((n, a) => n + (a.size || 0), 0);
    if (total + req.file.size > ATTACH_MAX_TOTAL_BYTES) {
      return res.status(413).json({ error: 'Storage limit for this entry reached' });
    }

    const sha256 = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    let key;
    const used = new Set(list.map(a => a.key));
    do { key = generateToken(12); } while (used.has(key));

    fs.mkdirSync(loreDir(worldId), { recursive: true });
    fs.writeFileSync(loreAssetBlobPath(worldId, entryId, key, ext), req.file.buffer);

    const asset = {
      key,
      name:       String(req.file.originalname).slice(0, 200),
      ext,
      mime:       ATTACH_MIME[ext],
      size:       req.file.size,
      sha256,
      isImage:    LORE_IMAGE_EXTS.has(ext),
      url:        `/api/worlds/${worldId}/lore/${entryId}/assets/${key}`,
      uploadedAt: new Date().toISOString(),
      uploadedBy: req.session.user.username,
    };
    list.push(asset);
    writeLoreAssets(worldId, entryId, list);
    res.json({ asset, assets: list });
  });

// GET one (download / inline view). Content-Type is PINNED from our map, nosniff
// is always set, and only known-safe types are served inline; the rest download.
// §4.8: member-readable, but re-checked — a member may fetch a lore asset ONLY if
// they canSee the OWNING entry (assets are entryId-scoped). An over-tier/hidden
// entry's images 404 for that member, same as the entry itself.
app.get('/api/worlds/:id/lore/:entryId/assets/:key', requireAuth, validId, requireWorldRead, (req, res) => {
  if (!safeId(req.params.entryId)) return res.status(400).json({ error: 'Invalid id' });
  const key = req.params.key;
  if (!/^[A-Za-z0-9]{1,40}$/.test(key)) return res.status(400).json({ error: 'Bad key' });

  const entry = readLoreEntry(req.params.id, req.params.entryId);
  if (!entry || !canSee(req.worldRole, entry.visibility)) return res.status(404).json({ error: 'Not found' });

  const asset = readLoreAssets(req.params.id, req.params.entryId).find(a => a.key === key);
  if (!asset) return res.status(404).json({ error: 'No such asset' });

  const p = loreAssetBlobPath(req.params.id, req.params.entryId, asset.key, asset.ext);
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'File missing' });

  const disposition = ATTACH_INLINE.has(asset.ext) ? 'inline' : 'attachment';
  res.setHeader('Content-Type', ATTACH_MIME[asset.ext] || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `${disposition}; ${dispositionFilename(asset.name)}`);
  res.setHeader('Content-Length', asset.size);
  const stream = fs.createReadStream(p);
  stream.on('error', () => { if (!res.headersSent) res.status(500).end(); else res.destroy(); });
  stream.pipe(res);
});

// DELETE one — owner-only. Removes blob + manifest entry. (A body that still
// references a deleted image renders a broken <img>, which is honest, same as a
// dangling [[wiki]] link — we don't rewrite the author's text behind their back.)
app.delete('/api/worlds/:id/lore/:entryId/assets/:key', requireAuth, requireGM, validId, requireWorldOwner, (req, res) => {
  if (!safeId(req.params.entryId)) return res.status(400).json({ error: 'Invalid id' });
  const key = req.params.key;
  if (!/^[A-Za-z0-9]{1,40}$/.test(key)) return res.status(400).json({ error: 'Bad key' });

  const list  = readLoreAssets(req.params.id, req.params.entryId);
  const asset = list.find(a => a.key === key);
  if (!asset) return res.status(404).json({ error: 'No such asset' });

  const p = loreAssetBlobPath(req.params.id, req.params.entryId, asset.key, asset.ext);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  const next = list.filter(a => a.key !== key);
  writeLoreAssets(req.params.id, req.params.entryId, next);
  res.json({ ok: true, assets: next });
});

// ---- System reference — the stamped tier (Wave C) ---------------------------
//
// Guard chains are IDENTICAL to lore, for the same reasons:
//   read   → requireWorldRead  + canSee filter + fog strip (serializeEntryForRole)
//   write  → requireWorldWrite (owner + coGM)
//   delete → requireWorldOwner (destructive stays structural)
//
// NOTE, and this is a deliberate departure from the Wave C handoff: that spec
// said system reference is visible to EVERY world member with no per-entry
// tiering, on the grounds that mechanics are not secrets. The owner overrode it —
// entries here carry per-entry `visibility` and honour ||fog|| exactly like lore.
// The reason is the unpublished monster: a GM writing up next session's boss wants
// it in the compendium before the players ever meet it, and "the players are using
// these rules" is only true of the rules they've been given. Reusing the lore
// model costs nothing (canSee and serializeEntryForRole are shared verbatim) and
// removes the footgun where a GM types ||…|| into a statblock note that turns out
// to be world-readable.

// Only keys the type actually declares survive, and each is capped. An allowlist,
// never a spread — the same discipline as buildProps and every serializer, so a
// crafted body can't smuggle an extra key into a stored record and no field can
// grow without bound. Values are coerced to strings because every derived sysref
// field is text or textarea (systemRef.js skips non-scalar shapes).
function sanitizeSysrefFields(fields, typeDef) {
  const src = fields && typeof fields === 'object' && !Array.isArray(fields) ? fields : {};
  const out = {};
  for (const f of (typeDef.fields || [])) {
    if (!(f.key in src)) continue;
    const v = src[f.key];
    if (v == null) { out[f.key] = ''; continue; }
    if (typeof v === 'object') continue;                 // no structured values here
    out[f.key] = String(v).slice(0, f.type === 'textarea' ? 20000 : 500);
  }
  return out;
}

// GET /api/systems — the bundles a world can actually be STAMPED with.
//
// NOT the same list as GET /api/sheets. A sheet bundle is a character sheet; a
// SYSTEM is a bundle that also declares a compendium (`sysrefTypes`). Most
// bundles are both, but the picker must offer only the latter — listing every
// sheet meant choosing one that yields no types, which either 400s on save or
// stamps a world with an empty System rail. Filtering here (server-side, where
// the schemas already are) keeps the client from having to fetch and inspect
// every schema to find out.
//
// GM-gated rather than owner-gated: it names no world and leaks nothing about
// one — it's the bundle catalogue, and only GMs create or configure worlds.
app.get('/api/systems', requireAuth, requireGM, (req, res) => {
  const out = [];
  for (const row of sheets.loadRegistry(DATA_DIR)) {
    if (!row.enabled) continue;
    const types = systemRef.loadSystemTypes(DATA_DIR, row.sheetId);
    if (!types) continue;                       // no package — not a system
    out.push({ sheetId: row.sheetId, name: row.name, version: row.version, types: types.length });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  res.json(out);
});

// GET /api/worlds/:id/system — the world's stamp + the reference types it offers.
// Member-readable: a player needs the type list to browse the compendium and to
// resolve [[sys:…]] links. Returns { systemId: null, types: [] } for a world with
// no system set, which is a normal state, not an error.
app.get('/api/worlds/:id/system', requireAuth, validId, requireWorldRead, (req, res) => {
  const systemId = req.world.primarySystemId || null;
  res.json({ systemId, types: worldSystemTypes(req.world) });
});

// PUT /api/worlds/:id/system  body { systemId }
// STRUCTURAL, so owner-only: changing the stamp re-points every [[sys:…]] link in
// the world at a different rule set. Existing entries keep their OWN systemId
// stamp and are NOT rewritten — that is the whole point of stamping. They simply
// stop resolving under the new system until reconverted, which is exactly the
// worklist the conversion tracker reports.
app.put('/api/worlds/:id/system', requireAuth, requireGM, validId, requireWorldOwner, (req, res) => {
  const raw = req.body && req.body.systemId;
  const worlds = getWorlds();
  const world  = worlds.find(w => w.id === req.params.id);

  if (raw === null || raw === '') {                    // explicit "no system"
    delete world.primarySystemId;
    saveWorlds(worlds);
    return res.json({ systemId: null, types: [] });
  }
  if (typeof raw !== 'string' || !safeId(raw)) {
    return res.status(400).json({ error: 'Invalid systemId' });
  }
  // The bundle must actually exist and yield usable types. Validating here means a
  // world can never be stamped with a system whose shapes nobody can render.
  const types = systemRef.loadSystemTypes(DATA_DIR, raw);
  if (!types) return res.status(400).json({ error: 'Unknown or unusable system bundle' });

  world.primarySystemId = raw;
  saveWorlds(worlds);
  res.json({ systemId: raw, types });
});

// GET /api/worlds/:id/sysref?type=<typeId> — list entries, canSee-filtered and
// fog-stripped per role. Same plain-`${id}.json` scan as lore, so any future
// sidecar is excluded by construction.
app.get('/api/worlds/:id/sysref', requireAuth, validId, requireWorldRead, (req, res) => {
  const dir = sysrefDir(req.params.id);
  if (!fs.existsSync(dir)) return res.json([]);
  const type  = req.query.type;
  const role  = req.worldRole;
  const types = worldSystemTypes(req.world);
  const out = [];
  for (const file of fs.readdirSync(dir)) {
    if (!/^[a-z0-9-]+\.json$/i.test(file)) continue;
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      if (type && entry.categoryId !== type) continue;
      if (!canSee(role, entry.visibility)) continue;
      out.push(serializeEntryForRole(entry, role, types));
    } catch (e) {
      console.error(`[sysref] Skipping unreadable ${file}: ${e.message}`);
    }
  }
  out.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  res.json(out);
});

// POST /api/worlds/:id/sysref — create. Server owns id, worldId, systemId,
// createdBy and the timestamps; the stamp comes from the WORLD's current system,
// never the body, so an entry can only ever be stamped with a system the world is
// actually on. Defaults to `hidden` like lore: sharing is a deliberate act.
app.post('/api/worlds/:id/sysref', requireAuth, validId, requireWorldWrite, (req, res) => {
  const b = req.body || {};
  const typeId = typeof b.categoryId === 'string' ? b.categoryId : '';
  const name   = typeof b.name === 'string' ? b.name.trim() : '';
  if (!typeId) return res.status(400).json({ error: 'categoryId required' });
  if (!name)   return res.status(400).json({ error: 'Name required' });

  const systemId = req.world.primarySystemId;
  if (!systemId) return res.status(400).json({ error: 'World has no system set' });
  const types   = worldSystemTypes(req.world);
  const typeDef = types.find(t => t.id === typeId);
  if (!typeDef) return res.status(400).json({ error: 'Unknown reference type' });

  const now = new Date().toISOString();
  const entry = {
    id:         newRecordId(name),
    worldId:    req.params.id,
    systemId,                                   // the stamp — never from the body
    categoryId: typeId,
    name:       name.slice(0, 200),
    fields:     sanitizeSysrefFields(b.fields, typeDef),
    visibility: VISIBILITY_STATES.includes(b.visibility) ? b.visibility : DEFAULT_VISIBILITY,
    createdBy:  req.session.user.username,
    createdAt:  now,
    updatedAt:  now,
  };
  fs.mkdirSync(sysrefDir(req.params.id), { recursive: true });
  fs.writeFileSync(sysrefPath(req.params.id, entry.id), JSON.stringify(entry, null, 2));
  res.json(entry);
});

// GET /api/worlds/:id/sysref/:entryId — read one. 404 (not 403) when the role
// can't see it: the same response as a missing entry, so a player probing ids
// learns nothing about what exists.
app.get('/api/worlds/:id/sysref/:entryId', requireAuth, validId, requireWorldRead, (req, res) => {
  if (!safeId(req.params.entryId)) return res.status(400).json({ error: 'Invalid id' });
  const entry = readSysrefEntry(req.params.id, req.params.entryId);
  if (!entry || !canSee(req.worldRole, entry.visibility)) return res.status(404).json({ error: 'Not found' });
  res.json(serializeEntryForRole(entry, req.worldRole, worldSystemTypes(req.world)));
});

// PUT /api/worlds/:id/sysref/:entryId — update name / fields / visibility.
// App-owned fields (id, worldId, systemId, categoryId, createdBy, createdAt) are
// re-read from disk and never taken from the body. In particular the STAMP is
// immutable here: re-stamping in place is what §1 calls the lossy auto-mapping we
// don't do — conversion creates a NEW entry under the new system.
//
// No history sidecar on this tier yet (lore's §4c capture is not wired here) —
// see the deferred list; it can be added later without a format change because
// the record shape already matches a lore entry.
app.put('/api/worlds/:id/sysref/:entryId', requireAuth, validId, requireWorldWrite, (req, res) => {
  if (!safeId(req.params.entryId)) return res.status(400).json({ error: 'Invalid id' });
  const entry = readSysrefEntry(req.params.id, req.params.entryId);
  if (!entry || !canSee(req.worldRole, entry.visibility)) return res.status(404).json({ error: 'Not found' });

  const b = req.body || {};
  // Validate against the type as the ENTRY was stamped, not the world's current
  // system: a legacy entry stays fully editable while a migration is half-done
  // (CLAUDE.md §1 — a badged entry is not read-only).
  const types   = entry.systemId === req.world.primarySystemId
    ? worldSystemTypes(req.world)
    : (systemRef.loadSystemTypes(DATA_DIR, entry.systemId) || []);
  const typeDef = types.find(t => t.id === entry.categoryId);
  if (!typeDef) return res.status(400).json({ error: 'Entry type is not loadable under its stamped system' });

  if (typeof b.name === 'string' && b.name.trim()) entry.name = b.name.trim().slice(0, 200);
  if (b.fields && typeof b.fields === 'object') entry.fields = sanitizeSysrefFields(b.fields, typeDef);
  if (b.visibility !== undefined && VISIBILITY_STATES.includes(b.visibility)) entry.visibility = b.visibility;
  entry.updatedAt = new Date().toISOString();

  fs.writeFileSync(sysrefPath(req.params.id, entry.id), JSON.stringify(entry, null, 2));
  res.json(entry);
});

// DELETE /api/worlds/:id/sysref/:entryId — owner-only, matching lore: destructive
// and there is no history to restore from on this tier.
app.delete('/api/worlds/:id/sysref/:entryId', requireAuth, requireGM, validId, requireWorldOwner, (req, res) => {
  if (!safeId(req.params.entryId)) return res.status(400).json({ error: 'Invalid id' });
  const p = sysrefPath(req.params.id, req.params.entryId);
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'Not found' });
  fs.rmSync(p, { force: true });
  res.json({ ok: true });
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

app.post('/api/characters/:id/shares', requireAuth, validId, requireCharOwner, (req, res) => {
  const found = req.foundChar;
  const char = JSON.parse(fs.readFileSync(found.filePath));

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

app.get('/api/characters/:id/shares', requireAuth, validId, requireCharOwner, (req, res) => {
  const found = req.foundChar;
  const char = JSON.parse(fs.readFileSync(found.filePath));
  const now    = new Date();
  const active = (char.shares || []).filter(s => new Date(s.expiresAt) > now);
  res.json(active);
});

app.delete('/api/characters/:id/shares/:token', requireAuth, validId, requireCharOwner, (req, res) => {
  const found = req.foundChar;
  const char = JSON.parse(fs.readFileSync(found.filePath));
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
  appendLog('shareAccesses', {
    sharedBy:  result.username,
    character: result.char.name || result.char.id || 'Unknown',
    at:        new Date().toISOString(),
    ip:        normalizeIp(req.ip),
  });
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

app.post('/api/characters/:id/rename', requireAuth, validId, requireCharOwner, (req, res) => {
  const oldId    = req.params.id;
  const username = req.session.user.username;
  const newName  = req.body?.name?.trim();

  if (!newName) return res.status(400).json({ error: 'Name required' });

  const existing = req.foundChar;

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
      const extensions = PORTRAIT_EXTENSIONS;
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
app.post('/api/characters/:id/status', requireAuth, validId, requireCharOwner, (req, res) => {
  const id     = req.params.id;
  const status = req.body?.status;

  const VALID_STATUSES = ['active', 'inactive', 'deceased', 'retired', 'shelved', 'archived'];
  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  const existing = req.foundChar;

  const char = readCharFull(existing);
  char.status    = status;
  char.updatedAt = new Date().toISOString();
  writeCharSplit(existing.username, req.params.id, char);

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

  const char = readCharFull(existing);
  char.campaignId   = match.id;
  char.campaignCode = code.toUpperCase();
  char.campaignName = match.name;
  char.updatedAt    = new Date().toISOString();
  writeCharSplit(existing.username, req.params.id, char);

  // §4.7 auto-grant: if the joined campaign belongs to a world, the CHARACTER'S
  // OWNER gains world access. Upsert them into the world's members ledger at
  // `read` ONLY IF ABSENT — never downgrade an existing higher tier, so this is
  // idempotent and re-joining can't undo a promotion. The owner is read from the
  // character (existing.username), never the request body. This is GM-side
  // plumbing only: the member still can't OPEN the world until §4.8.
  if (match.worldId) {
    const worlds = getWorlds();
    const world  = worlds.find(w => w.id === match.worldId);
    if (world && world.ownedBy !== existing.username) {   // the owner is never a member of their own world
      if (!world.members || typeof world.members !== 'object') world.members = {};
      if (!world.members[existing.username]) {
        world.members[existing.username] = {
          tier:       'read',
          grantedAt:  new Date().toISOString(),
          grantedVia: match.id,
        };
        saveWorlds(worlds);
      }
    }
  }

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

  const char    = readCharFull(existing);
  const isOwner = existing.username === username;
  const isGM    = ownsCampaignOf(username, char.campaignId);

  if (!isAdmin && !isOwner && !isGM) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  char.campaignId   = null;
  char.campaignCode = null;
  char.campaignName = null;
  char.updatedAt    = new Date().toISOString();
  writeCharSplit(existing.username, req.params.id, char);

  res.json({ id, campaignId: null, campaignName: null });
});



// ---------------------------------------------------------------------------
// SPA fallback
// ---------------------------------------------------------------------------
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend/build/index.html'));
});

// ---------------------------------------------------------------------------
// Global error handler — must be the last app.use() and must have exactly
// four parameters so Express recognises it as an error handler. Without this,
// any unhandled synchronous throw inside a route lands in Express's built-in
// fallback, which leaks the full stack trace to the client in non-production
// environments.
// ---------------------------------------------------------------------------
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Multer signals oversize/too-many-files via a MulterError — that's a client
  // mistake (413/400), not a server fault, so don't let it fall through to a
  // misleading 500. Its .code (e.g. LIMIT_FILE_SIZE) is safe, non-sensitive.
  if (err instanceof multer.MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({ error: `Upload rejected: ${err.code}` });
  }
  console.error(err);
  const isProd = process.env.NODE_ENV === 'production';
  res.status(err.status || 500).json({
    error: isProd ? 'Internal server error' : (err.message || 'Internal server error'),
  });
});

// Migrate BEFORE binding the port: no request may observe half-migrated data.
migrateWorldModel();

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

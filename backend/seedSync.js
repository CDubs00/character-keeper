/**
 * seedSync.js — version-aware reconciliation of shipped content into /data
 *
 * THE PROBLEM THIS SOLVES
 *
 * Packs (packs.js) and sheet bundles (sheets.js) ship inside the image and are
 * copied into the data volume on first boot. Both did the same thing on every
 * boot after that:
 *
 *     if (fs.existsSync(dest)) continue;   // already there — leave it alone
 *
 * That protects the user's edits and their drop-in folders, which is right —
 * but it also means a content update we ship (a new lore category, a new icon
 * name, a bundle declaring `sysrefTypes`) NEVER reaches an existing install.
 * The app updates; its content silently doesn't. That's the bug that had a
 * production world showing the old generic icons, no Planes category, and no
 * system packages, on a build that contained all three.
 *
 * THE RULE
 *
 * Ship updates, never clobber user data. Concretely, a shipped file is
 * overwritten if and only if we can PROVE the user hasn't touched it:
 *
 *   1. Folders the user created (not in the seed) are never touched at all.
 *   2. Files the user added inside a seeded folder are never touched.
 *   3. A file is overwritten only when its current bytes still hash to what we
 *      recorded when WE last wrote it (the ledger below). Byte-identical files
 *      are a no-op.
 *   4. Anything else — the user edited it, or it predates the ledger and we
 *      can't tell — is left exactly as-is. The new version is written beside it
 *      as `<file>.new` and logged, so the update is never lost, just not
 *      applied. This is the same posture dpkg takes with modified conffiles.
 *   5. A file the seed no longer ships is left in place. Deleting content a
 *      user might be relying on is worse than leaving a stale extra file.
 *
 * WHAT DRIVES AN UPDATE
 *
 * The folder's `manifest.json.version`. We reconcile only when the shipped
 * version is strictly NEWER than the installed one, so a user who hand-installs
 * a newer pack than we ship keeps it, and a same-version boot does no file I/O
 * beyond reading the manifests.
 *
 * The manifest is written LAST and only when the folder reconciled with no
 * conflicts. If anything was held back, the old manifest stays, so the version
 * still reads as old, the reconcile retries on the next boot, and the warning
 * repeats until it's resolved. A half-applied update never gets to claim it's
 * current — which is exactly the failure mode that would make this feature
 * worse than the "never overwrite" it replaces.
 *
 * BOOTSTRAPPING PROVENANCE ON INSTALLS THAT PREDATE THE LEDGER
 *
 * The ledger can only speak for files written after it existed — which is no
 * install currently in the wild. Without help, every existing user's first
 * update after this lands would be held back and they'd all have to be told to
 * run SEED_FORCE, a blunt override that can destroy a genuine edit. Telling
 * someone who may or may not have customised a pack to force-overwrite it is
 * not an upgrade path.
 *
 * So we also carry `seed-known-hashes.json`: the sha256 of EVERY version of
 * every shipped file we have ever released, generated from git history by
 * backend/genSeedHashes.js. A file matching any of those hashes is provably a
 * pristine copy of some release of ours — old, but untouched — and is therefore
 * safe to update. A file matching none was really changed by its owner.
 *
 * Net effect: a user who never edited a pack updates silently and correctly,
 * with no flag and no prompt. A user who did keeps their edit. SEED_FORCE drops
 * back to what it should be — a rare manual override, not routine migration.
 *
 * THE LEDGER
 *
 * `<dataDir>/seed-ledger.json` records, per seeded folder, the version we
 * installed and the sha256 of every file we wrote:
 *
 *   { "packs":   { "default": { "version": "1.1.0", "files": { "categories.json": "…" } } },
 *     "bundles": { "risus":   { … } } }
 *
 * It is OUR record of what we put there, which is what makes "did the user
 * change this?" answerable at all. Losing or deleting it is safe: every file
 * then falls into case 4 (held back, `.new` written), i.e. it fails toward
 * doing nothing.
 *
 * ESCAPE HATCH
 *
 * `SEED_FORCE=all` (or a comma-separated list of folder names) overwrites even
 * files that look user-modified. That's the "I never edited these, they're just
 * old — take the shipped version" button for an install that predates the
 * ledger, which is every install that exists today. It's env-gated rather than
 * automatic because it is the one mode that CAN destroy a user's edit.
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Known-hash list — see "BOOTSTRAPPING PROVENANCE" above.
//
// Keyed by the path within the repo ('packs/default/categories.json'), which is
// how genSeedHashes.js writes it. Loaded once; absent is fine (we simply lose
// the bootstrap and fall back to ledger-only, i.e. more files held back — the
// safe direction).
// ---------------------------------------------------------------------------
let knownHashesCache;
function knownHashes() {
  if (knownHashesCache !== undefined) return knownHashesCache;
  const candidates = [
    process.env.SEED_HASHES_FILE,
    path.join(__dirname, '..', 'seed-known-hashes.json'),   // repo checkout
    '/app/seed-known-hashes.json',                          // docker image
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        knownHashesCache = JSON.parse(fs.readFileSync(p, 'utf8'));
        return knownHashesCache;
      }
    } catch (e) {
      console.error(`[seed] Failed to parse ${p}: ${e.message}`);
    }
  }
  knownHashesCache = {};
  return knownHashesCache;
}

// Was this file, as it sits on disk, ever a version WE shipped?
// `kind` ('packs' | 'bundles') is the top-level seed dir the hashes are keyed by.
function everShipped(kind, name, rel, hash) {
  if (!hash) return false;
  const list = knownHashes()[`${kind}/${name}/${rel}`];
  return Array.isArray(list) && list.includes(hash);
}

function ledgerPath(dataDir) {
  return path.join(dataDir, 'seed-ledger.json');
}

function readLedger(dataDir) {
  const p = ledgerPath(dataDir);
  if (!fs.existsSync(p)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (e) {
    // A corrupt ledger means "we know nothing", which is the safe state: every
    // file gets held back rather than overwritten. Log and carry on.
    console.error(`[seed] Failed to parse seed-ledger.json (${e.message}) — treating all files as user-modified`);
    return {};
  }
}

function writeLedger(dataDir, ledger) {
  try {
    fs.writeFileSync(ledgerPath(dataDir), JSON.stringify(ledger, null, 2));
  } catch (e) {
    console.error(`[seed] Failed to write seed-ledger.json: ${e.message}`);
  }
}

function hashFile(p) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  } catch {
    return null;
  }
}

// OS/editor droppings. These are untracked junk that appears in a local
// checkout, and a dev machine's `packs/` doubles as the seed dir — without this
// filter a stray .DS_Store gets shipped into every user's data volume as if it
// were pack content (observed: "Updated default (2 files: .DS_Store, …)").
// Also skips the `.new` files this module itself writes, so a held-back update
// can never be re-ingested as seed content.
const JUNK = /^(\.DS_Store|Thumbs\.db|desktop\.ini|\._.*)$|\.new$/;

// Every file under `dir`, as forward-slash paths relative to it. Recursive
// because a bundle folder has subdirectories (assets/, fonts/).
function listFiles(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (JUNK.test(entry.name)) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

// Dotted numeric compare: 1 if a > b, -1 if a < b, 0 if equal or uncomparable.
// Deliberately conservative — anything it can't parse as numbers compares equal,
// so an odd version string results in NO update rather than a wrong one.
function compareVersions(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return 0;
  const pa = a.trim().split('.');
  const pb = b.trim().split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = parseInt(pa[i] ?? '0', 10);
    const nb = parseInt(pb[i] ?? '0', 10);
    if (!Number.isFinite(na) || !Number.isFinite(nb)) return 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

function readManifestVersion(folder) {
  const p = path.join(folder, 'manifest.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

function forcedSet() {
  const raw = (process.env.SEED_FORCE || '').trim();
  if (!raw) return null;
  if (raw === 'all' || raw === 'true') return 'all';
  return new Set(raw.split(',').map(s => s.trim()).filter(Boolean));
}

/**
 * Reconcile one shipped folder into its live location.
 * Returns { action, updated[], heldBack[] } — action is one of
 * 'seeded' | 'updated' | 'conflict' | 'current' | 'skipped'.
 */
function syncFolder({ kind, name, seedFolder, liveFolder, dataDir, ledger }) {
  const bucket  = ledger[kind] || (ledger[kind] = {});
  const tag     = `[${kind}]`;
  const forced  = forcedSet();
  const isForced = forced === 'all' || (forced instanceof Set && forced.has(name));

  // ── First boot for this folder: straight copy, then record what we wrote ──
  if (!fs.existsSync(liveFolder)) {
    fs.cpSync(seedFolder, liveFolder, { recursive: true });
    const files = {};
    for (const rel of listFiles(seedFolder)) files[rel] = hashFile(path.join(liveFolder, rel));
    bucket[name] = { version: readManifestVersion(seedFolder), files };
    console.log(`${tag} Seeded built-in ${kind === 'packs' ? 'pack' : 'bundle'}: ${name}`);
    return { action: 'seeded', updated: [], heldBack: [] };
  }

  // ── Already installed: update only when we ship something newer ──────────
  const seedVersion = readManifestVersion(seedFolder);
  const liveVersion = readManifestVersion(liveFolder);
  if (compareVersions(seedVersion, liveVersion) <= 0 && !isForced) {
    return { action: 'current', updated: [], heldBack: [] };
  }

  const record   = bucket[name] || { version: null, files: {} };
  const known    = record.files || {};
  const updated  = [];
  const heldBack = [];

  // manifest.json is handled last and only on a clean run — see the header.
  for (const rel of listFiles(seedFolder)) {
    if (rel === 'manifest.json') continue;

    const src  = path.join(seedFolder, rel);
    const dest = path.join(liveFolder, rel);

    // A file we ship that the install doesn't have yet is purely additive —
    // there is no user content to lose, so it always applies.
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      updated.push(rel);
      continue;
    }

    const liveHash = hashFile(dest);
    const seedHash = hashFile(src);
    if (liveHash && seedHash && liveHash === seedHash) continue;   // already identical

    // Pristine by either route: it still matches what our ledger says we wrote,
    // OR it matches some version we have ever shipped (which is what lets an
    // install predating the ledger update itself without a force flag).
    const pristine = (known[rel] && liveHash === known[rel])
                  || everShipped(kind, name, rel, liveHash);
    if (pristine || isForced) {
      fs.copyFileSync(src, dest);
      updated.push(rel);
    } else {
      // Modified by the user, or installed before the ledger existed and so of
      // unknown provenance. Keep theirs; park ours beside it.
      try {
        fs.copyFileSync(src, `${dest}.new`);
      } catch (e) {
        console.error(`${tag} ${name}: could not write ${rel}.new: ${e.message}`);
      }
      heldBack.push(rel);
    }
  }

  // Re-hash everything we now believe we own, so the next boot can tell our
  // writes from the user's. Held-back files are recorded with the SEED's hash
  // rather than the live one: the ledger means "what we would have written",
  // so if the user later reverts their edit to match ours, the file becomes
  // pristine again and future updates flow.
  const files = { ...known };
  for (const rel of updated) files[rel] = hashFile(path.join(liveFolder, rel));

  if (heldBack.length) {
    console.warn(
      `${tag} ${name}: update to v${seedVersion} PARTIALLY held back — these files differ from what we shipped and were left untouched:\n` +
      heldBack.map(f => `        ${f}  (new version written to ${f}.new)`).join('\n') +
      `\n        Review and replace them by hand, or set SEED_FORCE=${name} to take the shipped versions.`
    );
    // Version deliberately NOT bumped: the folder is not fully updated, so it
    // must keep reporting as old and retry next boot.
    bucket[name] = { version: liveVersion, files };
    return { action: 'conflict', updated, heldBack };
  }

  // Clean run — apply the manifest last, which is what marks the folder current.
  const manifestSrc = path.join(seedFolder, 'manifest.json');
  if (fs.existsSync(manifestSrc)) {
    fs.copyFileSync(manifestSrc, path.join(liveFolder, 'manifest.json'));
    files['manifest.json'] = hashFile(path.join(liveFolder, 'manifest.json'));
  }
  bucket[name] = { version: seedVersion, files };

  if (updated.length) {
    console.log(`${tag} Updated ${name} → v${seedVersion} (${updated.length} file${updated.length === 1 ? '' : 's'}: ${updated.join(', ')})`);
    return { action: 'updated', updated, heldBack };
  }
  return { action: 'current', updated, heldBack };
}

/**
 * Reconcile every folder in `seedDir` into `liveDir`.
 * `kind` is 'packs' | 'bundles' — the ledger bucket and the log prefix.
 */
function syncSeedDir(kind, seedDir, liveDir, dataDir) {
  const summary = { seeded: [], updated: [], conflicts: [] };
  if (!seedDir || !fs.existsSync(seedDir)) return summary;
  fs.mkdirSync(liveDir, { recursive: true });

  const ledger = readLedger(dataDir);
  let dirty = false;

  for (const entry of fs.readdirSync(seedDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;            // packs and bundles are folders
    const name = entry.name;
    try {
      const r = syncFolder({
        kind, name, dataDir, ledger,
        seedFolder: path.join(seedDir, name),
        liveFolder: path.join(liveDir, name),
      });
      if (r.action === 'seeded')   { summary.seeded.push(name);   dirty = true; }
      if (r.action === 'updated')  { summary.updated.push(name);  dirty = true; }
      if (r.action === 'conflict') { summary.conflicts.push(name); dirty = true; }
    } catch (e) {
      // One bad folder must never stop the others from reconciling, and must
      // never stop the server booting.
      console.error(`[${kind}] Failed to sync ${name}: ${e.message}`);
    }
  }

  if (dirty) writeLedger(dataDir, ledger);
  return summary;
}

module.exports = { syncSeedDir, compareVersions, hashFile, listFiles };

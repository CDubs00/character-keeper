#!/usr/bin/env node
/**
 * genSeedHashes.js — build the "everything we have ever shipped" hash list.
 *
 * THE PROBLEM
 *
 * seedSync.js decides whether it may overwrite a shipped file by asking "do the
 * bytes on disk still match what we wrote?" — answered from the ledger it keeps
 * at <DATA_DIR>/seed-ledger.json. That works from the moment the ledger exists.
 * It says nothing about the installs that already exist in the wild, which have
 * no ledger at all. Those all fall into "unknown provenance", so every user's
 * first update after this lands would be held back and every user would have to
 * be told to run SEED_FORCE — a blunt override that CAN destroy a real edit.
 * Handing that to someone who may or may not have customised a pack is not an
 * upgrade path.
 *
 * THE FIX
 *
 * Every version of a pack or bundle we have ever released is sitting in git. So
 * enumerate them: for each file in the seed folders, walk its full history and
 * hash every revision's content. If a user's installed file matches ANY of
 * those hashes, it is provably a pristine copy of some release of ours — old,
 * but untouched — and can be safely updated. If it matches none, they genuinely
 * changed it (or hand-installed something), and the protective path applies.
 *
 * That turns the awkward first update into a silent, correct one for everybody
 * who never edited a pack, while still refusing to clobber anyone who did.
 *
 * OUTPUT
 *
 * `seed-known-hashes.json` at the repo root — `{ "<relative path>": [sha256…] }`
 * — baked into the image and read by seedSync.js. Regenerate whenever shipped
 * pack/bundle content changes:
 *
 *     node backend/genSeedHashes.js      (or: npm run seed:hashes)
 *
 * Stale output is not dangerous, only less helpful: a missing hash means a file
 * is treated as user-modified, i.e. it fails toward doing nothing. Committing
 * the file is what makes the CURRENT release's hashes available to the NEXT
 * one, so run it in the same commit as the content change.
 */

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const REPO = path.join(__dirname, '..');
const OUT  = path.join(REPO, 'seed-known-hashes.json');
const SEED_DIRS = ['packs', 'bundles'];

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: REPO, maxBuffer: 64 * 1024 * 1024, ...opts });
}

function listFiles(dir, prefix) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

const known = {};
let files = 0, revs = 0;

for (const seedDir of SEED_DIRS) {
  const abs = path.join(REPO, seedDir);
  if (!fs.existsSync(abs)) continue;

  for (const rel of listFiles(abs, seedDir)) {
    const hashes = new Set();

    // The working-tree copy — the version this build ships. Recorded so that
    // the NEXT release recognises this one as pristine even if the commit
    // history is later rewritten or shallow-cloned.
    hashes.add(sha256(fs.readFileSync(path.join(REPO, rel))));

    // Every revision of this path across all branches. --follow tracks renames,
    // so a file that moved still contributes its earlier content.
    let commits = [];
    try {
      commits = git(['log', '--all', '--follow', '--format=%H', '--', rel])
        .toString().trim().split('\n').filter(Boolean);
    } catch {
      // Not a git checkout (a release tarball, say) — the working-tree hash
      // above is still recorded, which is the important one.
    }

    for (const c of commits) {
      try {
        // stderr silenced: --follow legitimately yields commits where the path
        // didn't exist yet, and git's "fatal: path … exists on disk" for those
        // is noise, not an error.
        hashes.add(sha256(git(['show', `${c}:${rel}`], { stdio: ['ignore', 'pipe', 'ignore'] })));
        revs++;
      } catch {
        // The path didn't exist at that commit (pre-rename side of --follow).
      }
    }

    known[rel] = [...hashes];
    files++;
  }
}

fs.writeFileSync(OUT, `${JSON.stringify(known, null, 2)}\n`);
console.log(`Wrote ${path.relative(REPO, OUT)}: ${files} files, ${revs} historical revisions.`);

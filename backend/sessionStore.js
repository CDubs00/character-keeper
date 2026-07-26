// sessionStore.js
// A tiny file-backed session store for express-session.
//
// WHY this exists: express-session's DEFAULT store is an in-memory Map. Its own
// docs say it "is purposely not designed for a production environment" because
// it (a) leaks memory (nothing ever prunes expired sessions), (b) loses every
// session on restart/deploy (logs everyone out), and (c) can't be shared across
// worker processes. We can't reach for connect-redis / session-file-store here —
// the project rule is "no new npm dependencies." So we hand-roll a store the
// same way the rest of the app hand-rolls persistence: one JSON file per record
// under /data, with a periodic reaper. This mirrors the "JSON-per-record, no
// database" convention used for characters, worlds, and lore.
//
// A session store just has to implement a few methods against
// express-session's Store base class: get / set / destroy (required) and
// touch (so active sessions have their expiry refreshed cheaply).

const fs   = require('fs');
const path = require('path');
const session = require('express-session');

const DEFAULT_TTL_MS  = 7 * 24 * 60 * 60 * 1000;   // 7 days, matches the cookie maxAge
const DEFAULT_REAP_MS = 60 * 60 * 1000;            // sweep expired files hourly

module.exports = function createFileSessionStore(opts = {}) {
  const dir    = opts.dir;
  const ttlMs  = opts.ttlMs  || DEFAULT_TTL_MS;
  const reapMs = opts.reapMs || DEFAULT_REAP_MS;

  class FileSessionStore extends session.Store {
    constructor() {
      super();
      this.dir = dir;
      if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
      // Reap expired session files periodically so the folder can't grow without
      // bound. unref() so this timer never keeps the process alive on shutdown.
      const t = setInterval(() => this._reap(), reapMs);
      t.unref?.();
    }

    // Session ids are opaque random strings from express-session; encodeURIComponent
    // keeps any surprise character from escaping the directory. Belt-and-suspenders
    // over the fact that the ids are already [A-Za-z0-9_-] shaped.
    _file(sid) { return path.join(this.dir, encodeURIComponent(sid) + '.json'); }

    _expiryFor(sess) {
      const max = sess && sess.cookie && sess.cookie.maxAge;
      return Date.now() + (typeof max === 'number' ? max : ttlMs);
    }

    get(sid, cb) {
      let rec;
      try {
        rec = JSON.parse(fs.readFileSync(this._file(sid), 'utf8'));
      } catch {
        return cb(null, null);   // missing or corrupt → treat as no session
      }
      if (rec.expiresAt && Date.now() > rec.expiresAt) {
        this.destroy(sid, () => {});
        return cb(null, null);
      }
      cb(null, rec.session);
    }

    set(sid, sess, cb) {
      const rec = { session: sess, expiresAt: this._expiryFor(sess) };
      try {
        fs.writeFileSync(this._file(sid), JSON.stringify(rec));
      } catch (e) {
        return cb && cb(e);
      }
      cb && cb(null);
    }

    // touch just refreshes expiry for an active session — reuse set().
    touch(sid, sess, cb) { this.set(sid, sess, cb); }

    destroy(sid, cb) {
      try { fs.unlinkSync(this._file(sid)); } catch { /* already gone */ }
      cb && cb(null);
    }

    _reap() {
      let files;
      try { files = fs.readdirSync(this.dir); } catch { return; }
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const p = path.join(this.dir, f);
        try {
          const rec = JSON.parse(fs.readFileSync(p, 'utf8'));
          if (rec.expiresAt && Date.now() > rec.expiresAt) fs.unlinkSync(p);
        } catch { /* corrupt or racing another writer — skip, next sweep retries */ }
      }
    }
  }

  return new FileSessionStore();
};

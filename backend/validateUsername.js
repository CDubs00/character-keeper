// validateUsername.js
// Single source of truth for username rules. Three paths create users —
// adduser.js (CLI), POST /api/setup, and POST /api/users — and the working
// agreement flags drift between them as a hazard, so the rule lives here once.
//
// WHY this is strict: a username becomes a real directory name. Each user's
// characters are stored at /data/characters/<username>/, and userCharDir() in
// server.js joins the username straight onto a filesystem path. That makes the
// allowed character set a path-traversal guard, not cosmetics — the segments
// '.' and '..' must never reach path.join() whole, or a user's files could
// land outside their own folder.

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;   // '.' added to the existing set

function validateUsername(username) {
  if (typeof username !== 'string' || !username) {
    return 'Username is required';
  }
  if (!USERNAME_RE.test(username)) {
    return 'Username must be 3–32 characters: letters, numbers, and . _ -';
  }
  // Defense in depth: the {3,32} minimum already blocks '.' (1 char) and
  // '..' (2 chars), but reject them explicitly so safety never silently
  // depends on the length rule. If someone later lowers the minimum, this
  // line keeps the directory mapping safe. These two are the only segments
  // path.join treats as "current dir" / "parent dir".
  if (username === '.' || username === '..') {
    return 'Username cannot be "." or ".."';
  }
  return null; // valid
}

module.exports = { validateUsername };
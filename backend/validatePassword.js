// validatePassword.js
// Single source of truth for the password policy. Account passwords are set on
// THREE paths — adduser.js (CLI), POST /api/setup (first-run admin), and
// POST /api/users + PATCH /api/users/:username (admin create / reset). If each
// path spelled out its own rule they would drift, and the weakest one would
// silently become the real floor. So the rule lives here once and every path
// imports it. This is the same "one source of truth" discipline as
// validateUsername.js, and it's the flagged prerequisite before signups open.
//
// WHY length over composition rules: NIST 800-63B guidance is that a length
// floor plus a check against known-weak passwords beats forced upper/lower/digit/
// symbol mixes (which just push users toward "P@ssw0rd1"). So we enforce a floor
// and reject an obvious weak/breached shortlist, and otherwise stay out of the
// way — long passphrases are encouraged.

const MIN_PASSWORD_LENGTH = 10;

// A small, deliberately-basic blocklist of weak/breached passwords that are long
// enough to slip past the length floor. This is NOT a full breach-corpus check
// (that would need a large dataset / an API call) — it's a cheap guard against
// the handful of obvious strings a length rule alone would wave through. Compared
// case-insensitively. Keep it short; the length floor does most of the work.
const WEAK_PASSWORDS = new Set([
  'password',      'password1',   'password12',  'password123', 'password1234',
  'passw0rd123',   'qwertyuiop',  'qwerty12345', '1234567890',  '12345678901',
  '123456789012',  '0123456789',  'abcdefghij',  'iloveyou123', 'letmein123',
  'admin12345',    'welcome123',  'trustno1234', 'changeme123', 'characterkeeper',
]);

// Returns an error string, or null when the password passes. The SAME message
// must come back on every path so a probing client can't tell which path it hit,
// and so the UX is consistent. Callers just surface the string.
function passwordError(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  const lower = password.toLowerCase();
  // Reject the known-weak shortlist, and reject a single character repeated
  // (e.g. "aaaaaaaaaa") which is long but trivially guessable.
  if (WEAK_PASSWORDS.has(lower) || /^(.)\1+$/.test(password)) {
    return 'Password is too common — please choose a less predictable one';
  }
  return null; // valid
}

module.exports = { passwordError, MIN_PASSWORD_LENGTH };

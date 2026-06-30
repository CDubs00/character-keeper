# Security Policy

## Security model

Character Keeper is designed to be **self-hosted for a trusted group** — your
own gaming table — not run as a public, multi-tenant service for anonymous
users. Accounts are created by an administrator; there is no open
self-registration.

A few things follow from that, and operators should understand them before
deploying:

- **You are responsible for securing your deployment.** At minimum: set a
  strong, unique `SESSION_SECRET`, run behind HTTPS (a reverse proxy such as
  Nginx Proxy Manager or Caddy), and keep the host and image updated.
- **Game-system bundles are partially sandboxed.** Bundle HTML goes through an
  attribute allowlist, DOMPurify sanitization, and `javascript:`/`data:` URL
  neutralization before rendering. Theme CSS is scoped and sanitized via CSSOM.
  Off-origin `src`/`srcset` is blocked. That said, bundles are still
  administrator-supplied content dropped onto the server filesystem — review
  anything from an untrusted source before installing it, exactly as you would
  any code you run on your server. There is no in-app upload of bundles by
  regular users.
- **Don't expose it to untrusted users.** The threat model assumes the people
  with accounts are trusted. See the scope section below for what the access
  controls actually protect.

## What's in place

This is a hobbyist project, not a professionally audited product. I'm not a
security professional. What follows is what's been deliberately implemented —
treat it as a starting point, not a guarantee.

**Authentication & sessions**

- Session cookies hardened: `httpOnly`, `sameSite: lax`, `secure` in
  production.
- `SESSION_SECRET` is required in production; the server refuses to start
  without it.
- Login rate-limited to slow brute-force attempts.
- Minimum password policy: 10+ characters, enforced at setup, admin-create,
  and password reset (shared via a single `passwordError()` function so the
  floor can't drift between paths).
- Session invalidation on password or role change: a `tokenVersion` counter
  is stored in each user record and embedded in the session at login. Every
  authenticated request verifies the session version against the on-disk
  record; a mismatch immediately destroys the session, so a password reset or
  role revocation takes effect within the same request cycle rather than at
  cookie expiry.
- Login timing is constant regardless of whether the username exists: a
  pre-computed dummy bcrypt hash is compared when no matching user is found,
  so response time cannot be used to enumerate registered usernames.

**Access control**

- All mutating routes require authentication; cross-user access is blocked at
  the route layer.
- Admin-only routes (`/api/users/*`, `/api/settings`, bundle registry refresh)
  require the admin role.
- GM-only routes require the `gm` or `admin` role.
- Path-traversal guards on every route that takes a character id — crafted ids
  can't escape a user's own folder.
- Portrait upload verified to be an actual image (magic-byte sniff), blocking
  the JSON-leak vector a renamed file would otherwise open.
- Owner-or-admin middleware (`requireCharOwner`) resolves and stashes the
  character before any multer buffering happens, so unauthorized requests never
  reach the disk.
- Field-ownership rules in autosave: a stale open sheet can't clobber campaign
  membership, shares, status, or the attachment list — those fields are read
  from disk and owned by their own dedicated endpoints.

**CSRF**

- Synchronizer token pattern (`csrf-token` header checked against a
  session-stored value). Enabled via `CSRF_ENFORCE=true` (recommended on for
  any networked deployment).

**Content-Security-Policy**

- CSP is report-only by default so violations are visible in the browser
  console without breaking anything. Set `CSP_ENFORCE=true` to enforce.
- `CSP_INLINE_SCRIPT=false` drops `'unsafe-inline'` from `script-src` once the
  frontend is rebuilt with `INLINE_RUNTIME_CHUNK=false` (removes CRA's inlined
  runtime chunk). Verify in report-only first.
- Fonts are self-hosted; Google Fonts is intentionally omitted from the
  allowlist.
- `'wasm-unsafe-eval'` is present for dice-box's WebAssembly physics worker —
  this is the standard allowance for WASM and is narrower than `'unsafe-eval'`.

**Attachments**

The file attachment feature got the most careful treatment because arbitrary
uploads are the highest-risk surface:

- Extension allowlist (not denylist); active-content types like SVG are
  deliberately excluded.
- Magic-byte sniff: a renamed `evil.exe` → `backstory.pdf` is caught before
  it's stored.
- Server-generated filenames: the original filename never touches the
  filesystem.
- Content types pinned, `X-Content-Type-Options: nosniff`, forced download for
  anything the browser might otherwise execute.
- Per-file cap (25 MB), per-character cap (50 files), total storage cap
  (250 MB).

**Bundle rendering hardening**

- Attribute allowlist in `buildProps` — only known-safe HTML attributes pass
  through.
- DOMPurify runs on bundle HTML before injection into the DOM.
- `theme.css` is applied via CSSOM (not a `<style>` innerHTML) and every rule
  is prefixed with `.sheet-root` so bundle CSS can't leak into app chrome.
- Off-origin `src`/`srcset` values are blocked at render time.
- `javascript:` and `data:` href values are neutralized.
- Per-path leaf caps in the schema search resolver.

**General hardening**

- Helmet security headers (X-Powered-By removed, HSTS in production).
- Share and join tokens are cryptographically random (`crypto.randomBytes`),
  not `Math.random()`.
- `trust proxy` is on so secure cookies and real client IPs work behind a
  terminating TLS proxy.
- Global Express error handler prevents unhandled route exceptions from
  leaking stack traces or internal paths to the client — production responses
  return a generic `"Internal server error"` message only.
- JSON request body capped at 1 MB (`express.json({ limit: '1mb' })`),
  an explicit ceiling above any legitimate character payload.

## Supported versions

Security fixes are applied to the latest released version. Please run a
current release before reporting an issue.

| Version | Supported |
| ------- | --------- |
| latest  | yes       |
| older   | no        |

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.** A public
issue discloses the problem to everyone running an instance before a fix
exists.

Instead, report privately:

- Preferred: use GitHub's **"Report a vulnerability"** button under the
  repository's **Security** tab (Private Vulnerability Reporting).

Please include enough detail to reproduce the issue: affected version, steps,
and impact. You'll get an acknowledgement, and once a fix is ready it ships in
a release — with credit if you'd like it.

## Scope

**In scope:** authentication and session handling, access control between
users, share links, file uploads and attachments, and anything that lets one
user read or modify another user's data.

**Out of scope:** issues that require an already-trusted admin account or a
malicious locally-installed bundle (both trusted by design — see the security
model above), and anything dependent on operator misconfiguration (e.g. an
unset `SESSION_SECRET`, or exposing the app without HTTPS).

See `.env.example` for the available security toggles (`CSRF_ENFORCE`,
`CSP_ENFORCE`, `CSP_INLINE_SCRIPT`) and recommended settings.

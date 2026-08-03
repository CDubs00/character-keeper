# Security Policy

## Security model

Keep is designed to be **self-hosted for a trusted group** — your
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
- Server-side sessions are persisted with a file-backed store
  (`backend/sessionStore.js`, one JSON file per session under
  `<DATA_DIR>/sessions/` with a periodic expiry reaper), not the default
  in-memory store. Sessions survive restarts and can't accumulate unbounded in
  memory.
- `SESSION_SECRET` is required in production; the server refuses to start
  without it.
- Absolute session lifetime: a hard 30-day ceiling is stamped at login and
  enforced on every authenticated request, so an active (sliding) session can't
  live indefinitely.
- Brute-force protection on login is two-layered: a per-IP limiter AND a
  per-username limiter, so an attacker with rotating IPs still can't hammer a
  single account. `POST /api/setup` and the account-mutation routes
  (`POST /api/users`, `PATCH /api/users/:username`) are separately rate-limited,
  and a broad global limiter caps overall `/api` request volume.
- Password policy lives in one shared module (`backend/validatePassword.js`,
  `passwordError()`) imported by **every** path that sets a password — the
  `adduser.js` CLI, first-run `POST /api/setup`, admin-create `POST /api/users`,
  and password-reset `PATCH /api/users/:username` — so the floor can't drift
  between them. It enforces a 10+ character minimum plus a basic weak/breached
  blocklist (rejects a shortlist of common long passwords and a single repeated
  character). The identical rejection message is returned on every path.
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
- World access ledger (Keep): a world's `members` map (`{ userId: { tier,
  grantedAt, grantedVia } }`) and a campaign's `worldId` are app-owned. `members`
  is written ONLY by the campaign-join auto-grant hook (upserts the character
  owner at `read`, never downgrades) and the owner-only ledger routes — never a
  generic world PUT. Revoking a member cascades: it clears the campaign fields on
  that one user's characters whose campaign belongs to the world (read from disk,
  per character). This is GM-side plumbing only — a `read` member cannot yet open
  a world (the player read surface is a later step); nothing here exposes
  GM-owned world data to a non-owner.

**CSRF**

- Synchronizer token pattern: an authenticated session mints a token, mirrored
  into a readable `XSRF-TOKEN` cookie; the SPA echoes it as an `X-CSRF-Token`
  header on every mutation (global fetch interceptor in `frontend/src/index.js`),
  checked against the session value on all state-changing methods.
- **Enforced by default** (as of the pre-multiplayer audit). Set
  `CSRF_ENFORCE=false` only to temporarily disable the validator for debugging;
  the token issuer always runs regardless.
- Exempt from validation: safe methods (GET/HEAD/OPTIONS); the auth-bootstrap
  routes `/api/login`, `/api/logout`, `/api/setup` (called before a token
  exists — still covered by `sameSite=lax`); and `/api/share/*` (external,
  unauthenticated share-link holders whose URL token is the credential, so there
  is no ambient-cookie CSRF surface).

**Content-Security-Policy**

- **Enforced by default** (as of the pre-multiplayer audit). Set
  `CSP_ENFORCE=false` to fall back to Report-Only for debugging. The enforced
  policy keeps `'unsafe-inline'` in `script-src`/`style-src` (React inline styles
  and CRA's inlined runtime chunk), so enforcing does not break the app — it just
  stops being advisory.
- Directives are `'self'` plus app-origin assets only — no CDN. `img-src`
  allows `data:`/`blob:`; `font-src` is `'self'` + `data:` (fonts are
  self-hosted; Google Fonts is intentionally omitted); `worker-src` allows
  `blob:` for dice-box's physics worker; `object-src 'none'`,
  `frame-ancestors 'none'`, `base-uri 'self'`.
- `CSP_INLINE_SCRIPT=false` drops `'unsafe-inline'` from `script-src` once the
  frontend is rebuilt with `INLINE_RUNTIME_CHUNK=false` (removes CRA's inlined
  runtime chunk). Verify in report-only first.
- `'wasm-unsafe-eval'` is present for dice-box's WebAssembly physics worker —
  this is the standard allowance for WASM and is narrower than `'unsafe-eval'`.
- `upgrade-insecure-requests` is **deliberately removed** from Helmet's CSP
  defaults (`upgradeInsecureRequests: null`). The app speaks plain HTTP internally
  with TLS terminated at a reverse proxy (and runs over HTTP on localhost in dev);
  the directive would rewrite same-origin subresources to `https://` on a port
  with no TLS and blank the page. Real HTTPS is enforced by the proxy + HSTS.

**Uploads (one shared hardened model across all four surfaces)**

Arbitrary uploads are the highest-risk surface, so **character portraits, lore
assets, world assets, and world backdrops all use the same model**:

- Extension allowlist (not denylist); active-content types like SVG are
  deliberately excluded. Portraits and backdrops are images-only; attachments
  and lore/world assets also allow pdf/text/office docs.
- Magic-byte sniff (`sniffMagic`): a renamed `evil.exe` → `backstory.pdf` (or
  `map.png`) is caught. Attachments and lore/world assets use memory-storage
  multer and sniff the buffer **before** writing; portraits and backdrops use
  disk-storage multer and sniff the leading bytes **immediately after** the
  write, deleting and rejecting a mismatch (`verifyImageFile`). Same
  guarantee — no file whose bytes don't match its extension is ever retained —
  reached one step apart.
- Server-generated filenames: the original filename never touches the
  filesystem (portraits/backdrops use the validated `:id`; attachments and
  lore/world assets use a random server token).
- Content types pinned from the allowlist, `X-Content-Type-Options: nosniff`,
  and forced download for anything the browser might otherwise execute (images/
  pdf/text served inline; office binaries forced to download). Image static
  mounts (`/portraits`, `/world-backdrops`) reject any non-image extension
  before serving and set `nosniff`.
- Caps: per-file 25 MB (portraits 10 MB, backdrops 15 MB), per-character/entry
  50 files, total storage cap 250 MB.
- **Inline images are app-origin only** — an off-origin `![x](https://…)` in a
  lore/landing body never loads (privacy: no third-party request).

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
- `trust proxy` is set to the exact number of reverse-proxy hops in front of the
  app (configurable via `TRUST_PROXY_HOPS`, default 2 for Cloudflare + Nginx
  Proxy Manager) so secure cookies and real client IPs work behind a terminating
  TLS proxy. The value is kept exact — set higher than the real hop count, a
  client could forge `X-Forwarded-For` and spoof its IP to evade rate limits.
- Rate limiting: a broad global limiter on `/api`, a per-IP **and** per-username
  limiter on login, and a tighter limiter on `POST /api/setup` and the
  account-mutation routes.
- Global Express error handler prevents unhandled route exceptions from
  leaking stack traces or internal paths to the client — production responses
  return a generic `"Internal server error"` message only. Multer upload errors
  (oversize / too many files) are translated to a `413`/`400` rather than a
  misleading `500`.
- JSON request body capped at 1 MB (`express.json({ limit: '1mb' })`),
  an explicit ceiling above any legitimate character payload.
- CORS (dev-only, off in production) reflects credentials solely for an explicit
  origin allowlist and permits only the `Content-Type` and `X-CSRF-Token`
  request headers — never a wildcard.

## Route → guard table

Every non-public route requires authentication. `validId` runs on every `:id`
route and **never** on a collection route (a 400 on a list would corrupt client
state). `:key`/`:entryId` params are validated in-handler. Owner guards:
`requireCharOwner` (owner-or-admin) for character mutations;
`requireWorldOwner` for world **mutation/management** (**owner-only — admin does
NOT see other GMs' worlds**); since §4.8, world **content-read** routes use
`requireWorldRead` (owner **or** a ledger member; else 404) and gate every byte on
the viewer's role server-side; `requireGM` for the GM surface; `requireAdmin` for
user/settings admin. Character reads use `canViewChar` (owner, admin, or the GM of
the character's campaign); `shareSafeChar` strips share tokens from any response
that isn't the owner's.

**World player-read model (§4.8) — the server is the only gate.** A world's
`members` ledger (§4.7) keys a per-user tier (`read` < `propose` < `write`). A
lore entry's `visibility` (`hidden`/`read`/`propose`/`write`) is a secrecy
threshold on that same scale. One helper **`canSee(role, visibility)`**
(`backend/loreAccess.js`, unit-tested) decides both the list filter and the
single-entry fetch: the owner sees all (incl. `hidden`); a member sees an entry
iff `visibility !== 'hidden'` **and** their tier rank ≥ the entry's. An entry a
role can't see is **never serialized — not even its name** (so it's absent from
lists, wiki-resolution, and broken-links). Each fog-capable field (schema
`fog: true`) is run through the audited **`stripFog`** before it leaves the server
for a **read/propose** member, so no `||GM-only||` span reaches them; the **owner
and `write`** tier receive raw fog (`seesRawFog`, §4.9) — a trusted editor must see
fog so an edit round-trip can't silently erase it. **Lore-asset downloads re-check
`canSee` against the owning entry** — an over-tier/hidden entry's images 404 for
that member. The client renders only what the server returned and never re-derives
visibility (defense in depth).

**Write + propose tiers (§4.9).** The `write` tier may **create and directly edit**
entries it can see (`requireWorldWrite` = owner or write), but may **not** set
`hidden` or a tier above `write` (`clampVisibilityForRole`), and may **not** delete,
restore history, upload assets, or reach any management route — all stay
`requireWorldOwner`. Every edit still appends the pre-edit **history snapshot
attributed to the editing user**. The `propose` tier submits **suggestions** to a
per-entry `${entryId}.proposals.json` sidecar (excluded from the list scan exactly
like `.history.json`); a proposal **never mutates the entry**. Only the **owner**
lists the world-wide queue and **approves/rejects** — approve applies through the
normal update path (so history records the pre-edit snapshot) and accepts the GM's
**reviewed/edited** values, never a blind copy (the proposer's base was fog-stripped,
so the GM re-injects fog at approve time). A resolved proposal can't re-apply.

| Route | Guards |
| --- | --- |
| `POST /api/login`, `POST /api/logout`, `GET/POST /api/setup` | public (auth bootstrap; rate-limited) |
| `GET /api/me`, `GET /api/settings`, `GET /api/version` | public (non-secret; theme/link-policy flags read while logged out) |
| `PUT /api/me/preferences` | `requireAuth` |
| `GET/POST /api/users`, `PATCH/DELETE /api/users/:username`, `GET /api/admin/logs`, `PUT /api/settings` | `requireAuth` + `requireAdmin` |
| `GET /api/users/assignable`, `GET /api/characters`, `GET /api/search`, `GET /api/campaigns` | `requireAuth` (collection — no `validId`) |
| `GET /api/characters/:id`, `GET /api/characters/:id/export`, `GET …/portrait`, `GET …/attachments`, `GET …/attachments/:key` | `requireAuth` + `validId` + in-handler `canViewChar` |
| `PUT /api/characters/:id` | `requireAuth` + `validId` + in-handler owner check + field-ownership stripping |
| `POST …/transfer`, `POST …/campaign/join`, `POST …/campaign/leave` | `requireAuth` + `validId` + in-handler owner/GM check |
| `POST/DELETE …/portrait`, `DELETE /api/characters/:id`, `…/rolls`, `…/rename`, `…/status`, `…/shares*` | `requireAuth` + `validId` + `requireCharOwner` |
| `POST/DELETE …/attachments*` | `requireAuth` + `validId` + `requireAttachmentsOn` + `requireCharOwner` |
| `POST /api/campaigns`, `PUT/DELETE/status /api/campaigns/:id` | `requireAuth` + `requireGM` (+ `validId` on `:id`) + in-handler owner check; `worldId` validated for same-GM ownership |
| `GET /api/worlds` | `requireAuth` (collection — no `validId`; returns worlds you own **or** are a §4.8 member of, each tagged with `role`; members get the `members` ledger stripped) |
| `POST /api/worlds` | `requireAuth` + `requireGM` (only GMs create worlds) |
| **member-readable** (§4.8): `GET /api/worlds/:id`, `GET …/categories`, `GET …/calendar`, `GET …/lore`, `GET …/lore/:entryId`, `GET …/assets`, `GET …/assets/:key`, `GET …/lore/:entryId/assets/:key` | `requireAuth` + `validId` + **`requireWorldRead`** (owner **or** ledger member → `req.worldRole`; else **404**). Content is filtered/transformed **server-side** by `req.worldRole` — see the `canSee` + fog rules below. `…/calendar` (§4.11) serves the pack's resolved calendar (or null), carrying no player data |
| **write-allowed** (§4.9): `POST /api/worlds/:id/lore` (create), `PUT …/lore/:entryId` (edit) | `requireAuth` + `validId` + **`requireWorldWrite`** (owner or `write`; read/propose → 403). In-handler: edit requires `canSee` (else 404); `clampVisibilityForRole` bars `hidden`/over-tier; pre-edit history snapshot attributed to the editor |
| **propose-allowed** (§4.9): `POST …/lore/:entryId/proposals` (submit), `GET …/lore/:entryId/proposals` (own only; owner sees all) | `requireAuth` + `validId` + `requireWorldRead` + in-handler `canSee`; `read` tier may not submit (403); never mutates the entry |
| **owner-only** (management + destructive): `PUT/DELETE/status /api/worlds/:id`, `PUT …/categories/config`, `PUT …/landing`, `POST/DELETE …/assets*`, `DELETE …/lore/:entryId`, `GET/POST …/lore/:entryId/history`+`/restore`, per-entry asset `POST/GET/DELETE …/assets*`, `GET /api/worlds/:id/proposals` (queue), `POST …/proposals/:proposalId/approve`+`/reject`, `POST/DELETE …/backdrop`, **members**, **campaign-kick** | `requireAuth` + `requireGM` + `validId` + `requireWorldOwner` (+ `:key`/`:entryId`/`:proposalId`/`:userId`/`:campaignId`/`:charId` validated in-handler) |
| `GET /api/systems` (Wave C) | `requireAuth` + `requireGM` (collection — no `validId`). The bundle catalogue filtered to those declaring a system package; names no world and exposes no world data, so GM-level is the right gate — only GMs create or configure worlds |
| **system reference — member-readable** (Wave C): `GET /api/worlds/:id/system`, `GET …/sysref`, `GET …/sysref/:entryId` | `requireAuth` + `validId` + **`requireWorldRead`**. Same gate as lore: the list is `canSee`-filtered and every fog-capable field is `stripFog`-ed server-side for non-GMs; a hidden entry 404s on direct fetch rather than 403-ing. Per-entry `visibility` applies here **exactly as it does to lore** — a GM may write up an unpublished monster before the players meet it |
| **system reference — write-allowed** (Wave C): `POST /api/worlds/:id/sysref`, `PUT …/sysref/:entryId` | `requireAuth` + `validId` + **`requireWorldWrite`** (owner or coGM; read/propose → 403). Edit requires `canSee` (else 404). The `systemId` **stamp**, `worldId`, `createdBy` and timestamps are server-owned and never read from the body; field values pass an **allowlist** built from the stamped type's declared shape, so an undeclared key cannot be stored |
| **system reference — owner-only** (Wave C): `PUT /api/worlds/:id/system` (re-stamp the world), `DELETE …/sysref/:entryId` | `requireAuth` + `requireGM` + `validId` + `requireWorldOwner` + `safeId(:entryId)`. Re-stamping is structural — it re-points every `[[sys:…]]` link in the world — and destructive deletes stay owner-only because this tier has no history sidecar to restore from |
| `GET/PUT /api/share/:token` | public — the URL token is the credential (CSRF-exempt) |
| `GET/POST/DELETE /api/worlds/:id/shares*` (world share links) | `requireAuth` + `requireGM` + `validId` + `requireWorldOwner`. **Owner only** — not a coGM: publishing a world outward is the owner's call. `shares` is app-owned (written only here) and is stripped from every non-owner payload by `memberWorldView`, so no reader can mint another link |
| `GET /api/share/world/:token/…` (external world reader) | public — the token is the credential (CSRF-exempt, GET only). A gate resolves the token, checks expiry, **rejects every non-GET method (403)**, matches the path against a **read allowlist**, then rewrites the URL onto the ordinary world route and pins the request to `req.worldRole = 'read'`. So an anonymous reader travels the identical `canSee` + `stripFog` code path as the most restricted logged-in member — no parallel handler to drift. The allowlist is narrower than `requireWorldRead`: `/`, `/categories`, `/calendar`, `/system`, `/lore`, `/lore/:entryId`, `/lore/:entryId/assets/:key`, `/assets/:key`, `/sysref`, `/sysref/:entryId` — **campaigns (join codes), members, proposals, history and every asset *manifest* are excluded**, because a member is a known person in the ledger and a link holder is anonymous. There is deliberately **no editable world link** (unlike a character share): the create route reads no `permission` at all |

No gaps found in the sweep. Two drift fixes landed in the audit: `POST /api/users`
now enforces the shared password policy (it previously skipped it), and portrait/
backdrop uploads now magic-byte-verify (see Uploads above).

## Session, secret, and environment expectations

- **`SESSION_SECRET`** — required in production; the server refuses to start
  without it. In dev a random per-boot secret is used (logs everyone out on
  restart, but safe).
- **`trust proxy` = `TRUST_PROXY_HOPS`** (default 2) — TLS is terminated by a
  reverse proxy chain (e.g. Cloudflare + Nginx Proxy Manager) that forwards
  `X-Forwarded-*`; trusting exactly the real number of hops lets `secure` cookies
  and real client IPs (for rate-limiting) work. Set it to your actual hop count
  (1 for a single proxy) — too high enables `X-Forwarded-For` spoofing.
- **Session store** — file-backed (`backend/sessionStore.js`), one JSON file per
  session under `<DATA_DIR>/sessions/` with a periodic expiry reaper; survives
  restarts, no unbounded memory growth. No external dependency.
- **Session cookie** — `httpOnly`, `sameSite: lax`, `secure` in production,
  7-day sliding `maxAge` bounded by a **30-day absolute** ceiling
  (`req.session.absoluteExp`, enforced every request). Session invalidation on
  password/role change via a `tokenVersion` counter checked every request.
- **bcrypt cost factor 12** for all password hashing (defined once as
  `BCRYPT_COST` and reused by every path incl. `adduser.js`; login compares
  against a constant-time dummy hash when the user is absent, to defeat username
  enumeration). Pre-existing lower-cost hashes still verify.
- **Rate limiting** — `express-rate-limit`: a broad global limiter on `/api`,
  per-IP + per-username limiters on `/api/login`, and a tighter limiter on
  `/api/setup` and the account-mutation routes (`POST /api/users`,
  `PATCH /api/users/:username`).
- **Enforcement flags** default ON: `CSRF_ENFORCE` and `CSP_ENFORCE` (set either
  to `false` only for debugging). `CSP_INLINE_SCRIPT` and `CORS_ORIGINS` are the
  other tunables — see `.env.example`.
- **Body limits** — JSON capped at 1 MB; upload caps per the Uploads section.

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
`CSP_ENFORCE`, `CSP_INLINE_SCRIPT`, `TRUST_PROXY_HOPS`) and recommended settings.

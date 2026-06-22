# Security Policy

## Security model

Character Keeper is designed to be **self-hosted for a trusted group** — your own gaming table — not run as a public, multi-tenant service for anonymous users. Accounts are created by an administrator; there is no open self-registration.

A few things follow from that, and operators should understand them before
deploying:

- **You are responsible for securing your deployment.** At minimum: set a strong, unique `SESSION_SECRET`, run behind HTTPS (a reverse proxy such as Nginx Proxy Manager or Caddy), and keep the host and image updated.
- **Game-system bundles are trusted content.** Bundles (`manifest.json` /
  `schema.json` / `sheet.html` / `theme.css`) are supplied by the administrator on the server's filesystem and are **not sandboxed**. Only install bundles you trust, exactly as you would only run code you trust. There is no in-app upload of bundles by regular users.
- **Don't expose it to untrusted users.** The threat model assumes the people with accounts are trusted.

See `.env.example` for the available security toggles (`CSRF_ENFORCE`,
`CSP_ENFORCE`, `CSP_INLINE_SCRIPT`) and recommended settings.

## Supported versions

Security fixes are applied to the latest released version. Please run a current release before reporting an issue.

| Version | Supported |
| ------- | --------- |
| latest  | yes       |
| older   | no        |

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.** A public issue discloses the problem to everyone running an instance before a fix exists.

Instead, report privately:

- Preferred: use GitHub's **"Report a vulnerability"** button under the
  repository's **Security** tab (Private Vulnerability Reporting), or

Please include enough detail to reproduce (affected version, steps, impact).
You'll get an acknowledgement, and once a fix is ready it ships in a release —
with credit if you'd like it.

## Scope

In scope: authentication/session handling, access control between users, share links, file uploads, and anything that lets one user reach another user's data.

Out of scope: issues requiring an already-trusted admin account or a malicious locally-installed bundle (both trusted by design — see the security model above), and anything dependent on operator misconfiguration (e.g. an unset `SESSION_SECRET`, or exposing the app without HTTPS).

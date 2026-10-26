# Security

What protects what in the Bridge Runs app, and what is deliberately not protected yet. The app is
one Node process behind one TLS-terminating proxy (Tailscale Funnel), one SQLite file, and a few
hundred known members, so the design favours a small number of mechanisms that are easy to check.

## Sessions

- **Signed, stateless cookie.** `bridge_session` is `email|version` plus an HMAC-SHA256 over it with
  `SESSION_SECRET` (`auth.js`), compared in constant time. It is `HttpOnly`, `SameSite=Lax`, and
  `Secure` unless `COOKIE_INSECURE=1` (which `guard.js` refuses on the production port).
- **Long-lived on purpose, with a kill switch.** Players install the app on a phone and should never
  have to sign in again, so the cookie lasts about ten years and slides forward on every visit. The
  version in the cookie is the account's `session_ver`: "Sign out everywhere" on the profile bumps it,
  and every cookie issued before is refused on its next request.
- **Admin sign-ins are loud.** Every sign-in to an admin account is written to the never-pruned
  key-event audit and pushes a notification to that admin's own devices (`lib/sign-in.js`).
- `SESSION_SECRET` is mandatory: the app refuses to boot without it (the only escape hatch,
  `ALLOW_INSECURE_SESSION=1`, is for throwaway local runs).

## Signing in: magic link and code

There are no passwords. `POST /login` mints one credential pair on a single `login_tokens` row: a
24-byte random link token and a 6-digit code, valid for 15 minutes. Requesting a new pair retires
any older unused one.

- **The link** (`/auth?token=`) opens a confirm page; only the `POST` consumes the token. Mail
  security scanners that pre-fetch links (Outlook SafeLinks and similar) therefore can't burn it.
- **The code** exists because a link opens the system browser, not the installed app. A wrong
  code costs one of five attempts on that row, after which the row is retired; the error text is
  the same for a wrong, expired or missing code, so it never reveals whether an address has a
  pending code or an account.
- Post-login redirects go through `safeNextPath`, a strict local-path allowlist (no `//host`, no
  backslashes, no characters that could break out of the client-side redirect page).
- Mail goes out after the response is sent; dev mode (no SMTP) shows the link on the page instead.

## Rate limits

`lib/rate-limit.js` is an in-memory sliding window (pruned hourly). It covers the abuse that costs
something real: magic-link sends (3 per address per 5 minutes, 20 per IP per 10 minutes, protecting
the Gmail quota and people's inboxes), code attempts (10 per address, 30 per IP per 10 minutes),
applications (8 per IP per 10 minutes), and per-account caps on chat posts, media uploads, reactions,
DMs, friend and party requests, searches, push subscriptions, join requests and announcements.

The per-IP buckets key on the client address Express derives from `X-Forwarded-For`, trusting
exactly one proxy hop (Funnel), so a client can't rotate fake addresses by sending its own header.

Being in memory, the windows reset on a restart. That is accepted: a restart is rare and visible,
and none of the limits guards a secret that a burst could brute-force (codes also have the
five-attempt cap on the row itself).

## CSRF posture

- Every state change is a `POST`; `GET` handlers never write (the zero-write `/poll` contract,
  confirm pages for the magic link, logout and offer claims).
- The session cookie is `SameSite=Lax`, so a cross-site `POST` arrives without it.
- `Content-Security-Policy: form-action 'self'` stops an injected form from posting anywhere else, and
  `frame-ancestors 'none'` plus `X-Frame-Options: DENY` stop clickjacking.
- There are no CSRF tokens. With `SameSite=Lax` cookies and no state-changing `GET`, a token would
  defend against the same thing twice. See Known gaps for the Fetch Metadata check that is planned
  as a second layer.

## Security headers

Set on every response by `mountHttpBasics` (`lib/http.js`): `Content-Security-Policy: frame-ancestors
'none'; base-uri 'self'; form-action 'self'; object-src 'none'`, `X-Frame-Options: DENY`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, a
`Permissions-Policy` that allows only the microphone (voice notes), and HSTS on HTTPS. `X-Powered-By`
is off. The policy has no `script-src` yet; see Known gaps.

## The isolation guard

Every default in the app points at production (the live database, backups, key, uploads and port),
so a test or demo instance is only safe if it is told otherwise. `guard.js` makes that a startup
contract instead of a habit: with `HARNESS=1` or `DEMO_MODE=1` the app refuses to start unless every
path is set and outside the app directory, the port isn't 3000, Planning Center points at a
non-production base, SMTP is loopback, and the database carries no push subscriptions, Planning
Center settings or queued outbound writes. On the production port it refuses every test seam.
Details: [TESTING.md](TESTING.md) and [DEMO.md](DEMO.md).

## Data at rest

- **Direct messages** are encrypted (AES-256-GCM, `enc1:`), so a leaked database file or backup
  doesn't spill private conversations. This is at-rest privacy, not end-to-end: the server can derive
  the key, so there is deliberately no admin surface that reads DMs.
- **Secrets in `app_settings`** (the Planning Center PAT secret, OAuth client secret, access and
  refresh tokens and webhook secret, and the VAPID private key) are sealed the same way, with their
  own derived key, and are reachable only through `getSecret` / `setSecret` in `lib/settings.js`:
  `getSetting` / `setSetting` throw on those keys. A plaintext value from before this existed is
  rewritten sealed the first time it is read.
- Both keys come from `SESSION_SECRET` through HKDF (`lib/at-rest-crypto.js`, one salt per use), so
  there is no extra secret to manage and no key inside the database. **Rotating `SESSION_SECRET`**
  signs everyone out, makes existing DMs unreadable (they render empty), and invalidates the stored
  secrets: each one is then treated as unset (logged once by name), so Planning Center must be
  reconnected and a fresh VAPID keypair is generated, which means every device re-enables
  notifications.

## Backups and exports

- **Snapshots** are taken at boot and daily with `VACUUM INTO`, then encrypted (AES-256-GCM in a
  `BRENC1` container) under a key kept in its own file (`backup.key`, never beside the snapshots) and
  optionally mirrored to an off-site folder. The plaintext temp file is removed in the same step.
- **The admin download** (`/admin/export/db`) is the same encrypted container, named
  `bridge-backup-<date>.db.enc`; every download is audited.
- **Restore** with `node scripts/restore-backup.mjs <file> <out.db> [backup.key]`. GCM authenticates
  the whole file, so a truncated or tampered snapshot, or the wrong key, fails instead of restoring
  corrupt data; a successful restore is integrity-checked (`test/backup.test.mjs`).

## Capability URLs

Some links work without a session because whoever holds the link is the intended reader:

| URL | Holder | Strength and lifetime |
|---|---|---|
| `/auth?token=` | the inbox it was sent to | 24 random bytes, single use, 15 minutes |
| `/checkin/claim/:token` | the waitlister offered a spot | 24 random bytes, single use, the offer window |
| `/invite/:token` | the person an admin invited | 18 random bytes, single use |
| `/kiosk/:pid?k=` | the door screen | 12 random bytes, read-only page, revoked by regenerating |
| `/avatars/<id>-<hex>.jpg` | anyone shown the photo | 16 random bytes in every new name |

`/avatars` stays public because the token-authenticated kiosk renders the roster's photos without a
cookie. The trade-off: an avatar URL that leaks (a screenshot of devtools, a forwarded page source)
shows that one photo to whoever has it, until the person changes their photo, which deletes the old
file. Names are server-chosen with 128 random bits, so they can't be guessed or enumerated. Chat
photos, voice notes and videos (`/chat-media`) are **not** capability URLs: they require a signed-in
account.

## Concurrency rule

Every database call is synchronous, so a read-then-write with no `await` between cannot interleave
with another request. The rule, kept since the module split: **never `await` between a read and the
write that depends on it** (see [ARCHITECTURE.md](ARCHITECTURE.md#data)). It is what keeps two people
from taking the last seat.

## Accepted, documented choices

- **Inline `db.prepare` in route handlers.** There is no repository layer; SQL sits next to the code
  that needs it, always parameterised (`?` placeholders). Hot statements are hoisted.
- **Ticket codes in comments** (`P3-5`, `F4`, `S1`) point at the review or plan item that motivated a
  change. They are history for the maintainer, not instructions.
- **`process.on('uncaughtException')` logs and keeps serving.** Background work (push fan-out, mail,
  timers) runs in callbacks Express can't catch; for a single-process club app, staying up for the
  rest of the run night beats crashing mid-check-in. Route errors are answered by the terminal error
  handler.

## Known gaps

- **No `script-src` in the Content-Security-Policy yet.** The views carry 47 inline `<script>` blocks
  and 80 inline event handlers (`onclick=`, `onsubmit="return confirm(...)"`), so a strict policy
  would break the app, and `'unsafe-inline'` would be a policy in name only. The plan:
  1. Replace the inline handlers with `data-` attributes (`data-confirm="..."`, `data-action=...`)
     handled by delegated listeners in `APP_JS` (`/app.js`, already same-origin and cached).
  2. Move the page-specific inline scripts into `APP_JS` modules keyed by a `data-page` attribute, or
     keep the few that must stay inline and stamp them with a nonce.
  3. Generate a per-response nonce in `mountHttpBasics` (`res.locals.cspNonce`), thread it through
     `HEAD()` to every remaining `<script>`, and send `script-src 'self' 'nonce-…'; object-src 'none';
     base-uri 'self'` (dropping `'unsafe-inline'` entirely). The golden master makes this safe to do
     page by page: the nonce is the only expected diff.
  4. Then decide on `style-src`: the views use 623 `style=` attributes, so styles stay
     `'unsafe-inline'` until they move to classes, which is a far smaller risk than script.
- **No Fetch Metadata check yet.** A middleware that refuses any non-`GET` request whose
  `Sec-Fetch-Site` is `cross-site` was planned as defence in depth behind `SameSite=Lax`. It is not
  shipped.

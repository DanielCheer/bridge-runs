# Testing

## The isolation contract (`guard.js`)

Tests boot **the real application** (`node server.js`) as a child process, each against its own
throwaway database and directories. Isolation comes entirely from environment variables, and
**every default in the app points at production**:

| Unset variable | What it falls back to |
|---|---|
| `DB_PATH` | the live `bridge.db` |
| `BACKUP_DIR` | the live `backups/` (whose prune deletes real snapshots) |
| `CHAT_MEDIA_DIR` / `AVATARS_DIR` | live uploads / profile photos |
| `BANNER_DIR` | live `public/` (the images the real site serves) |
| `PORT` | 3000, the published port |
| `PCO_API_BASE` | the real Planning Center API |
| SMTP / `PUBLIC_URL` / secrets | the real `.env` |

A separate port plus a copied file is not isolation. Two things escape a copy of a real database:

1. **Credentials stored in the database, not the environment.** Planning Center tokens live in
   `app_settings` because an admin pastes them at runtime. Web Push subscriptions and the VAPID
   keypair are the same: real device endpoints, inside the copy.
2. **The app doesn't know it's a test.** A test instance runs the real scheduler (the boot-time
   delta poll, the 60-second tick, the weekly rollover) and will happily sync, send offers and
   push notifications, because that is its job.

This was learned the hard way: an early test run sent an admin alert to a real phone through push
subscriptions carried in a copied database. So isolation is not "each runner remembered"; it is a
startup contract, enforced by `guard.js`, which `db.js` imports as its **first statement** so it
runs before the database file is opened and no entry point can skip it.

**With `HARNESS=1` the app refuses to start unless:**

- `DB_PATH`, `BACKUP_DIR`, `CHAT_MEDIA_DIR`, `AVATARS_DIR`, `BANNER_DIR` are all set **and resolve
  outside the app directory**;
- `PORT` is set and is **not 3000**;
- `PCO_API_BASE` is set and is **not** `*.planningcenteronline.com`;
- `SMTP_HOST` is unset or loopback;

and, once the database is open, unless the fixture is clean: no `push_subscriptions`, no `pco_*`
settings, no queued `pco_outbox` writes. It names the offending variable and exits with code 90.

**On the production side** (no `HARNESS`, port 3000) it refuses `HARNESS`, `ENABLE_TEST_TICK`,
`TEST_NOW`, `FORCE_HELD_RELEASED` and `COOKIE_INSECURE`, so a test-shaped instance can never own the
public port.

## Test-only seams

These exist only for test instances, and the guard refuses them on the production port:

- `TEST_NOW` pins the app's scheduling clock (`schedNow()`).
- `ENABLE_TEST_TICK=1` mounts `POST /admin/test/tick`, which runs every program's scheduler tick,
  scheduled announcements and the Planning Center outbox synchronously, so a test can assert right
  after.
- `COOKIE_INSECURE=1` lets the session cookie travel over plain `http://localhost`.
- `FORCE_HELD_RELEASED` forces the held-spot release path.

**Time is driven by the tick, never by real-clock timers.** `TEST_NOW` doesn't affect
`setTimeout`, so the precise-fire announcement timer refuses to arm when `TEST_NOW` is set (its
delay would come from the real clock while its due-check reads the test clock). The rule for any
future timer: if it computes a delay from `Date.now()` but acts on `schedNow()` state, it must
no-op under `TEST_NOW`.

## Before shipping a feature that reaches outward

Push, email, an outbound webhook, a third-party API: ask what happens when a test exercises its
failure path. Sever that channel in the fixture first, and if it needs credentials, make sure the
guard knows about the variable that redirects it.

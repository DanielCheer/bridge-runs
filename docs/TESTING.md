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

## Running the tests

```bash
npm test          # node --test "test/*.test.mjs"
npm run lint      # eslint (no-undef is the safety net: there is no build step)
```

Each `test/*.test.mjs` file is one suite. It boots its own instance of the app with
`startApp()` from `test/helpers/app.mjs`, which:

1. makes a temp directory under the OS temp folder;
2. builds a fresh database there with `scripts/seed-fixture.mjs` (the app's own schema, created by
   importing `db.js`, then the synthetic world from `fixtures/world.mjs`);
3. optionally runs the suite's own `seed(db)` for the rows that suite is about;
4. picks a free port and spawns `node server.js` with the isolation environment above (plus
   `BACKUP_KEY_FILE` in the temp directory and `ENABLE_TEST_TICK=1`);
5. waits for `/healthz`, and returns `{ baseURL, get, post, tick, cookieFor, db, stop }`.

Because every suite has its own directory and port, `node --test` runs the files in parallel.
Requests are real HTTP against the real server; assertions read responses and, where the point is
what got stored, the suite's database directly.

### The synthetic world

`fixtures/world.mjs` is fictional and deterministic for a given day. Everyone is `@test.local` with
phone `000-000-0000`:

| Persona | Who |
|---|---|
| `admin@test.local` | the organizer (`ADMIN_EMAILS`) |
| `team@test.local` | the org team (auto-renews, runs the teams board) |
| `core@test.local` | a core regular (early access) |
| `council@test.local` | a council voter |
| `player01..12@test.local` | approved players; `player07` is a minor (DOB 2010-03-15) |
| `pending@` / `rejected@` / `suspended@test.local` | one of each account state |

Programs 1 (basketball, Wednesdays), 2 (pickleball, Tuesdays) and 3 (volleyball, Fridays) are
published, each with a season opener five weeks back and attendance, run summaries, game results,
a ladder, chat (every message type), a DM thread, announcements, friendships and a party. The
current night of every program is left empty; a suite sets up the night it is testing, using
`runDateFor(programId, today)` for the date the app will render.

### The suites

| File | What it covers |
|---|---|
| `session` | session cookies and revocation ("sign out everywhere"), security headers, `/healthz`, the permanent audit record |
| `guard` | the isolation contract above: every missing or unsafe variable refused and named, a dirty fixture refused |
| `crawl-smoke` | 37 pages x 11 kinds of viewer, no server errors |
| `demo-program` | the demo run: seeded floor, the real offer-and-claim cycle, party-aware teams, every chat message type, reset |
| `program` | creating a program in the app: validation, live routes, publish, join modes, host role, kiosk tokens, scheduled announcements |
| `chat` | posting, reacting, pinning and deleting in program rooms; the membership gate |
| `confirm`, `door` | the run-day confirm ping and cutoff sweep under a pinned clock, and door mode switching them off |
| `penalty` | the auto-renew no-show penalty: strikes, pause, exemptions, lift, operator clear |
| `hub`, `party`, `dm`, `dob` | status badges and guest priority; persistent parties; DM encryption and mutual follows; the under-18 rule |
| `metrics` | run summaries, event capture and the analytics surfaces |
| `youth` | per-program waivers, guardian consent, the council role |
| `games`, `ladder` | basketball game results and the leaderboard; the pickleball doubles ladder |
| `pco` | the Planning Center sync against a local mock of its API |
| `backup` | encrypted snapshots and the restore path, including tamper and wrong-key refusal |

One check is marked `todo` rather than failing the run: on a fresh database the guardian's waiver
form errors after saving, because `db.js` doesn't create the `applicants.guardian_*` columns it
writes (see `test/youth.test.mjs`). It turns green once the schema gains those columns.

The private golden master (byte-comparing 224 page snapshots across a change, on a copy of real
data) and the browser-driven suites stay outside the repository, because they need real data.

### Writing a suite

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers/app.mjs';

let app;
before(async () => { app = await startApp({ seed: (db) => { /* rows this suite needs */ } }); });
after(async () => { await app?.stop(); });

test('a member sees the runs hub', async () => {
  const r = await app.get('/runs', { as: 'player01@test.local' });
  assert.equal(r.status, 200);
});
```

Tests inside one file run in order and share the instance, so a later test may build on an
earlier one's writes; keep that explicit in the test names.
